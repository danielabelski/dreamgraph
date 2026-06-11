import type { IncomingMessage } from "node:http";
import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import type { BudgetCoordinator } from "@dreamgraph/token-economy/budget-coordinator";
import { compressToolResult, estimateTokensFromString } from "@dreamgraph/token-economy";
import type {
  ArchitectLlmConfig,
  LlmMessage,
  LlmProvider,
  LlmToolCall,
  LlmToolContentBlock,
  LlmToolDefinition,
  LlmToolLoopMessage,
  LlmToolLoopResponse,
} from "../cognitive/llm.js";
import { completeWithNativeTools as completeLlmWithNativeTools } from "../cognitive/llm.js";
import { mcpCallTool, mcpListTools, type McpCallResult } from "../cli/utils/mcp-call.js";
import { logger } from "../utils/logger.js";
import { getArchitectProjectRoot } from "./plan-registry.js";
import {
  ARCHITECT_CONTINUATION_FENCE,
  ARCHITECT_CONTINUATION_SCHEMA,
  type ArchitectContinuationEnvelope,
  type ArchitectContinuationToolManifest,
} from "./continuation.js";
import {
  isRequiredArchitectToolSatisfied,
  selectArchitectToolNames,
} from "./tool-selection.js";

export interface ArchitectToolTraceEntry {
  iteration: number;
  tool: string;
  args_summary: string;
  status: "pending" | "running" | "completed" | "failed";
  duration_ms: number;
  result_preview: string;
  trace_id?: string;
  budget?: {
    context_pressure: string;
    compression_mode: string;
    original_chars: number;
    final_chars: number;
    final_tokens: number;
  };
}

export interface ArchitectToolLoopRoute {
  enabled: boolean;
  provider: string;
  mcp_port: number | null;
  available_tool_count: number;
  advertised_tool_count: number;
  advertised_tools: string[];
  required_tools: string[];
  unavailable_required_tools: string[];
  tool_selection_groups: string[];
  tool_selection_rationale: string;
  iterations: number;
  stop_reason: string;
  fallback_reason: string | null;
}

export interface ArchitectToolLoopProvenance {
  authority: "dreamgraph_mcp" | "llm_only";
  route: "native_api_tool_loop" | "plain_completion";
  provider: string;
  model: string;
  tool_calls: Array<{
    iteration: number;
    tool: string;
    status: ArchitectToolTraceEntry["status"];
    duration_ms: number;
  }>;
}

export interface ArchitectToolLoopResult {
  content: string;
  model: string;
  route: ArchitectToolLoopRoute;
  provenance: ArchitectToolLoopProvenance;
  tool_trace: ArchitectToolTraceEntry[];
}

type ArchitectToolDefinition = LlmToolDefinition;
type ToolCall = LlmToolCall;
type NeutralContentBlock = LlmToolContentBlock;
type NeutralMessage = LlmToolLoopMessage;
type ToolLoopResponse = LlmToolLoopResponse;

const MAX_ARCHITECT_TOOLS = 64;
const MAX_ARCHITECT_TOOL_ITERATIONS = 8;
const ARCHITECT_TOOL_TIMEOUT_MS = 300_000;
const PROVIDER_TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NATIVE_RUN_COMMAND_DEFAULT_TIMEOUT_MS = 60_000;
const NATIVE_RUN_COMMAND_MAX_TIMEOUT_MS = 300_000;
const NATIVE_RUN_COMMAND_OUTPUT_LIMIT = 64 * 1024;
const NATIVE_RUN_COMMAND_TOOL: ArchitectToolDefinition = Object.freeze({
  name: "run_command",
  description:
    "[DreamGraph native support tool] Execute a shell command inside the workspace for build/test/verification tasks. " +
    "Use this instead of provider-inline shell tools; cwd is constrained to the workspace root.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute, for example npm run build." },
      cwd: { type: "string", description: "Working directory, relative to the workspace root. Defaults to the workspace root." },
      timeoutMs: { type: "number", description: "Timeout in milliseconds. Defaults to 60000, capped at 300000." },
    },
    required: ["command"],
  },
});

export async function runArchitectNativeToolLoop(input: {
  req: IncomingMessage;
  config: ArchitectLlmConfig;
  provider: LlmProvider;
  messages: LlmMessage[];
  userMessage: string;
  toolManifest?: ArchitectContinuationToolManifest | null;
  budgetCoordinator?: BudgetCoordinator | null;
  onToolTrace?: (entry: ArchitectToolTraceEntry) => void;
}): Promise<ArchitectToolLoopResult> {
  const mcpPort = architectMcpPort(input.req);
  const trace: ArchitectToolTraceEntry[] = [];
  let availableTools: ArchitectToolDefinition[] = [];
  let fallbackReason: string | null = null;

  if (mcpPort == null) {
    fallbackReason = "architect_mcp_port_unavailable";
  } else {
    try {
      availableTools = await mcpListTools(mcpPort);
    } catch (error) {
      fallbackReason = `architect_mcp_tool_list_failed: ${(error as Error).message.slice(0, 240)}`;
    }
  }
  availableTools = ensureArchitectNativeSupportTools(availableTools);

  const toolSelection = selectArchitectTools(availableTools, { message: input.userMessage, manifest: input.toolManifest });
  const advertisedTools = toolSelection.tools;
  const supportsTools = supportsNativeToolLoop(input.config.provider);
  if (!supportsTools && fallbackReason == null) {
    fallbackReason = `architect_tool_loop_provider_unsupported: ${input.config.provider}`;
  }

  if (!supportsTools || advertisedTools.length === 0) {
    const completion = await input.provider.complete(input.messages, {
      model: input.config.model,
      temperature: input.config.temperature,
      maxTokens: input.config.maxTokens,
      textVerbosity: input.config.textVerbosity,
    });
    return {
      content: completion.text.trim(),
      model: completion.model || input.config.model,
      route: {
        enabled: false,
        provider: input.config.provider,
        mcp_port: mcpPort,
        available_tool_count: availableTools.length,
        advertised_tool_count: advertisedTools.length,
        advertised_tools: advertisedTools.map((tool) => tool.name),
        required_tools: toolSelection.required_tools,
        unavailable_required_tools: toolSelection.unavailable_required_tools,
        tool_selection_groups: toolSelection.groups,
        tool_selection_rationale: toolSelection.rationale,
        iterations: 1,
        stop_reason: completion.stopReason ?? "stop",
        fallback_reason: fallbackReason ?? (advertisedTools.length === 0 ? "architect_no_mcp_tools_advertised" : null),
      },
      provenance: {
        authority: "llm_only",
        route: "plain_completion",
        provider: input.config.provider,
        model: completion.model || input.config.model,
        tool_calls: [],
      },
      tool_trace: trace,
    };
  }

  const rawMessages = withContextPressureSignal(input.messages.map((message) => ({
    role: message.role,
    content: message.content,
  })), input.budgetCoordinator);
  let finalText = "";
  let completionModel = input.config.model;
  let stopReason = "max_tool_iterations";
  let iterations = 0;

  for (let iteration = 1; iteration <= MAX_ARCHITECT_TOOL_ITERATIONS; iteration += 1) {
    iterations = iteration;
    const response = await completeWithNativeTools(input.config, rawMessages, advertisedTools);
    completionModel = response.model || completionModel;
    if (response.text) {
      finalText = joinAssistantText(finalText, response.text);
    }

    if (response.toolCalls.length === 0) {
      const missingRequiredTools = missingRequiredArchitectToolCalls(toolSelection, trace);
      if (missingRequiredTools.length > 0 && iteration < MAX_ARCHITECT_TOOL_ITERATIONS) {
        if (response.text?.trim()) {
          rawMessages.push({ role: "assistant", content: response.text.trim() });
        }
        rawMessages.push({ role: "user", content: buildRequiredToolCorrectionPrompt(missingRequiredTools, toolSelection, trace) });
        finalText = "";
        stopReason = `required_tools_missing:${missingRequiredTools.join(",")}`;
        fallbackReason = fallbackReason ?? "required_tools_missing_before_final";
        continue;
      }
      stopReason = response.stopReason || "end_turn";
      break;
    }

    const assistantBlocks: NeutralContentBlock[] = [];
    if (response.text) {
      assistantBlocks.push({ type: "text", text: response.text });
    }
    for (const call of response.toolCalls) {
      assistantBlocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
    }
    rawMessages.push({ role: "assistant", content: assistantBlocks });

    const toolResultBlocks: NeutralContentBlock[] = [];
    for (const call of response.toolCalls) {
      const startedAt = Date.now();
      const argsSummary = summarizeArgs(call.input);
      const traceId = `dreamgraph:${call.name}:${startedAt}`;
      input.onToolTrace?.({
        iteration,
        tool: call.name,
        args_summary: argsSummary,
        status: "running",
        duration_ms: 0,
        result_preview: "",
        trace_id: traceId,
      });
      let status: ArchitectToolTraceEntry["status"] = "completed";
      let resultText = "";
      try {
        if (call.name === NATIVE_RUN_COMMAND_TOOL.name) {
          const result = await runArchitectNativeCommand(call.input ?? {});
          resultText = stringifyMcpResult(result);
          if (result.isError) {
            status = "failed";
          }
        } else if (mcpPort == null) {
          throw new Error("Architect MCP port unavailable");
        } else {
          logger.info(`Architect native tool loop: calling ${call.name}`);
          const result = await mcpCallTool(mcpPort, call.name, call.input ?? {}, ARCHITECT_TOOL_TIMEOUT_MS);
          resultText = stringifyMcpResult(result);
          if (result.isError) {
            status = "failed";
          }
        }
      } catch (error) {
        status = "failed";
        resultText = error instanceof Error ? error.message : String(error);
      }

      const compressed = input.budgetCoordinator
        ? compressToolResult(resultText, input.budgetCoordinator, call.name)
        : { content: resultText, originalChars: resultText.length, finalChars: resultText.length, mode: "verbatim" };
      const finalTokens = estimateTokensFromString(compressed.content);
      input.budgetCoordinator?.recordComponentActual(`tool:${call.name}`, finalTokens);
      const entry: ArchitectToolTraceEntry = {
        iteration,
        tool: call.name,
        args_summary: argsSummary,
        status,
        duration_ms: Date.now() - startedAt,
        result_preview: createArchitectToolResultPreview(resultText),
        trace_id: traceId,
        ...(input.budgetCoordinator
          ? {
              budget: {
                context_pressure: input.budgetCoordinator.getContextPressureLabel(),
                compression_mode: compressed.mode,
                original_chars: compressed.originalChars,
                final_chars: compressed.finalChars,
                final_tokens: finalTokens,
              },
            }
          : {}),
      };
      trace.push(entry);
      input.onToolTrace?.(entry);
      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: compressed.content,
        ...(status === "failed" ? { is_error: true } : {}),
      });
    }
    rawMessages.push({ role: "user", content: toolResultBlocks });
  }

  const finalMissingRequiredTools = missingRequiredArchitectToolCalls(toolSelection, trace);
  if (finalMissingRequiredTools.length > 0) {
    fallbackReason = fallbackReason ?? `required_tools_not_called:${finalMissingRequiredTools.join(",")}`;
    stopReason = `required_tools_not_called:${finalMissingRequiredTools.join(",")}`;
    finalText = synthesizeArchitectRequiredToolRecoveryText({
      assistantText: finalText,
      missingRequiredTools: finalMissingRequiredTools,
      selection: toolSelection,
      trace,
      stopReason,
    });
  }

  if (trace.length > 0 && !hasArchitectContinuationEnvelopeText(finalText)) {
    if (finalText.trim().length > 0) {
      rawMessages.push({ role: "assistant", content: finalText.trim() });
    }
    rawMessages.push({ role: "user", content: buildArchitectFinalizationPrompt(trace) });
    const finalization = await completeWithNativeTools(input.config, rawMessages, []);
    completionModel = finalization.model || completionModel;
    if (finalization.text) finalText = joinAssistantText(finalText, finalization.text);
    iterations += 1;
    if (finalization.toolCalls.length > 0) {
      fallbackReason = fallbackReason ?? "tool_loop_stopped_without_final_text";
      stopReason = "tool_loop_stopped_without_final_text";
    } else if (finalText.trim().length === 0) {
      fallbackReason = fallbackReason ?? "empty_llm_response_after_tool_use";
      stopReason = "empty_llm_response_after_tool_use";
    } else if (!hasArchitectContinuationEnvelopeText(finalText)) {
      fallbackReason = fallbackReason ?? "missing_continuation_envelope_after_tool_use";
      stopReason = "missing_continuation_envelope_after_tool_use";
    } else {
      stopReason = finalization.stopReason || "finalized_without_tools";
    }
  }

  if (trace.length > 0 && !hasArchitectContinuationEnvelopeText(finalText)) {
    fallbackReason = fallbackReason ?? "missing_continuation_envelope_after_tool_use";
    stopReason = stopReason === "max_tool_iterations" ? "missing_continuation_envelope_after_tool_use" : stopReason;
    finalText = synthesizeArchitectNativeToolLoopRecoveryText({
      assistantText: finalText,
      trace,
      stopReason,
    });
  }

  if (iterations >= MAX_ARCHITECT_TOOL_ITERATIONS && trace.length > 0 && finalText.trim().length === 0) {
    fallbackReason = fallbackReason ?? "max_tool_iterations_without_final_envelope";
    stopReason = "max_tool_iterations_without_final_envelope";
  }

  return {
    content: finalText.trim(),
    model: completionModel,
    route: {
      enabled: true,
      provider: input.config.provider,
      mcp_port: mcpPort,
      available_tool_count: availableTools.length,
      advertised_tool_count: advertisedTools.length,
      advertised_tools: advertisedTools.map((tool) => tool.name),
      required_tools: toolSelection.required_tools,
      unavailable_required_tools: toolSelection.unavailable_required_tools,
      tool_selection_groups: toolSelection.groups,
      tool_selection_rationale: toolSelection.rationale,
      iterations,
      stop_reason: stopReason,
      fallback_reason: fallbackReason,
    },
    provenance: {
      authority: "dreamgraph_mcp",
      route: "native_api_tool_loop",
      provider: input.config.provider,
      model: completionModel,
      tool_calls: trace.map((entry) => ({
        iteration: entry.iteration,
        tool: entry.tool,
        status: entry.status,
        duration_ms: entry.duration_ms,
      })),
    },
    tool_trace: trace,
  };
}

function architectMcpPort(req: IncomingMessage): number | null {
  const host = req.headers.host;
  if (!host) return null;
  try {
    const url = new URL(`http://${host}`);
    const port = Number(url.port);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function supportsNativeToolLoop(provider: string): boolean {
  return provider === "openai" || provider === "lmstudio" || provider === "anthropic";
}

export function ensureArchitectNativeSupportTools(tools: ArchitectToolDefinition[]): ArchitectToolDefinition[] {
  if (tools.some((tool) => tool.name === NATIVE_RUN_COMMAND_TOOL.name)) return tools;
  return [...tools, NATIVE_RUN_COMMAND_TOOL];
}

async function runArchitectNativeCommand(args: Record<string, unknown>): Promise<McpCallResult> {
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!command) {
    return nativeTextResult({ error: "run_command requires a non-empty command" }, true);
  }
  const cwd = resolveNativeCommandCwd(args.cwd);
  const requestedTimeout = typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
    ? args.timeoutMs
    : NATIVE_RUN_COMMAND_DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(NATIVE_RUN_COMMAND_MAX_TIMEOUT_MS, Math.max(1_000, Math.trunc(requestedTimeout)));
  const startedAt = Date.now();
  const result = await spawnNativeShellCommand(command, cwd, timeoutMs);
  return nativeTextResult({
    command,
    cwd,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: Math.max(0, Date.now() - startedAt),
    stdout: limitCommandOutput(result.stdout),
    stderr: limitCommandOutput(result.stderr),
  }, result.timedOut || result.exitCode !== 0);
}

function resolveNativeCommandCwd(value: unknown): string {
  const root = resolve(getArchitectProjectRoot());
  const requested = typeof value === "string" && value.trim().length > 0 ? value.trim() : ".";
  const abs = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
  const rel = relative(root, abs);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return abs;
  throw new Error(`run_command cwd must stay inside workspace root ${root}`);
}

function spawnNativeShellCommand(command: string, cwd: string, timeoutMs: number): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}> {
  return new Promise((resolvePromise, reject) => {
    const isWin = process.platform === "win32";
    const child = isWin
      ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${command}"`], {
          cwd,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          windowsVerbatimArguments: true,
        })
      : spawn(process.env.SHELL ?? "/bin/sh", ["-lc", command], {
          cwd,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    timeout.unref?.();
    child.stdout?.on("data", (chunk) => {
      stdout = limitCommandOutput(stdout + String(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      stderr = limitCommandOutput(stderr + String(chunk));
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      resolvePromise({ stdout, stderr, exitCode, signal, timedOut });
    });
  });
}

function limitCommandOutput(value: string): string {
  if (value.length <= NATIVE_RUN_COMMAND_OUTPUT_LIMIT) return value;
  return value.slice(0, NATIVE_RUN_COMMAND_OUTPUT_LIMIT) + "\n[truncated]";
}

function nativeTextResult(payload: unknown, isError = false): McpCallResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  };
}

function buildArchitectFinalizationPrompt(trace: ArchitectToolTraceEntry[]): string {
  const traceLines = trace.slice(0, 16).map(formatArchitectToolTraceForEnvelope);
  return [
    "Finalize the DreamGraph Architect pass now.",
    "Do not call any tools. Do not request more tool calls.",
    "Write a concise user-visible summary, then include a fenced architect_continuation JSON envelope using schema dreamgraph.architect.continuation.v1.",
    `Use exactly this fence header: \`\`\`${ARCHITECT_CONTINUATION_FENCE}`,
    "The envelope must include pass_id, status, summary, work_completed, files_touched, graph_entities_touched, tool_trace_summary, graph_plan_updates, evidence, blockers, uncertainty, stop_reason, and recommended_actions.",
    "If work remains, recommended_actions must contain one safe recommended continue action with a prompt for the next bounded pass and any required_tools/preferred_tools. If no work remains, recommended_actions may be empty.",
    "The envelope must truthfully report the DreamGraph tool work already performed, any uncertainty, and any blockers.",
    traceLines.length > 0 ? "Observed DreamGraph tool trace to report:" : null,
    ...traceLines,
    "If you cannot determine the next action, set recommended_actions to [] instead of omitting the envelope.",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function missingRequiredArchitectToolCalls(
  selection: { required_tools: string[]; unavailable_required_tools: string[] },
  trace: ArchitectToolTraceEntry[],
): string[] {
  const unavailable = new Set(selection.unavailable_required_tools);
  const calledTools = trace
    .filter((entry) => entry.status === "completed" || entry.status === "failed")
    .map((entry) => entry.tool);
  return selection.required_tools
    .filter((tool) => !unavailable.has(tool))
    .filter((tool) => !isRequiredArchitectToolSatisfied(tool, calledTools));
}

function buildRequiredToolCorrectionPrompt(
  missingRequiredTools: readonly string[],
  selection: { required_tools: string[]; groups: string[]; rationale: string },
  trace: ArchitectToolTraceEntry[],
): string {
  const called = uniqueStrings(trace.map((entry) => `${entry.tool}:${entry.status}`)).join(", ") || "none";
  return [
    "The selected DreamGraph Architect pass is not complete yet.",
    `Required governed MCP tool obligation(s) still unsatisfied: ${missingRequiredTools.join(", ")}.`,
    `All required tools for this pass: ${selection.required_tools.join(", ")}.`,
    `Tool groups selected by the host: ${selection.groups.join(", ") || "none"}.`,
    selection.rationale ? `Host tool-selection rationale: ${selection.rationale}.` : null,
    `Tools already attempted: ${called}.`,
    "Continue the same bounded pass now. Use the available DreamGraph MCP tools to satisfy the missing graph grounding, ADR review, source mutation, graph-recording, or verification obligations as applicable, or call the required tool and report its concrete failure. Do not finalize, do not claim the host requested finalization, and do not return an architect_continuation envelope until the required tool obligations are satisfied or attempted.",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function synthesizeArchitectRequiredToolRecoveryText(input: {
  assistantText: string;
  missingRequiredTools: string[];
  selection: { required_tools: string[]; groups: string[]; rationale: string };
  trace: ArchitectToolTraceEntry[];
  stopReason: string;
}): string {
  const assistantText = compactPlainPreview(input.assistantText, 700);
  const envelope: ArchitectContinuationEnvelope = {
    schema: ARCHITECT_CONTINUATION_SCHEMA,
    pass_id: "required-tool-obligations-unsatisfied",
    status: "uncertain",
    summary: "The native API tool loop stopped before satisfying required governed MCP tool obligations.",
    work_completed: uniqueStrings([
      assistantText ? `assistant summary before enforcement: ${assistantText}` : "",
      ...input.trace.slice(0, 12).map(formatArchitectToolTraceForEnvelope),
    ].filter(Boolean)),
    files_touched: uniqueStrings(input.trace.map(extractArchitectToolTraceFile).filter((value): value is string => Boolean(value))),
    graph_entities_touched: [],
    tool_trace_summary: [
      `required tools: ${input.selection.required_tools.join(", ") || "none"}`,
      `missing required tools: ${input.missingRequiredTools.join(", ")}`,
      ...input.trace.slice(0, 16).map(formatArchitectToolTraceForEnvelope),
    ],
    graph_plan_updates: [],
    evidence: uniqueStrings([
      `tool selection groups: ${input.selection.groups.join(", ") || "none"}`,
      input.selection.rationale ? `tool selection rationale: ${input.selection.rationale}` : "",
      `stop reason: ${input.stopReason}`,
    ].filter(Boolean)),
    blockers: input.missingRequiredTools.map((tool) => `required MCP tool obligation not satisfied: ${tool}`),
    uncertainty: 0.65,
    stop_reason: input.stopReason,
    recommended_actions: [{
      id: "retry-required-governed-tools",
      label: "Retry required governed tools",
      rationale: "The selected pass still requires governed mutation or verification tools that were not used before finalization.",
      kind: "continue",
      prompt: [
        "Continue the same selected Architect pass.",
        `Satisfy these missing governed MCP tool obligations before finalizing: ${input.missingRequiredTools.join(", ")}.`,
        "Ground the pass with DreamGraph graph and ADR tools, apply any requested mutation through governed DreamGraph MCP mutation tools, record resulting source/graph/ADR changes through the appropriate graph-write tool, run required verification through run_command when available, and finish with a fenced architect_continuation envelope.",
      ].join("\n"),
      safe: true,
      recommended: true,
      required_tools: input.missingRequiredTools,
      preferred_tools: withoutAlreadyRequired([
        "query_resource",
        "query_architecture_decisions",
        "graph_rag_retrieve",
        "read_source_code",
        "search_source_code",
        "patch_file",
        "run_command",
        "enrich_seed_data",
        "modify_api_surface",
        "solidify_cognitive_insight",
        "record_architecture_decision",
        "get_cognitive_preamble",
        "cognitive_status",
      ], input.missingRequiredTools),
      disabled_reason: null,
    }],
  };
  return [
    assistantText || "Native API tool-loop enforcement detected an incomplete required-tool pass.",
    `\`\`\`${ARCHITECT_CONTINUATION_FENCE}`,
    JSON.stringify(envelope, null, 2),
    "```",
  ].join("\n");
}

function withoutAlreadyRequired(names: readonly string[], required: readonly string[]): string[] {
  const blocked = new Set(required);
  return uniqueStrings(names.filter((name) => !blocked.has(name)));
}

export function synthesizeArchitectNativeToolLoopRecoveryText(input: {
  assistantText: string;
  trace: ArchitectToolTraceEntry[];
  stopReason: string;
}): string {
  const envelope = buildArchitectNativeToolLoopRecoveryEnvelope(input);
  const assistantText = input.assistantText.trim();
  const preface = assistantText
    ? assistantText
    : "DreamGraph tool work completed, but the provider did not return final assistant prose.";
  return [
    preface,
    `\`\`\`${ARCHITECT_CONTINUATION_FENCE}`,
    JSON.stringify(envelope, null, 2),
    "```",
  ].join("\n");
}

function hasArchitectContinuationEnvelopeText(text: string): boolean {
  const value = String(text || "");
  if (/```(?:json\s+)?architect_continuation\s*\n[\s\S]*?```/i.test(value)) return true;
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) return false;
  const candidate = value.slice(start, end + 1);
  return candidate.includes("summary")
    && (candidate.includes("recommended_actions") || candidate.includes("work_completed") || candidate.includes("tool_trace_summary"));
}

function buildArchitectNativeToolLoopRecoveryEnvelope(input: {
  assistantText: string;
  trace: ArchitectToolTraceEntry[];
  stopReason: string;
}): ArchitectContinuationEnvelope {
  const completedCount = input.trace.filter((entry) => entry.status === "completed").length;
  const failedTools = input.trace.filter((entry) => entry.status === "failed");
  const assistantSummary = compactPlainPreview(input.assistantText, 700);
  const filesTouched = uniqueStrings(input.trace.map(extractArchitectToolTraceFile).filter((value): value is string => Boolean(value)));
  const mutationSummaries = input.trace
    .filter((entry) => isArchitectMutationTool(entry.tool))
    .map((entry) => `${entry.tool} -> ${extractArchitectToolTraceFile(entry) || "unknown target"} (${entry.status})`)
    .slice(0, 12);
  const toolTraceSummary = [
    `native tool loop synthesized continuation envelope after missing provider envelope`,
    `tools completed: ${completedCount}`,
    ...input.trace.slice(0, 16).map(formatArchitectToolTraceForEnvelope),
  ];
  const noRemainingWork = assistantIndicatesNoRemainingWork(input.assistantText);
  const recommendedActions = failedTools.length === 0 && !noRemainingWork
    ? [{
        id: "continue-from-recovered-native-tool-loop",
        label: "Continue from recovered state",
        rationale: "The native API tool loop completed governed tool work but the provider omitted the continuation envelope; continue from the recovered tool trace without repeating completed mutations.",
        kind: "continue" as const,
        prompt: buildRecoveredNativeToolLoopPrompt(input.trace, assistantSummary),
        safe: true,
        recommended: true,
        required_tools: [],
        preferred_tools: recoveredNativeToolLoopPreferredTools(input.trace),
        disabled_reason: null,
      }]
    : [];

  return {
    schema: ARCHITECT_CONTINUATION_SCHEMA,
    pass_id: "native-tool-loop-recovered",
    status: failedTools.length > 0 ? "failed" : "completed",
    summary: assistantSummary
      ? `Native tool loop recovered a missing continuation envelope. Assistant summary: ${assistantSummary}`
      : "Native tool loop recovered a missing continuation envelope after governed tool work.",
    work_completed: uniqueStrings([
      assistantSummary ? `assistant summary: ${assistantSummary}` : "",
      ...mutationSummaries,
      mutationSummaries.length === 0 ? `governed tools completed: ${completedCount}/${input.trace.length}` : "",
    ].filter(Boolean)),
    files_touched: filesTouched,
    graph_entities_touched: [],
    tool_trace_summary: toolTraceSummary,
    graph_plan_updates: [],
    evidence: uniqueStrings([
      `route stop reason before synthesis: ${input.stopReason}`,
      ...toolTraceSummary,
      ...filesTouched.map((file) => `file touched: ${file}`),
    ]).slice(0, 24),
    blockers: failedTools.map((entry) => `${entry.tool} failed`).slice(0, 12),
    uncertainty: failedTools.length > 0 ? 1 : 0.45,
    stop_reason: input.stopReason,
    recommended_actions: recommendedActions,
  };
}

function buildRecoveredNativeToolLoopPrompt(trace: ArchitectToolTraceEntry[], assistantSummary: string): string {
  const completed = trace
    .filter((entry) => entry.status === "completed")
    .slice(0, 10)
    .map(formatArchitectToolTraceForEnvelope)
    .join("; ") || "none recorded";
  return [
    "Continue from the recovered native API tool-loop state.",
    assistantSummary ? `Previous assistant summary: ${assistantSummary}` : null,
    `Treat these completed DreamGraph tool calls as already applied: ${completed}.`,
    "Do not repeat completed mutations. Inspect the current plan/project state first, choose only the next incomplete bounded step, verify when appropriate, and finish with a fenced architect_continuation JSON envelope.",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function recoveredNativeToolLoopPreferredTools(trace: ArchitectToolTraceEntry[]): string[] {
  const tools = uniqueStrings([
    "query_resource",
    "read_source_code",
    "search_source_code",
    ...trace.map((entry) => entry.tool),
    trace.some((entry) => isArchitectMutationTool(entry.tool)) ? "run_command" : "",
  ].filter(Boolean));
  return tools.filter((tool) => PROVIDER_TOOL_NAME_RE.test(tool)).slice(0, 12);
}

function assistantIndicatesNoRemainingWork(text: string): boolean {
  const lower = text.toLowerCase();
  return /\ball remaining\b[\s\S]{0,120}\b(completed|done|finished)\b/.test(lower)
    || /\b(no|nothing)\s+(remaining|further|next)\s+(work|steps|actions|slices|tasks)\b/.test(lower)
    || /\b(everything|all work|all tasks)\s+(is\s+)?(done|complete|completed|finished)\b/.test(lower);
}

function isArchitectMutationTool(tool: string): boolean {
  return /^(patch_file|append_to_file|create_file|edit_file|delete_file|rename_file|edit_entity|edit_markdown_section|patch_markdown_chapter)$/.test(tool);
}

function formatArchitectToolTraceForEnvelope(entry: ArchitectToolTraceEntry): string {
  const args = entry.args_summary ? ` ${compactPlainPreview(entry.args_summary, 160)}` : "";
  return `${entry.tool}: ${entry.status}${args}`;
}

function extractArchitectToolTraceFile(entry: ArchitectToolTraceEntry): string | null {
  for (const source of [entry.args_summary, entry.result_preview]) {
    const fromJson = extractFileFromJsonText(source);
    if (fromJson) return fromJson;
    const match = String(source || "").match(/(?:filePath|file_path|path)\s*[:=]\s*["']?([^"',}\s]{1,240})/i);
    if (match?.[1]) return match[1].replace(/\\+/g, "/");
  }
  return null;
}

function extractFileFromJsonText(text: string): string | null {
  const parsed = parseJson(String(text || "").trim());
  if (isRecord(parsed)) {
    const file = parsed.filePath ?? parsed.file_path ?? parsed.path;
    if (typeof file === "string" && looksLikeProjectFilePath(file)) return file;
  }
  const match = String(text || "").match(/"(?:filePath|file_path|path)"\s*:\s*"([^"]{1,240})"/i);
  return match?.[1] && looksLikeProjectFilePath(match[1]) ? match[1].replace(/\\+/g, "/") : null;
}

function looksLikeProjectFilePath(value: string): boolean {
  return /^[A-Za-z0-9._@/\\ -]{1,240}$/.test(value) && /[/.\\]/.test(value);
}

function uniqueStrings(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const text = compactPlainPreview(value, 1_000);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function joinAssistantText(current: string, next: string): string {
  const left = current.trim();
  const right = next.trim();
  if (!left) return right;
  if (!right) return left;
  return `${left}\n\n${right}`;
}

function withContextPressureSignal(messages: NeutralMessage[], coordinator?: BudgetCoordinator | null): NeutralMessage[] {
  if (!coordinator) return messages;
  const signal = `context_pressure: ${coordinator.getContextPressureLabel()}`;
  const firstSystem = messages.findIndex((message) => message.role === "system" && typeof message.content === "string");
  if (firstSystem >= 0) {
    return messages.map((message, index) => index === firstSystem
      ? { ...message, content: `${message.content}\n\n${signal}` }
      : message);
  }
  return [{ role: "system", content: signal }, ...messages];
}

export function selectArchitectTools(
  tools: ArchitectToolDefinition[],
  input: string | { message: string; manifest?: ArchitectContinuationToolManifest | null },
): {
  tools: ArchitectToolDefinition[];
  required_tools: string[];
  unavailable_required_tools: string[];
  groups: string[];
  rationale: string;
  mutating: boolean;
  verifying: boolean;
} {
  const message = typeof input === "string" ? input : input.message;
  const manifest = typeof input === "string" ? null : input.manifest ?? null;
  const safe = tools.filter((tool) => PROVIDER_TOOL_NAME_RE.test(tool.name));
  const byName = new Map(safe.map((tool) => [tool.name, tool]));
  const decision = selectArchitectToolNames({
    prompt: message,
    availableToolNames: safe.map((tool) => tool.name),
    manifest,
    autonomy: true,
    primedTools: [
      ...(manifest?.required_tools ?? []),
      ...(manifest?.preferred_tools ?? []),
    ],
  });
  const selected: ArchitectToolDefinition[] = [];
  for (const name of decision.selected) {
    const tool = byName.get(name);
    if (tool && !selected.some((candidate) => candidate.name === tool.name)) selected.push(tool);
  }

  return {
    tools: selected.slice(0, MAX_ARCHITECT_TOOLS),
    required_tools: decision.required_tools,
    unavailable_required_tools: decision.unavailable_required_tools,
    groups: decision.groups,
    rationale: decision.rationale,
    mutating: decision.mutating,
    verifying: decision.verifying,
  };
}

async function completeWithNativeTools(
  config: ArchitectLlmConfig,
  messages: NeutralMessage[],
  tools: ArchitectToolDefinition[],
): Promise<ToolLoopResponse> {
  return completeLlmWithNativeTools(config, messages, tools);
}

function stringifyMcpResult(result: McpCallResult): string {
  const content = result.content ?? [];
  return content
    .map((item) => item.type === "text" ? item.text : JSON.stringify(item))
    .join("\n");
}

export function createArchitectToolResultPreview(value: string, maxLength = 500): string {
  const normalized = normalizeMcpResultPreview(value);
  const serialized = typeof normalized === "string" ? normalized : JSON.stringify(normalized);
  if (serialized.length <= maxLength) return serialized;
  return JSON.stringify({
    truncated: true,
    originalChars: serialized.length,
    preview: summarizePreviewValue(normalized),
  });
}

function normalizeMcpResultPreview(value: string): unknown {
  const text = String(value ?? "").trim();
  const parsed = parseJson(text);
  if (parsed !== null) {
    return normalizeParsedMcpResult(parsed, text);
  }
  return text;
}

function normalizeParsedMcpResult(value: unknown, fallbackText: string): unknown {
  if (isRecord(value) && Array.isArray(value.content)) {
    const text = value.content
      .filter((item): item is { type: string; text: string } => isRecord(item) && item.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n")
      .trim();
    if (text) {
      const nested = parseJson(text);
      return nested === null ? text : nested;
    }
    return value;
  }
  return value ?? fallbackText;
}

function summarizePreviewValue(value: unknown): unknown {
  if (typeof value === "string") return compactPlainPreview(value, 420);
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      items: value.slice(0, 5).map((item) => summarizePreviewValue(item)),
    };
  }
  if (!isRecord(value)) return value;

  const data = isRecord(value.data) ? value.data : value;
  const preview: Record<string, unknown> = {};
  for (const key of ["success", "error", "message", "current_state", "provider", "model", "route", "total", "matchCount", "exitCode", "timedOut", "durationMs"]) {
    const source = key in value ? value : data;
    const candidate = source[key];
    if (candidate == null) continue;
    if (typeof candidate === "string") preview[key] = compactPlainPreview(candidate, 180);
    else if (typeof candidate !== "object") preview[key] = candidate;
  }
  for (const [key, candidate] of Object.entries(data).slice(0, 12)) {
    if (preview[key] !== undefined) continue;
    if (Array.isArray(candidate)) {
      preview[key] = {
        length: candidate.length,
        items: candidate.slice(0, 5).map((item) => summarizePreviewValue(item)),
      };
    } else if (isRecord(candidate)) {
      preview[key] = { fields: Object.keys(candidate).slice(0, 8) };
    } else if (typeof candidate === "string") {
      preview[key] = compactPlainPreview(candidate, 180);
    } else if (candidate != null) {
      preview[key] = candidate;
    }
  }
  return preview;
}

function compactPlainPreview(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, Math.max(0, maxLength - 3)).trim()}...` : compact;
}

function parseJson(value: string): unknown | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function blocksToText(blocks: NeutralContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<NeutralContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function summarizeArgs(input: Record<string, unknown>): string {
  return compactPreview(JSON.stringify(input ?? {}), 180);
}

function compactPreview(value: string, maxLength = 500): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
