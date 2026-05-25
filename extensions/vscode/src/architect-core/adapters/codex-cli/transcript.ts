// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Codex CLI adapter - pure transcript normalizer.

import {
  asRecord,
  codexAssistantCompletedText,
  codexAssistantDelta,
  codexEventData,
  codexEventType,
  extractCodexJsonEvents,
  isCodexPluginSyncNoise,
  recordNumber,
  recordString,
  summarizeCodexDiagnosticLine,
} from "./event-stream.js";
import type {
  CodexCliTranscript,
  CodexStructuredError,
  CodexToolCallWitness,
  CodexToolCallWitnessStatus,
  CodexTokenUsage,
  CodexUsageLimitInfo,
  ToolCallObservation,
} from "./types.js";

const ANSI_CSI_RE = /\x1B\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC_RE = /\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g;
const STRAY_ESC_RE = /\x1B/g;
const ERROR_LINE_RE = /\b(?:error|errors|failed|failure|fatal|panic|exception)\b/i;
const NOT_LOGGED_IN_RE =
  /\b(?:not logged in|not signed in|login required|authentication required|auth required|please\s+run\s+codex\s+login)\b/i;
const USAGE_LIMIT_RUNTIME_RE =
  /\b(?:you(?:'|’|â€™)ve hit your usage limit|purchase more credits|try again at\s+[^.\n]+|rate[_ -]?limit(?:ed)?|insufficient[_ -]?quota|http\s*429|status\s*429|too many requests)\b/i;
const USAGE_LIMIT_ERROR_CONTEXT_RE =
  /\b(?:turn error|codex(?: cli)? error|error|fatal|quota|limit (?:was )?reached)\b/i;
const USAGE_LIMIT_PHRASE_RE = /\busage limit\b/i;
const MODEL_UNSUPPORTED_RE =
  /\b(?:unsupported[_ -]model|model_not_supported|unsupported_model|model_not_found|invalid[_ -]model)\b/i;
const MODEL_UNSUPPORTED_PHRASE_RE =
  /\b(?:model\b[^.\n]{0,100}\b(?:not supported|not found|does not exist|is unavailable)|(?:unknown|unrecognized)\s+model\s*:)/i;
const POLICY_DENIED_RE =
  /\b(?:blocked by policy|policy denial|policy denied|rejected:\s*blocked by policy|not allowed by policy|read-only sandbox|writing is blocked|rejected by user approval settings|user approval settings)\b/i;
const MCP_FAILED_STATUSES = new Set(["failed", "failure", "error", "cancelled", "canceled"]);
const MCP_TOOL_CALL_DIAGNOSTIC_RE =
  /\bmcp_tool_call\s+(completed|succeeded|failed|failure|error|cancelled|canceled)\s*:\s*([a-z0-9_-]+)\.([a-z0-9_.-]+)(?::\s*(.*))?$/i;
const SOURCE_LOCATION_SNIPPET_RE =
  /^(?:stdout:\s*)?(?:(?:[A-Za-z]:\\|\.{0,2}\/|[A-Za-z0-9_.-]+\/)[^:\n]*\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|txt):\d+(?::\d+)?:|[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs):\d+(?::\d+)?:)\s*/i;
// Lines that are clearly Codex/MCP runtime noise rather than login-status
// answers. Strip these before the auth heuristic so unrelated tool-router,
// policy, plugin-sync, or teardown diagnostics cannot trigger a false
// CODEX_NOT_LOGGED_IN.
const RUNTIME_NOISE_LINE_RE =
  /(?:^\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+)|(?:\b(?:rmcp::|codex_core::|codex_mcp_server::|tools::router|tracing::|tower::|hyper::|reqwest::)\S*)|(?:^SUCCESS:\s+The process with PID\b)|(?:\brejected:\s+blocked by policy\b)|(?:\bread-only sandbox\b)|(?:\buser approval settings\b)/i;

function stripAnsi(text: string): string {
  return text.replace(ANSI_OSC_RE, "").replace(ANSI_CSI_RE, "").replace(STRAY_ESC_RE, "");
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function normalizeCodexTranscript(input: {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode?: number | null;
}): CodexCliTranscript {
  const cleanedStdout = stripAnsi(normalizeNewlines(input.stdout));
  const cleanedStderr = stripAnsi(normalizeNewlines(input.stderr));
  const stdoutExtracted = extractCodexJsonEvents(cleanedStdout);
  const stderrExtracted = extractCodexJsonEvents(cleanedStderr);
  const events = Object.freeze([...stdoutExtracted.events, ...stderrExtracted.events]);

  const assistantDeltas = projectCodexAssistantDeltas(events);
  const projectedAssistantText = projectCodexAssistantText(events, assistantDeltas);
  const assistantText = projectedAssistantText ?? cleanedStdout.replace(/[ \t]+\n/g, "\n").trim();
  const toolCalls = projectCodexToolCalls(events);
  const structuredToolCallWitnesses = projectCodexToolCallWitnesses(events);
  const mcpFailureDiagnostics = projectMcpFailureDiagnostics(events);
  const usage = projectCodexUsage(events) ?? projectTelemetryUsage(`${cleanedStdout}\n${cleanedStderr}`);
  const structuredErrors = projectStructuredErrors(events);
  const stderrDiagnostics = stderrExtracted.diagnostics;
  const diagnosticLines = collectDiagnostics({
    stdoutDiagnostics: stdoutExtracted.events.length > 0 ? stdoutExtracted.diagnostics : [],
    stderrDiagnostics,
    mcpFailureDiagnostics,
  });
  const toolCallWitnesses = mergeToolCallWitnesses(
    structuredToolCallWitnesses,
    projectCodexToolCallWitnessesFromDiagnostics(diagnosticLines, structuredToolCallWitnesses.length),
  );
  const pluginSyncWarnings = projectPluginSyncWarnings(diagnosticLines);
  const usageLimit = projectUsageLimitInfo({
    structuredErrors,
    diagnostics: diagnosticLines,
    assistantText,
  });
  const modelUnsupported =
    structuredErrors.some((err) => isModelUnsupportedText(`${err.code ?? ""} ${err.message}`)) ||
    stderrDiagnostics.some(isModelUnsupportedDiagnostic);
  const policyDenied =
    structuredErrors.some((err) => isPolicyDeniedText(`${err.code ?? ""} ${err.message}`)) ||
    stderrDiagnostics.some(isPolicyDeniedDiagnostic);
  const hasStderrErrors = diagnosticLines.some(
    (line) =>
      ERROR_LINE_RE.test(line) &&
      !RUNTIME_NOISE_LINE_RE.test(line) &&
      !isCodexPluginSyncNoise(line),
  );
  const notLoggedIn = detectNotLoggedIn({
    stdout: cleanedStdout,
    stderr: cleanedStderr,
    exitCode: input.exitCode,
    usageLimit,
    modelUnsupported,
    policyDenied,
  });

  return {
    assistantText,
    assistantDeltas,
    diagnostics: Object.freeze(diagnosticLines),
    hasStderrErrors,
    notLoggedIn,
    toolCalls,
    toolCallWitnesses,
    usage,
    structuredErrors,
    usageLimit,
    modelUnsupported,
    policyDenied,
    pluginSyncWarnings,
    turns: Object.freeze({
      started: countEvents(events, "turn.started"),
      completed: countEvents(events, "turn.completed"),
    }),
    completedItemCount: countEvents(events, "item.completed") + countEvents(events, "response.output_item.done"),
  };
}

/**
 * Decide whether `codex login status` or `codex exec` actually reported an
 * unauthenticated session.
 *
 * Exit code 0 is authoritative. On non-zero exits, auth is only inferred from
 * clean auth lines after usage/rate-limit, unsupported-model, policy, plugin
 * sync, and runtime-noise lines have been excluded.
 */
function detectNotLoggedIn(input: {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode?: number | null;
  readonly usageLimit: CodexUsageLimitInfo | null;
  readonly modelUnsupported: boolean;
  readonly policyDenied: boolean;
}): boolean {
  if (input.exitCode === 0) return false;
  if (input.usageLimit || input.modelUnsupported || input.policyDenied) return false;
  for (const raw of `${input.stdout}\n${input.stderr}`.split("\n")) {
    const summarized = summarizeCodexDiagnosticLine(raw);
    if (!summarized) continue;
    if (RUNTIME_NOISE_LINE_RE.test(summarized)) continue;
    if (isCodexPluginSyncNoise(summarized)) continue;
    if (isUsageLimitText(summarized)) continue;
    if (isModelUnsupportedText(summarized)) continue;
    if (isPolicyDeniedText(summarized)) continue;
    if (NOT_LOGGED_IN_RE.test(summarized)) return true;
  }
  return false;
}

function projectCodexAssistantDeltas(events: readonly unknown[]): readonly string[] {
  const deltas: string[] = [];
  for (const event of events) {
    const delta = codexAssistantDelta(event);
    if (delta) deltas.push(delta);
  }
  return Object.freeze(deltas);
}

function projectCodexAssistantText(
  events: readonly unknown[],
  assistantDeltas: readonly string[],
): string | null {
  if (events.length === 0) return null;
  let authoritativeText: string | null = null;
  for (const event of events) {
    const text = codexAssistantCompletedText(event);
    if (text !== null) authoritativeText = text;
  }
  if (authoritativeText !== null) return authoritativeText.trim();
  const deltaText = assistantDeltas.join("").trim();
  return deltaText.length > 0 ? deltaText : "";
}

/**
 * Project DreamGraph MCP tool invocations directly from Codex's JSON event
 * stream as transcript witnesses only.
 *
 * The MCP audit bridge is the authoritative source of recorded tool results.
 * Failed/cancelled transcript items are intentionally not projected: those
 * represent missing tool results, so they must not masquerade as successful
 * calls whose audit record was lost.
 */
function projectCodexToolCalls(events: readonly unknown[]): readonly ToolCallObservation[] {
  if (events.length === 0) return Object.freeze([]);
  const calls: ToolCallObservation[] = [];
  for (const event of events) {
    const record = asRecord(event);
    const type = codexEventType(event);
    const data = codexEventData(event);
    if (type === "item.completed" || type === "response.output_item.done") {
      const item = asRecord(record?.item) ?? asRecord(data?.item);
      if (isMcpToolItem(item) && isSuccessfulOrUnknownMcpToolItem(item)) {
        const observed = projectMcpToolItem(item);
        if (observed) calls.push(observed);
      }
      continue;
    }
    if (
      type === "mcp_tool_call.completed" ||
      type === "mcp_tool_call" ||
      type === "mcp_tool_call.end" ||
      type === "mcp_tool_call_end"
    ) {
      if (!isSuccessfulOrUnknownMcpToolItem(record)) continue;
      const observed = projectQualifiedMcpTool(record);
      if (observed) calls.push(observed);
      continue;
    }
    if (type === "tool.execution_complete") {
      const server = recordString(data, "mcpServerName") ?? recordString(record, "mcpServerName");
      const tool =
        recordString(data, "mcpToolName") ??
        recordString(record, "mcpToolName") ??
        recordString(data, "toolName") ??
        recordString(record, "toolName");
      const success = record?.success ?? data?.success;
      if (server && tool && success !== false) calls.push({ server, tool });
    }
  }
  return Object.freeze(calls);
}

export function projectCodexToolCallWitnesses(
  events: readonly unknown[],
  sequenceOffset = 0,
): readonly CodexToolCallWitness[] {
  if (events.length === 0) return Object.freeze([]);
  const witnesses: CodexToolCallWitness[] = [];
  let sequence = sequenceOffset;
  for (const event of events) {
    const record = asRecord(event);
    const type = codexEventType(event);
    const data = codexEventData(event);
    if (type === "item.completed" || type === "response.output_item.done") {
      const item = asRecord(record?.item) ?? asRecord(data?.item);
      if (!isMcpToolItem(item)) continue;
      const witness = projectMcpToolItemWitness(item, sequence);
      if (witness) {
        witnesses.push(witness);
        sequence += 1;
      }
      continue;
    }
    if (
      type === "mcp_tool_call.completed" ||
      type === "mcp_tool_call" ||
      type === "mcp_tool_call.end" ||
      type === "mcp_tool_call_end" ||
      type === "mcp_tool_call.failed" ||
      type === "mcp_tool_call.error" ||
      type === "mcp_tool_call.cancelled" ||
      type === "mcp_tool_call.canceled"
    ) {
      const witness = projectQualifiedMcpToolWitness(record, type, sequence);
      if (witness) {
        witnesses.push(witness);
        sequence += 1;
      }
      continue;
    }
    if (type === "tool.execution_complete") {
      const server = recordString(data, "mcpServerName") ?? recordString(record, "mcpServerName");
      const tool =
        recordString(data, "mcpToolName") ??
        recordString(record, "mcpToolName") ??
        recordString(data, "toolName") ??
        recordString(record, "toolName");
      if (!server || !tool) continue;
      const success = record?.success ?? data?.success;
      const isError = record?.is_error ?? record?.isError ?? data?.is_error ?? data?.isError;
      witnesses.push(Object.freeze({
        server,
        tool,
        status: normalizeMcpToolStatus(undefined, success, isError, type),
        source: "structured-event",
        sequence,
      }));
      sequence += 1;
    }
  }
  return Object.freeze(witnesses);
}

export function projectCodexToolCallWitnessesFromDiagnostics(
  diagnostics: readonly string[],
  sequenceOffset = 0,
): readonly CodexToolCallWitness[] {
  const witnesses: CodexToolCallWitness[] = [];
  let sequence = sequenceOffset;
  for (const line of diagnostics) {
    const match = line.match(MCP_TOOL_CALL_DIAGNOSTIC_RE);
    if (!match) continue;
    const server = match[2] ?? "unknown";
    const tool = match[3] ?? "unknown";
    const detail = match[4]?.trim();
    const status = normalizeToolStatusWithDetail(normalizeDiagnosticToolStatus(match[1]), detail);
    witnesses.push(Object.freeze({
      server,
      tool,
      status,
      ...(detail ? { detail } : {}),
      source: "diagnostic",
      sequence,
    }));
    sequence += 1;
  }
  return Object.freeze(witnesses);
}

function mergeToolCallWitnesses(
  primary: readonly CodexToolCallWitness[],
  secondary: readonly CodexToolCallWitness[],
): readonly CodexToolCallWitness[] {
  const out: CodexToolCallWitness[] = [];
  const seen = new Set<string>();
  for (const witness of [...primary, ...secondary]) {
    const key = toolCallWitnessKey(witness);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(witness);
  }
  return Object.freeze(out);
}

function toolCallWitnessKey(witness: CodexToolCallWitness): string {
  return [
    witness.server,
    witness.tool,
    witness.status,
    witness.detail ?? "",
  ].join("\0");
}

function projectMcpFailureDiagnostics(events: readonly unknown[]): readonly string[] {
  if (events.length === 0) return Object.freeze([]);
  const out: string[] = [];
  for (const event of events) {
    const record = asRecord(event);
    const type = codexEventType(event);
    const data = codexEventData(event);
    const item = type === "item.completed" || type === "response.output_item.done"
      ? asRecord(record?.item) ?? asRecord(data?.item)
      : record;
    if (!isMcpToolItem(item)) continue;
    if (isSuccessfulOrUnknownMcpToolItem(item)) continue;
    const server = recordString(item, "server") ?? "unknown";
    const tool = recordString(item, "tool") ?? recordString(item, "tool_name") ?? "unknown";
    const status = recordString(item, "status") ?? "failed";
    const output = recordString(item, "aggregated_output") ?? recordString(item, "error") ?? "";
    out.push(`mcp_tool_call ${status}: ${server}.${tool}${output.length > 0 ? `: ${output}` : ""}`);
  }
  return Object.freeze(out);
}

function projectCodexUsage(events: readonly unknown[]): CodexTokenUsage | null {
  let usage: CodexTokenUsage | null = null;
  for (const event of events) {
    const candidate = usageRecordFromEvent(event);
    if (candidate) usage = candidate;
  }
  return usage;
}

function usageRecordFromEvent(event: unknown): CodexTokenUsage | null {
  const record = asRecord(event);
  const data = codexEventData(event);
  const response = asRecord(record?.response) ?? asRecord(data?.response);
  const usage =
    asRecord(record?.usage) ??
    asRecord(data?.usage) ??
    asRecord(response?.usage) ??
    asRecord(asRecord(record?.result)?.usage) ??
    asRecord(asRecord(data?.result)?.usage);
  if (!usage) return null;
  const inputTokens = firstNumber(usage, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]);
  const cachedInputTokens = firstNumber(usage, ["cached_input_tokens", "cachedInputTokens"]);
  const outputTokens = firstNumber(usage, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]);
  const totalTokens = firstNumber(usage, ["total_tokens", "totalTokens"]);
  return Object.freeze({
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    raw: usage,
  });
}

function projectStructuredErrors(events: readonly unknown[]): readonly CodexStructuredError[] {
  const errors: CodexStructuredError[] = [];
  for (const event of events) {
    const type = codexEventType(event);
    const record = asRecord(event);
    const data = codexEventData(event);
    const errorRecord =
      asRecord(record?.error) ??
      asRecord(data?.error) ??
      asRecord(asRecord(record?.response)?.error) ??
      asRecord(asRecord(data?.response)?.error);
    const directMessage =
      recordString(record, "message") ??
      recordString(data, "message") ??
      recordString(record, "error") ??
      recordString(data, "error");
    const errorMessage =
      recordString(errorRecord, "message") ??
      recordString(errorRecord, "error") ??
      directMessage;
    const errorCode =
      recordString(errorRecord, "code") ??
      recordString(errorRecord, "type") ??
      recordString(record, "code") ??
      recordString(data, "code") ??
      recordString(record, "error_code") ??
      recordString(data, "error_code");
    const typeLooksLikeError =
      typeof type === "string" && /(?:error|failed|failure|rate_limit|quota|unsupported|denied)/i.test(type);
    if (!errorMessage && !errorCode && !typeLooksLikeError) continue;
    const message = errorMessage ?? errorCode ?? type ?? "Codex structured error";
    errors.push(Object.freeze({
      type: type ?? "unknown",
      ...(errorCode !== undefined ? { code: errorCode } : {}),
      message,
      ...(extractRetryAt(message) ? { retryAt: extractRetryAt(message) } : {}),
      raw: event,
    }));
  }
  return Object.freeze(errors);
}

function projectUsageLimitInfo(input: {
  readonly structuredErrors: readonly CodexStructuredError[];
  readonly diagnostics: readonly string[];
  readonly assistantText: string;
}): CodexUsageLimitInfo | null {
  for (const err of input.structuredErrors) {
    const text = `${err.code ?? ""} ${err.message}`;
    if (isUsageLimitText(text)) {
      return Object.freeze({
        message: err.message,
        ...(err.code !== undefined ? { code: err.code } : {}),
        ...(err.retryAt !== undefined ? { retryAt: err.retryAt } : extractRetryAt(err.message) ? { retryAt: extractRetryAt(err.message)! } : {}),
      });
    }
  }
  for (const line of input.diagnostics) {
    if (isDiagnosticUsageLimitText(line)) {
      return Object.freeze({
        message: line,
        ...(extractRetryAt(line) ? { retryAt: extractRetryAt(line)! } : {}),
      });
    }
  }
  if (isAssistantUsageLimitText(input.assistantText)) {
    return Object.freeze({
      message: input.assistantText,
      ...(extractRetryAt(input.assistantText) ? { retryAt: extractRetryAt(input.assistantText)! } : {}),
    });
  }
  return null;
}

function collectDiagnostics(input: {
  readonly stdoutDiagnostics: readonly string[];
  readonly stderrDiagnostics: readonly string[];
  readonly mcpFailureDiagnostics: readonly string[];
}): readonly string[] {
  const out: string[] = [];
  for (const line of input.stdoutDiagnostics) pushDiagnostic(out, `stdout: ${line}`);
  for (const line of input.stderrDiagnostics) pushDiagnostic(out, line);
  for (const line of input.mcpFailureDiagnostics) pushDiagnostic(out, line);
  return Object.freeze(out);
}

function pushDiagnostic(out: string[], line: string): void {
  if (isSourceSnippetDiagnostic(line)) return;
  if (out.includes(line)) return;
  out.push(line);
}

function isSourceSnippetDiagnostic(line: string): boolean {
  return SOURCE_LOCATION_SNIPPET_RE.test(line.trim());
}

function projectPluginSyncWarnings(diagnostics: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const line of diagnostics) {
    if (!isCodexPluginSyncNoise(line)) continue;
    const summary = summarizeCodexDiagnosticLine(line);
    if (summary && !out.includes(summary)) out.push(summary);
  }
  return Object.freeze(out);
}

function isMcpToolItem(record: Record<string, unknown> | undefined): boolean {
  const type = recordString(record, "type") ?? recordString(record, "item_type");
  return type === "mcp_tool_call";
}

function isSuccessfulOrUnknownMcpToolItem(record: Record<string, unknown> | undefined): boolean {
  const status = recordString(record, "status")?.toLowerCase();
  const success = record?.success;
  const isError = record?.is_error ?? record?.isError;
  if (success === false || isError === true) return false;
  return status === undefined || !MCP_FAILED_STATUSES.has(status);
}

function projectMcpToolItem(record: Record<string, unknown> | undefined): ToolCallObservation | null {
  const server = recordString(record, "server") ?? recordString(record, "mcpServerName");
  const tool =
    recordString(record, "tool") ??
    recordString(record, "tool_name") ??
    recordString(record, "mcpToolName");
  if (server && tool) return { server, tool };
  return projectQualifiedMcpTool(record);
}

function projectMcpToolItemWitness(
  record: Record<string, unknown> | undefined,
  sequence: number,
): CodexToolCallWitness | null {
  const server = recordString(record, "server") ?? recordString(record, "mcpServerName");
  const tool =
    recordString(record, "tool") ??
    recordString(record, "tool_name") ??
    recordString(record, "mcpToolName");
  const qualified = server && tool ? null : projectQualifiedMcpTool(record);
  const witnessServer = server ?? qualified?.server;
  const witnessTool = tool ?? qualified?.tool;
  if (!witnessServer || !witnessTool) return null;
  const detail =
    recordString(record, "aggregated_output") ??
    recordString(record, "error") ??
    recordString(record, "message");
  const status = normalizeMcpToolStatus(
    recordString(record, "status"),
    record?.success,
    record?.is_error ?? record?.isError,
  );
  return Object.freeze({
    server: witnessServer,
    tool: witnessTool,
    status: normalizeToolStatusWithDetail(status, detail),
    ...(detail ? { detail } : {}),
    source: "structured-event",
    sequence,
  });
}

function projectQualifiedMcpTool(record: Record<string, unknown> | undefined): ToolCallObservation | null {
  const directServer = recordString(record, "server");
  const directTool = recordString(record, "tool") ?? recordString(record, "tool_name");
  if (directServer && directTool) {
    return { server: directServer, tool: directTool };
  }

  const qualified = recordString(record, "tool") ?? recordString(record, "tool_name");
  if (!qualified) return null;
  const dot = qualified.indexOf(".");
  if (dot <= 0 || dot >= qualified.length - 1) return null;
  return {
    server: qualified.slice(0, dot),
    tool: qualified.slice(dot + 1),
  };
}

function projectQualifiedMcpToolWitness(
  record: Record<string, unknown> | undefined,
  type: string | undefined,
  sequence: number,
): CodexToolCallWitness | null {
  const observed = projectQualifiedMcpTool(record);
  if (!observed) return null;
  const detail =
    recordString(record, "aggregated_output") ??
    recordString(record, "error") ??
    recordString(record, "message");
  const status = normalizeMcpToolStatus(
    recordString(record, "status"),
    record?.success,
    record?.is_error ?? record?.isError,
    type,
  );
  return Object.freeze({
    server: observed.server,
    tool: observed.tool,
    status: normalizeToolStatusWithDetail(status, detail),
    ...(detail ? { detail } : {}),
    source: "structured-event",
    sequence,
  });
}

function normalizeDiagnosticToolStatus(status: string | undefined): CodexToolCallWitnessStatus {
  const normalized = status?.trim().toLowerCase();
  if (normalized === "completed" || normalized === "succeeded") return "completed";
  if (normalized === "cancelled" || normalized === "canceled") return "cancelled";
  if (normalized === "failed" || normalized === "failure" || normalized === "error") return "failed";
  return "unknown";
}

function normalizeMcpToolStatus(
  status: string | undefined,
  success: unknown,
  isError: unknown,
  type?: string,
): CodexToolCallWitnessStatus {
  const normalized = normalizeDiagnosticToolStatus(status);
  if (normalized !== "unknown") return normalized;
  if (success === false || isError === true) return "failed";
  if (success === true || type === "mcp_tool_call.completed" || type === "tool.execution_complete") {
    return "completed";
  }
  if (typeof type === "string" && /cancelled|canceled/i.test(type)) return "cancelled";
  if (typeof type === "string" && /failed|error/i.test(type)) return "failed";
  return "unknown";
}

function normalizeToolStatusWithDetail(
  status: CodexToolCallWitnessStatus,
  detail: string | undefined,
): CodexToolCallWitnessStatus {
  if (status === "failed" && detail && /\buser cancelled MCP tool call\b/i.test(detail)) {
    return "cancelled";
  }
  return status;
}

function firstNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = recordNumber(record, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

function countEvents(events: readonly unknown[], type: string): number {
  let count = 0;
  for (const event of events) {
    if (codexEventType(event) === type) count += 1;
  }
  return count;
}

function isUsageLimitText(text: string): boolean {
  return USAGE_LIMIT_RUNTIME_RE.test(text) ||
    (USAGE_LIMIT_PHRASE_RE.test(text) && USAGE_LIMIT_ERROR_CONTEXT_RE.test(text));
}

function isDiagnosticUsageLimitText(text: string): boolean {
  if (isSourceSnippetDiagnostic(text)) return false;
  return isUsageLimitText(text);
}

function isAssistantUsageLimitText(text: string): boolean {
  return USAGE_LIMIT_RUNTIME_RE.test(text) &&
    /(?:^|\b)(?:turn error|you(?:'|’|â€™)ve hit your usage limit|purchase more credits|try again at|rate[_ -]?limit|insufficient[_ -]?quota|too many requests)\b/i.test(text);
}

function isModelUnsupportedText(text: string): boolean {
  return MODEL_UNSUPPORTED_RE.test(text) || MODEL_UNSUPPORTED_PHRASE_RE.test(text);
}

function isPolicyDeniedText(text: string): boolean {
  return POLICY_DENIED_RE.test(text);
}

function isModelUnsupportedDiagnostic(text: string): boolean {
  if (!isModelUnsupportedText(text)) return false;
  return /(?:^|\b)(?:turn error|error|fatal|codex(?: cli)? error)\s*:/i.test(text)
    || /\b(?:unsupported_model|model_not_supported|model_not_found|invalid_model)\b/i.test(text);
}

function isPolicyDeniedDiagnostic(text: string): boolean {
  if (!isPolicyDeniedText(text)) return false;
  return /(?:^|\b)(?:turn error|error|fatal|rejected|codex(?: cli)? error)\s*:/i.test(text)
    || /\b(?:blocked by policy|read-only sandbox|writing is blocked|user approval settings)\b/i.test(text);
}

function extractRetryAt(text: string): string | undefined {
  const match = text.match(/\btry again at\s+([^.!\n]+)/i);
  return match?.[1]?.trim();
}

function projectTelemetryUsage(text: string): CodexTokenUsage | null {
  if (!/\bevent\.kind=response\.completed\b/.test(text)) return null;
  const inputTokens = telemetryNumber(text, "input_token_count");
  const outputTokens = telemetryNumber(text, "output_token_count");
  const cachedInputTokens = telemetryNumber(text, "cached_token_count");
  const totalTokens =
    inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined;
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cachedInputTokens === undefined &&
    totalTokens === undefined
  ) {
    return null;
  }
  return Object.freeze({
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    raw: { source: "codex_telemetry" },
  });
}

function telemetryNumber(text: string, key: string): number | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`\\b${escaped}=(\\d+)\\b`));
  if (!match?.[1]) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}
