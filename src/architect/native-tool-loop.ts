import type { IncomingMessage } from "node:http";
import type { ArchitectLlmConfig, LlmMessage, LlmProvider } from "../cognitive/llm.js";
import { getModelCapabilities } from "../cognitive/llm.js";
import { mcpCallTool, mcpListTools, type McpCallResult } from "../cli/utils/mcp-call.js";
import { logger } from "../utils/logger.js";

export interface ArchitectToolTraceEntry {
  iteration: number;
  tool: string;
  args_summary: string;
  status: "pending" | "running" | "completed" | "failed";
  duration_ms: number;
  result_preview: string;
  trace_id?: string;
}

export interface ArchitectToolLoopRoute {
  enabled: boolean;
  provider: string;
  mcp_port: number | null;
  available_tool_count: number;
  advertised_tool_count: number;
  advertised_tools: string[];
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

type ArchitectToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

type ToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

type NeutralContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

type NeutralMessage = {
  role: "system" | "user" | "assistant";
  content: string | NeutralContentBlock[];
};

type ToolLoopResponse = {
  text: string;
  model: string;
  stopReason: string;
  toolCalls: ToolCall[];
};

const MAX_ARCHITECT_TOOLS = 64;
const MAX_ARCHITECT_TOOL_ITERATIONS = 8;
const ARCHITECT_TOOL_TIMEOUT_MS = 300_000;
const PROVIDER_TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

const PRIORITY_TOOLS = [
  "cognitive_status",
  "query_resource",
  "query_architecture_decisions",
  "get_dream_insights",
  "get_remediation_plan",
  "get_system_story",
  "get_system_narrative",
  "search_data_model",
  "query_api_surface",
  "read_source_code",
  "search_source_code",
  "list_directory",
  "list_markdown_chapters",
  "read_markdown_chapter",
  "graph_rag_retrieve",
  "shortest_path",
  "git_log",
  "git_blame",
];

export async function runArchitectNativeToolLoop(input: {
  req: IncomingMessage;
  config: ArchitectLlmConfig;
  provider: LlmProvider;
  messages: LlmMessage[];
  userMessage: string;
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

  const advertisedTools = selectArchitectTools(availableTools, input.userMessage);
  const supportsTools = supportsNativeToolLoop(input.config.provider);
  if (!supportsTools && fallbackReason == null) {
    fallbackReason = `architect_tool_loop_provider_unsupported: ${input.config.provider}`;
  }

  if (!supportsTools || advertisedTools.length === 0) {
    const completion = await input.provider.complete(input.messages, {
      model: input.config.model,
      temperature: input.config.temperature,
      maxTokens: input.config.maxTokens,
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

  const rawMessages: NeutralMessage[] = input.messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  let finalText = "";
  let completionModel = input.config.model;
  let stopReason = "max_tool_iterations";
  let iterations = 0;

  for (let iteration = 1; iteration <= MAX_ARCHITECT_TOOL_ITERATIONS; iteration += 1) {
    iterations = iteration;
    const response = await completeWithNativeTools(input.config, rawMessages, advertisedTools);
    completionModel = response.model || completionModel;
    if (response.text) {
      finalText += response.text;
    }

    if (response.toolCalls.length === 0) {
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
        if (mcpPort == null) {
          throw new Error("Architect MCP port unavailable");
        }
        logger.info(`Architect native tool loop: calling ${call.name}`);
        const result = await mcpCallTool(mcpPort, call.name, call.input ?? {}, ARCHITECT_TOOL_TIMEOUT_MS);
        resultText = stringifyMcpResult(result);
        if (result.isError) {
          status = "failed";
        }
      } catch (error) {
        status = "failed";
        resultText = error instanceof Error ? error.message : String(error);
      }

      const entry: ArchitectToolTraceEntry = {
        iteration,
        tool: call.name,
        args_summary: argsSummary,
        status,
        duration_ms: Date.now() - startedAt,
        result_preview: createArchitectToolResultPreview(resultText),
        trace_id: traceId,
      };
      trace.push(entry);
      input.onToolTrace?.(entry);
      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: resultText,
        ...(status === "failed" ? { is_error: true } : {}),
      });
    }
    rawMessages.push({ role: "user", content: toolResultBlocks });
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

function selectArchitectTools(tools: ArchitectToolDefinition[], message: string): ArchitectToolDefinition[] {
  const safe = tools.filter((tool) => PROVIDER_TOOL_NAME_RE.test(tool.name));
  const byName = new Map(safe.map((tool) => [tool.name, tool]));
  const selected: ArchitectToolDefinition[] = [];

  const lower = message.toLowerCase();
  const priority = new Set(PRIORITY_TOOLS);
  if (lower.includes("status") || lower.includes("health") || lower.includes("graph") || lower.includes("adr")) {
    for (const name of PRIORITY_TOOLS) {
      const tool = byName.get(name);
      if (tool) selected.push(tool);
    }
  }

  for (const tool of safe) {
    if (selected.length >= MAX_ARCHITECT_TOOLS) break;
    if (!priority.has(tool.name) && !selected.some((candidate) => candidate.name === tool.name)) {
      selected.push(tool);
    }
  }

  return selected.slice(0, MAX_ARCHITECT_TOOLS);
}

async function completeWithNativeTools(
  config: ArchitectLlmConfig,
  messages: NeutralMessage[],
  tools: ArchitectToolDefinition[],
): Promise<ToolLoopResponse> {
  if (config.provider === "anthropic") {
    return callAnthropicWithTools(config, messages, tools);
  }
  return callOpenAiCompatibleWithTools(config, messages, tools);
}

async function callOpenAiCompatibleWithTools(
  config: ArchitectLlmConfig,
  messages: NeutralMessage[],
  tools: ArchitectToolDefinition[],
): Promise<ToolLoopResponse> {
  const capabilities = getModelCapabilities(config.provider, config.model);
  const useNewTokenParam = /^(o[1-9]|gpt-[4-9]\.[1-9]|gpt-5)/i.test(config.model);
  const body: Record<string, unknown> = {
    model: config.model,
    messages: toOpenAiMessages(messages),
    ...(capabilities.supportsTemperature ? { temperature: config.temperature } : {}),
    ...(useNewTokenParam
      ? { max_completion_tokens: config.maxTokens }
      : { max_tokens: config.maxTokens }),
    tools: tools.map(toOpenAiTool),
    tool_choice: "auto",
  };

  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "unknown");
    throw new Error(`OpenAI-compatible tool call ${res.status}: ${errText}`);
  }

  const data = await res.json() as {
    choices?: Array<{
      message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
      finish_reason?: string;
    }>;
    model?: string;
  };
  const choice = data.choices?.[0];
  const toolCalls = (choice?.message?.tool_calls ?? []).map((toolCall) => ({
    id: toolCall.id,
    name: toolCall.function.name,
    input: parseToolArguments(toolCall.function.arguments),
  }));
  return {
    text: choice?.message?.content ?? "",
    model: data.model ?? config.model,
    stopReason: choice?.finish_reason === "tool_calls" ? "tool_use" : (choice?.finish_reason ?? "stop"),
    toolCalls,
  };
}

async function callAnthropicWithTools(
  config: ArchitectLlmConfig,
  messages: NeutralMessage[],
  tools: ArchitectToolDefinition[],
): Promise<ToolLoopResponse> {
  const systemText = messages
    .filter((message) => message.role === "system")
    .map((message) => typeof message.content === "string" ? message.content : blocksToText(message.content))
    .filter(Boolean)
    .join("\n\n");

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
    messages: messages
      .filter((message) => message.role !== "system")
      .map(toAnthropicMessage),
    tools: tools.map(toAnthropicTool),
  };
  if (systemText) {
    body.system = systemText;
  }

  const res = await fetch(`${config.baseUrl}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "unknown");
    throw new Error(`Anthropic tool call ${res.status}: ${errText}`);
  }

  const data = await res.json() as {
    content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
    model?: string;
    stop_reason?: string;
  };
  const blocks = data.content ?? [];
  return {
    text: blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join(""),
    model: data.model ?? config.model,
    stopReason: data.stop_reason ?? "stop",
    toolCalls: blocks
      .filter((block) => block.type === "tool_use" && block.id && block.name)
      .map((block) => ({
        id: block.id!,
        name: block.name!,
        input: isRecord(block.input) ? block.input : {},
      })),
  };
}

function toOpenAiMessages(messages: NeutralMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      out.push({ role: message.role, content: message.content });
      continue;
    }

    const text = blocksToText(message.content);
    const toolUses = message.content.filter((block): block is Extract<NeutralContentBlock, { type: "tool_use" }> => block.type === "tool_use");
    const toolResults = message.content.filter((block): block is Extract<NeutralContentBlock, { type: "tool_result" }> => block.type === "tool_result");

    if (message.role === "assistant") {
      out.push({
        role: "assistant",
        content: text || null,
        ...(toolUses.length > 0
          ? {
              tool_calls: toolUses.map((block) => ({
                id: block.id,
                type: "function",
                function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
              })),
            }
          : {}),
      });
      continue;
    }

    if (text) {
      out.push({ role: message.role, content: text });
    }
    for (const result of toolResults) {
      out.push({ role: "tool", tool_call_id: result.tool_use_id, content: result.content });
    }
  }
  return out;
}

function toAnthropicMessage(message: NeutralMessage): Record<string, unknown> {
  if (typeof message.content === "string") {
    return { role: message.role, content: message.content };
  }
  return {
    role: message.role,
    content: message.content.map((block) => {
      if (block.type === "text") return { type: "text", text: block.text };
      if (block.type === "tool_use") return { type: "tool_use", id: block.id, name: block.name, input: block.input ?? {} };
      return {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: block.content,
        ...(block.is_error ? { is_error: true } : {}),
      };
    }),
  };
}

function toOpenAiTool(tool: ArchitectToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "DreamGraph MCP tool",
      parameters: normalizeInputSchema(tool.inputSchema),
    },
  };
}

function toAnthropicTool(tool: ArchitectToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description ?? "DreamGraph MCP tool",
    input_schema: normalizeInputSchema(tool.inputSchema),
  };
}

function normalizeInputSchema(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) {
    return { type: "object", properties: {}, additionalProperties: true };
  }
  return {
    type: schema.type === "object" ? "object" : "object",
    properties: isRecord(schema.properties) ? schema.properties : {},
    required: Array.isArray(schema.required) ? schema.required : [],
    ...(schema.additionalProperties !== undefined ? { additionalProperties: schema.additionalProperties } : {}),
  };
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return isRecord(parsed) ? parsed : {};
  } catch {
    return { _raw: raw };
  }
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
