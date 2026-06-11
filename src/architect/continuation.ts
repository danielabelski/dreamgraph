import { createHash } from "node:crypto";
import { buildArchitectToolManifestFromText, normalizeArchitectToolName } from "./tool-selection.js";

export const ARCHITECT_CONTINUATION_SCHEMA = "dreamgraph.architect.continuation.v1";

export const ARCHITECT_CONTINUATION_FENCE = "architect_continuation";

const MAX_TEXT = 1_000;
const MAX_ACTIONS = 8;
const MAX_TOOLS = 24;
const MAX_FALLBACK_EVIDENCE_ITEMS = 16;
const CONTINUATION_TOKEN_VERSION = 1;

const MUTATION_TOOL_PATTERN = /\b(?:patch_file|append_to_file|create_file|edit_file|delete_file|rename_file|edit_entity|edit_markdown_section|patch_markdown_chapter)\b/i;

export interface ArchitectContinuationToolManifest {
  required_tools: string[];
  preferred_tools: string[];
  unavailable_required_tools?: string[];
}

export interface ArchitectRecommendedAction {
  id: string;
  label: string;
  rationale: string;
  kind: "continue" | "pause" | "stop" | "request_user_input";
  prompt: string;
  safe: boolean;
  recommended: boolean;
  required_tools: string[];
  preferred_tools: string[];
  disabled_reason: string | null;
}

export interface ArchitectContinuationEnvelope {
  schema: typeof ARCHITECT_CONTINUATION_SCHEMA;
  pass_id: string;
  status: "completed" | "blocked" | "needs_user_input" | "uncertain" | "failed";
  summary: string;
  work_completed: string[];
  files_touched: string[];
  graph_entities_touched: string[];
  tool_trace_summary: string[];
  graph_plan_updates: string[];
  evidence: string[];
  blockers: string[];
  uncertainty: number;
  stop_reason: string | null;
  recommended_actions: ArchitectRecommendedAction[];
}

export interface ArchitectFallbackEvidenceSection {
  source: string;
  label: string;
  items: string[];
}

export interface ArchitectPassReport {
  id: string;
  pass_id: string;
  created_at: string;
  summary: string;
  work_completed: string[];
  files_touched: string[];
  graph_entities_touched: string[];
  tool_trace_summary: string[];
  graph_plan_updates: string[];
  evidence: string[];
  blockers: string[];
  uncertainty: number;
  recommended_next_step: ArchitectRecommendedAction | null;
  continuation_options: ArchitectRecommendedAction[];
  diagnostics: string[];
  fallback_evidence?: ArchitectFallbackEvidenceSection[];
}

export interface ArchitectContinuationState {
  version: typeof CONTINUATION_TOKEN_VERSION;
  selected_plan_id: string | null;
  chat_scope: "project" | "plan";
  previous_pass_report_id: string;
  pass_id: string;
  recommended_actions: ArchitectRecommendedAction[];
  selected_action_id: string | null;
  required_tools: string[];
  preferred_tools: string[];
  budget: {
    completed_passes: number;
    max_passes: number;
  };
  stop_context: {
    stopped: boolean;
    reason: string | null;
    diagnostics: string[];
  };
}

export interface ArchitectContinuationDecision {
  status: "continue" | "wait" | "stopped";
  reason: string;
  report: ArchitectPassReport;
  continuation_token: string | null;
  selected_action: ArchitectRecommendedAction | null;
  tool_manifest: ArchitectContinuationToolManifest | null;
}

export interface ArchitectContinuationParseResult {
  envelope: ArchitectContinuationEnvelope | null;
  report: ArchitectPassReport;
  diagnostics: string[];
}

export interface ArchitectContinuationContext {
  selected_plan_id: string | null;
  chat_scope: "project" | "plan";
  completed_passes?: number;
  max_passes?: number;
  now?: Date;
}

export interface ArchitectRouteFailureContinuationInput {
  reason: string;
  adapter: string;
  provider: string;
  model: string;
  context: ArchitectContinuationContext;
  tool_trace_summary?: string[];
}

export interface ArchitectEvidenceRecoveryInput {
  reason: string;
  context: ArchitectContinuationContext;
  adapter?: string | null;
  provider?: string | null;
  model?: string | null;
  implementation_log?: string[];
  route_tool_trace?: string[];
  chat_transcript?: string[];
  observed_file_mutations?: string[];
  verification_output?: string[];
  assistant_reported_unverified?: string[];
  envelope_fallback?: string[];
  mutation_tools_seen?: boolean;
  verification_incomplete?: boolean;
}

export function parseArchitectContinuationEnvelope(text: string, context: ArchitectContinuationContext): ArchitectContinuationParseResult {
  const diagnostics: string[] = [];
  const raw = extractContinuationJson(text);
  if (!raw) {
    diagnostics.push("missing_architect_continuation_envelope");
    const report = diagnosticReport("missing-envelope", "Assistant response did not include an architect continuation envelope.", diagnostics, context.now);
    return { envelope: null, report, diagnostics };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    diagnostics.push(`malformed_architect_continuation_json: ${(error as Error).message.slice(0, 160)}`);
    const report = diagnosticReport("malformed-envelope", "Assistant response included malformed architect continuation JSON.", diagnostics, context.now);
    return { envelope: null, report, diagnostics };
  }

  const record = asRecord(parsed);
  if (!record) {
    diagnostics.push("architect_continuation_envelope_not_object");
    const report = diagnosticReport("invalid-envelope", "Assistant continuation envelope was not a JSON object.", diagnostics, context.now);
    return { envelope: null, report, diagnostics };
  }

  const canonicalRecord = canonicalizeContinuationRecord(record, diagnostics);
  const actions = sanitizeRecommendedActions(firstPresent(canonicalRecord.recommended_actions, canonicalRecord.recommendedActions, canonicalRecord.recommended_next_actions, canonicalRecord.recommendedNextActions), diagnostics);
  const recoveredActions = actions.length > 0 ? actions : synthesizeLegacyContinuationActions(record, diagnostics);
  const passId = sanitizeId(stringValue(firstPresent(canonicalRecord.pass_id, canonicalRecord.passId)) || "pass", "pass");
  const envelope: ArchitectContinuationEnvelope = {
    schema: ARCHITECT_CONTINUATION_SCHEMA,
    pass_id: passId,
    status: normalizePassStatus(canonicalRecord.status),
    summary: sanitizeText(stringValue(canonicalRecord.summary) || "Pass completed without a summary."),
    work_completed: sanitizeTextList(firstPresent(canonicalRecord.work_completed, canonicalRecord.workCompleted)),
    files_touched: sanitizeTextList(firstPresent(canonicalRecord.files_touched, canonicalRecord.filesTouched, canonicalRecord.files_inspected, canonicalRecord.filesInspected)),
    graph_entities_touched: sanitizeTextList(firstPresent(canonicalRecord.graph_entities_touched, canonicalRecord.graphEntitiesTouched)),
    tool_trace_summary: sanitizeTextList(firstPresent(canonicalRecord.tool_trace_summary, canonicalRecord.toolTraceSummary, canonicalRecord.tool_trace, canonicalRecord.toolTrace)),
    graph_plan_updates: sanitizeTextList(firstPresent(canonicalRecord.graph_plan_updates, canonicalRecord.graphPlanUpdates, canonicalRecord.plan_updates, canonicalRecord.planUpdates)),
    evidence: sanitizeTextList(canonicalRecord.evidence),
    blockers: sanitizeTextList(canonicalRecord.blockers),
    uncertainty: normalizeUncertainty(canonicalRecord.uncertainty),
    stop_reason: nullableSanitizedText(firstPresent(canonicalRecord.stop_reason, canonicalRecord.stopReason)),
    recommended_actions: recoveredActions,
  };

  if (stringValue(canonicalRecord.schema) && stringValue(canonicalRecord.schema) !== ARCHITECT_CONTINUATION_SCHEMA) {
    diagnostics.push(`unexpected_architect_continuation_schema: ${sanitizeText(String(canonicalRecord.schema), 120)}`);
  }

  const report = buildArchitectPassReport(envelope, diagnostics, context.now);
  return { envelope, report, diagnostics };
}

function canonicalizeContinuationRecord(record: Record<string, unknown>, diagnostics: string[]): Record<string, unknown> {
  if (!isLegacyArchitectReportRecord(record)) return record;
  diagnostics.push("legacy_architect_report_json_canonicalized");
  const governedTools = Array.isArray(record.governed_tools_used) ? record.governed_tools_used : [];
  const verification = asRecord(record.verification);
  const followUp = asRecord(record.follow_up_recommendation);
  const workCompleted = sanitizeTextList(firstPresent(record.work_completed, record.workCompleted));
  const toolTrace = [
    ...governedTools.map(formatLegacyGovernedToolUse).filter(Boolean),
    ...legacyVerificationSummary(verification),
  ];
  const evidence = sanitizeTextList(record.evidence);
  const blockers = sanitizeTextList(record.blockers);
  const status = normalizePassStatus(record.status);
  return {
    schema: ARCHITECT_CONTINUATION_SCHEMA,
    pass_id: stringValue(firstPresent(record.pass_id, record.passId, record.pass_report_id, record.passReportId)) ?? "legacy-architect-report",
    status,
    summary: stringValue(record.summary) ?? legacyReportSummary(record, status),
    work_completed: workCompleted.length > 0
      ? workCompleted
      : governedTools.map(formatLegacyGovernedToolUse).filter(Boolean),
    files_touched: sanitizeTextList(firstPresent(record.files_touched, record.filesTouched, record.files_inspected, record.filesInspected)),
    graph_entities_touched: sanitizeTextList(firstPresent(record.graph_entities_touched, record.graphEntitiesTouched)),
    tool_trace_summary: toolTrace,
    graph_plan_updates: sanitizeTextList(firstPresent(record.graph_plan_updates, record.graphPlanUpdates, record.plan_updates, record.planUpdates)),
    evidence: evidence.length > 0 ? evidence : legacyEvidence(record, verification),
    blockers: blockers.length > 0 ? blockers : status === "completed" ? [] : [`legacy report status: ${status}`],
    uncertainty: firstPresent(record.uncertainty, status === "completed" ? 0 : 0.5),
    stop_reason: firstPresent(record.stop_reason, record.stopReason),
    recommended_actions: followUp ? [legacyFollowUpAction(followUp)] : [],
  };
}

function isLegacyArchitectReportRecord(record: Record<string, unknown>): boolean {
  if (stringValue(record.schema) || stringValue(record.summary) || Array.isArray(record.work_completed)) return false;
  return Boolean(
    stringValue(firstPresent(record.pass_report_id, record.passReportId, record.completed_step, record.completedStep))
      || Array.isArray(record.governed_tools_used)
      || asRecord(record.verification)
      || asRecord(record.follow_up_recommendation),
  );
}

function legacyReportSummary(record: Record<string, unknown>, status: ArchitectContinuationEnvelope["status"]): string {
  const completedStep = stringValue(firstPresent(record.completed_step, record.completedStep));
  if (completedStep) return `${completedStep} ${status}.`;
  return `Legacy Architect report completed with status ${status}.`;
}

function formatLegacyGovernedToolUse(value: unknown): string {
  const record = asRecord(value);
  if (!record) return sanitizeText(String(value ?? ""));
  const tool = stringValue(record.tool) ?? "tool";
  const outcome = stringValue(record.outcome) ?? stringValue(record.status) ?? "completed";
  const purpose = stringValue(record.purpose);
  const sanity = stringValue(record.sanity);
  const command = stringValue(record.command);
  return sanitizeText([
    `${tool}: ${outcome}`,
    command ? `command=${command}` : "",
    purpose ? `purpose=${purpose}` : "",
    sanity ? `sanity=${sanity}` : "",
  ].filter(Boolean).join("; "));
}

function legacyVerificationSummary(verification: Record<string, unknown> | null): string[] {
  if (!verification) return [];
  const command = stringValue(verification.command);
  const passed = verification.passed === true ? "passed" : verification.passed === false ? "failed" : null;
  const exitCode = verification.exit_code ?? verification.exitCode;
  const notes = stringValue(verification.notes);
  return [sanitizeText([
    "verification",
    command ? `command=${command}` : "",
    exitCode !== undefined && exitCode !== null ? `exit_code=${String(exitCode)}` : "",
    passed ? `status=${passed}` : "",
    notes ? `notes=${notes}` : "",
  ].filter(Boolean).join("; "))].filter(Boolean);
}

function legacyEvidence(record: Record<string, unknown>, verification: Record<string, unknown> | null): string[] {
  const evidence = [];
  const chatScope = stringValue(record.chat_scope);
  const selectedPlanId = stringValue(record.selected_plan_id);
  if (chatScope) evidence.push(`chat_scope: ${chatScope}`);
  if (selectedPlanId) evidence.push(`selected_plan_id: ${selectedPlanId}`);
  if (verification?.passed === true) evidence.push("verification passed");
  return evidence;
}

function legacyFollowUpAction(record: Record<string, unknown>): Record<string, unknown> {
  const id = sanitizeId(stringValue(firstPresent(record.next_action_id, record.nextActionId, record.id)) ?? "follow-up", "follow-up");
  const summary = sanitizeText(stringValue(firstPresent(record.summary, record.label, record.title)) ?? id.replace(/-/g, " "), 120);
  const rationale = sanitizeText(stringValue(record.rationale) ?? "Legacy Architect report recommended a follow-up step.", 500);
  return {
    id,
    label: summary,
    rationale,
    kind: "request_user_input",
    prompt: [summary, rationale].filter(Boolean).join("\n"),
    safe: true,
    recommended: true,
    required_tools: [],
    preferred_tools: [],
  };
}

export function synthesizeArchitectRecoveredContinuation(input: ArchitectEvidenceRecoveryInput): ArchitectContinuationParseResult {
  const reason = sanitizeText(input.reason || "missing_architect_continuation_envelope", 240);
  const diagnostics = [reason];
  if (reason.includes("deficient")) diagnostics.push("deficient_architect_continuation_report");
  if (!diagnostics.includes("missing_architect_continuation_envelope")) diagnostics.push("missing_architect_continuation_envelope");
  const route = [input.adapter, input.provider, input.model].filter(Boolean).map((part) => sanitizeText(String(part), 120)).join("/") || "unknown route";
  const observedFiles = extractTouchedFiles(input.observed_file_mutations ?? input.route_tool_trace ?? []);
  const toolStatusSummary = summarizeToolStatus(input.route_tool_trace);
  const mutationSummary = summarizeMutations(input.observed_file_mutations ?? input.route_tool_trace ?? []);
  const verificationSummary = summarizeVerification(input.verification_output ?? input.route_tool_trace ?? []);
  const assistantSummary = summarizeAssistantText(input.assistant_reported_unverified, input.chat_transcript);
  const fallbackEvidence = buildFallbackEvidence({
    route,
    toolStatusSummary,
    mutationSummary,
    verificationSummary,
    filesTouched: observedFiles,
    assistantSummary,
    blockers: [reason],
    recommendedNextAction: "Repair the continuation envelope or continue from the compact recovery summary using governed DreamGraph MCP tools.",
  });
  const evidence = fallbackEvidence.flatMap((section) => section.items).slice(0, MAX_FALLBACK_EVIDENCE_ITEMS);
  const workCompleted = summarizeRecoveredWork(input.implementation_log, assistantSummary, mutationSummary, observedFiles);
  const preferredTools = input.verification_incomplete || input.mutation_tools_seen ? ["read_source_code", "run_command"] : [];
  const repairPrompt = [
    "Repair only the previous DreamGraph Architect pass report.",
    "Use the previous assistant text, route provenance, and DreamGraph MCP tool trace already available in the conversation.",
    "Do not mutate repository, graph, plan, or runtime state.",
    "Return a user-visible summary followed by a fenced architect_continuation JSON envelope that truthfully reports the missing-envelope diagnostic and observed evidence.",
  ].join("\n");
  const action: ArchitectRecommendedAction = {
    id: "repair-continuation-envelope",
    label: "Repair continuation envelope",
    rationale: "The pass has recoverable runtime evidence but no valid architect_continuation envelope.",
    kind: "continue",
    prompt: repairPrompt,
    safe: true,
    recommended: true,
    required_tools: [],
    preferred_tools: preferredTools,
    disabled_reason: null,
  };
  const envelope: ArchitectContinuationEnvelope = {
    schema: ARCHITECT_CONTINUATION_SCHEMA,
    pass_id: "missing-envelope-recovery",
    status: "failed",
    summary: fallbackEvidence.length > 0
      ? "Envelope missing. Observed work exists. Here is what I know from route evidence."
      : "Assistant response did not include a valid architect continuation envelope.",
    work_completed: workCompleted,
    files_touched: observedFiles,
    graph_entities_touched: [],
    tool_trace_summary: [`route: ${route}`, ...toolStatusSummary, ...verificationSummary].slice(0, MAX_FALLBACK_EVIDENCE_ITEMS),
    graph_plan_updates: sanitizeTextList(input.implementation_log).slice(0, 6),
    evidence,
    blockers: [reason],
    uncertainty: 1,
    stop_reason: reason,
    recommended_actions: [action],
  };
  const report = buildArchitectPassReport(envelope, diagnostics, input.context.now);
  report.fallback_evidence = fallbackEvidence;
  return { envelope: null, report, diagnostics };
}

export function synthesizeArchitectRouteFailureContinuation(input: ArchitectRouteFailureContinuationInput): ArchitectContinuationParseResult {
  const reason = sanitizeText(input.reason || "architect_route_failed", 240);
  const diagnostics = [reason, "architect_route_failed_before_envelope_parse"];
  const retryPrompt = [
    "Retry the previous DreamGraph Architect pass through the configured standalone route.",
    `Previous route failure: ${reason}`,
    "Keep the pass bounded, use governed DreamGraph MCP tools for repository facts and mutations, and finish with an architect_continuation envelope.",
  ].join("\n");
  const manualPrompt = [
    "Continue manually from the previous standalone Architect route failure.",
    `Route failure to account for: ${reason}`,
    "Inspect the governed project context, choose the smallest safe next step, and finish with an architect_continuation envelope.",
  ].join("\n");
  const reportPrompt = [
    "Report only on the previous standalone Architect route failure without mutating repository or graph state.",
    `Route failure: ${reason}`,
  ].join("\n");
  const envelope: ArchitectContinuationEnvelope = {
    schema: ARCHITECT_CONTINUATION_SCHEMA,
    pass_id: "route-failure",
    status: "failed",
    summary: `Standalone Architect route failed before a continuation envelope could be parsed: ${reason}`,
    work_completed: [],
    files_touched: [],
    graph_entities_touched: [],
    tool_trace_summary: [
      `route: ${sanitizeText(input.adapter, 80)}/${sanitizeText(input.provider, 80)}/${sanitizeText(input.model || "none", 120)}`,
      ...sanitizeTextList(input.tool_trace_summary),
    ],
    graph_plan_updates: [],
    evidence: [`failure classified before envelope parsing: ${reason}`],
    blockers: [reason],
    uncertainty: 1,
    stop_reason: reason,
    recommended_actions: [
      {
        id: "retry-route",
        label: "Retry route",
        rationale: "The adapter/provider failed before producing an envelope, so retrying the same bounded pass is safe.",
        kind: "continue",
        prompt: retryPrompt,
        safe: true,
        recommended: true,
        required_tools: [],
        preferred_tools: [],
        disabled_reason: null,
      },
      {
        id: "report-only",
        label: "Report only",
        rationale: "A read-only summary can preserve the failure context without attempting another pass.",
        kind: "pause",
        prompt: reportPrompt,
        safe: true,
        recommended: false,
        required_tools: [],
        preferred_tools: [],
        disabled_reason: null,
      },
      {
        id: "manual-continue",
        label: "Manual continue",
        rationale: "A human-selected continuation can proceed from the route failure with explicit intent.",
        kind: "continue",
        prompt: manualPrompt,
        safe: true,
        recommended: false,
        required_tools: [],
        preferred_tools: ["read_source_code", "search_source_code", "run_command"],
        disabled_reason: null,
      },
    ],
  };
  return { envelope, report: buildArchitectPassReport(envelope, diagnostics, input.context.now), diagnostics };
}

function buildFallbackEvidence(input: {
  route: string;
  toolStatusSummary: string[];
  mutationSummary: string[];
  verificationSummary: string[];
  filesTouched: string[];
  assistantSummary: string[];
  blockers: string[];
  recommendedNextAction: string;
}): ArchitectFallbackEvidenceSection[] {
  const items = [
    `route: ${input.route}`,
    ...input.toolStatusSummary,
    ...input.mutationSummary,
    ...input.verificationSummary,
    ...input.filesTouched.map((file) => `file touched: ${file}`),
    ...input.assistantSummary,
    ...input.blockers.map((blocker) => `recovery state: ${blocker}`),
    `recommended next action: ${input.recommendedNextAction}`,
  ];
  const compactItems = sanitizeTextList(items).filter(isRenderableReportText).slice(0, MAX_FALLBACK_EVIDENCE_ITEMS);
  return compactItems.length > 0
    ? [{ source: "fallback_evidence_summary", label: "Fallback Evidence Summary", items: compactItems }]
    : [];
}

function summarizeToolStatus(items: string[] | undefined): string[] {
  const counts = new Map<string, number>();
  for (const item of sanitizeTextList(items)) {
    const parsed = parseToolTraceText(item);
    const status = parsed.status || "unknown";
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, count]) => `tools ${status}: ${count}`);
}

function summarizeMutations(items: string[]): string[] {
  const byFile = new Map<string, number>();
  const operations: string[] = [];
  const seenOperations = new Set<string>();
  for (const item of sanitizeTextList(items)) {
    if (!MUTATION_TOOL_PATTERN.test(item)) continue;
    const parsed = parseToolTraceText(item);
    const file = extractTouchedFiles([item])[0] || "unknown file";
    byFile.set(file, (byFile.get(file) ?? 0) + 1);
    const operation = `${parsed.tool || "mutation"} -> ${file} (${normalizeToolOutcome(parsed.status || item)})`;
    if (!seenOperations.has(operation)) {
      seenOperations.add(operation);
      operations.push(operation);
    }
  }
  const counts = [...byFile.entries()].map(([file, count]) => `mutations for ${file}: ${count}`);
  return [...counts, ...operations].slice(0, MAX_FALLBACK_EVIDENCE_ITEMS);
}

function summarizeVerification(items: string[]): string[] {
  const summaries: string[] = [];
  const seen = new Set<string>();
  for (const item of sanitizeTextList(items)) {
    if (!/run_command/i.test(item)) continue;
    const parsed = parseToolTraceText(item);
    const command = extractCommandSummary(item);
    const summary = `verification ${command}: ${normalizeToolOutcome(parsed.status || item)}`;
    if (!seen.has(summary)) {
      seen.add(summary);
      summaries.push(summary);
    }
  }
  return summaries.slice(0, 6);
}

function summarizeAssistantText(assistantReported: string[] | undefined, chatTranscript: string[] | undefined): string[] {
  const assistant = sanitizeTextList(assistantReported).map(sanitizeTranscriptSummary).filter(Boolean)[0];
  const chat = sanitizeTextList(chatTranscript);
  const userCount = chat.filter((item) => /^user:/i.test(item)).length;
  const assistantCount = chat.filter((item) => /^assistant:/i.test(item)).length;
  const out: string[] = [];
  if (assistant) out.push(`assistant summary: ${assistant}`);
  if (userCount > 0 || assistantCount > 0) out.push(`chat transcript summarized: ${userCount} user message(s), ${assistantCount} assistant message(s); raw transcript omitted`);
  return out;
}

function summarizeRecoveredWork(
  implementationLog: string[] | undefined,
  assistantSummary: string[],
  mutationSummary: string[],
  filesTouched: string[],
): string[] {
  const fromLog = sanitizeTextList(implementationLog).filter(isRenderableReportText).slice(0, 4);
  if (fromLog.length > 0) return fromLog;
  if (assistantSummary.length > 0) return assistantSummary.slice(0, 2);
  if (mutationSummary.length > 0) return mutationSummary.slice(0, 4);
  if (filesTouched.length > 0) return filesTouched.slice(0, 4).map((file) => `Observed recovered work touching ${file}.`);
  return [];
}

function parseToolTraceText(item: string): { tool: string; status: string } {
  const match = /^([A-Za-z0-9_.:-]+):\s*([A-Za-z0-9_-]+)/.exec(item.trim());
  return { tool: sanitizeText(match?.[1] || "", 80), status: sanitizeText(match?.[2] || "unknown", 80) };
}

function normalizeToolOutcome(value: string): string {
  const lower = value.toLowerCase();
  if (/\b(success|succeeded|completed|ok|passed|pass)\b/.test(lower)) return "success";
  if (/\b(fail|failed|error|rejected|timeout|timedout)\b/.test(lower)) return "failure";
  return "unknown";
}

function extractCommandSummary(item: string): string {
  const commandMatch = /(?:command|cmd)[:=]\s*[`"']?([^`"',}]+)[`"']?/i.exec(item);
  const command = sanitizeText(commandMatch?.[1] || "run_command", 160);
  return command || "run_command";
}

function sanitizeTranscriptSummary(item: string): string {
  const withoutFences = item.replace(/```[\s\S]*?```/g, " ");
  const withoutRouteTrace = withoutFences.replace(/Route Tool Trace:[\s\S]*/gi, " ");
  const withoutPromptBlocks = withoutRouteTrace.replace(/CURRENT USER REQUEST[\s\S]*/gi, " ");
  const stripped = withoutPromptBlocks.replace(/^(assistant|user):\s*/i, "");
  return sanitizeText(stripped, 240);
}

function isRenderableReportText(item: string): boolean {
  const text = sanitizeText(item, 240);
  if (!text) return false;
  if (/^[A-Za-z /_-]+\s*\{$/.test(text)) return false;
  if (/^Route Tool Trace:?$/i.test(text)) return false;
  return true;
}

function extractTouchedFiles(items: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const text = String(item || "");
    const matches = text.matchAll(/[`"']?(?:filePath|file_path|target_file|path)[`"']?\s*[:=]\s*[`"']?([^`"',}\s]+)[`"']?/gi);
    for (const match of matches) {
      const candidate = sanitizeText(match[1] || "", 240);
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      out.push(candidate);
    }
  }
  return out.slice(0, 24);
}

export function buildArchitectPassReport(
  envelope: ArchitectContinuationEnvelope,
  diagnostics: string[] = [],
  now = new Date(),
): ArchitectPassReport {
  const recommended = envelope.recommended_actions.find((action) => action.recommended && action.safe && !action.disabled_reason)
    ?? envelope.recommended_actions.find((action) => action.safe && !action.disabled_reason)
    ?? null;
  const reportSeed = JSON.stringify({ pass_id: envelope.pass_id, summary: envelope.summary, actions: envelope.recommended_actions.map((action) => action.id) });
  return {
    id: `architect-pass-${createHash("sha256").update(reportSeed).digest("hex").slice(0, 16)}`,
    pass_id: envelope.pass_id,
    created_at: now.toISOString(),
    summary: envelope.summary,
    work_completed: envelope.work_completed,
    files_touched: envelope.files_touched,
    graph_entities_touched: envelope.graph_entities_touched,
    tool_trace_summary: envelope.tool_trace_summary,
    graph_plan_updates: envelope.graph_plan_updates,
    evidence: envelope.evidence,
    blockers: envelope.blockers,
    uncertainty: envelope.uncertainty,
    recommended_next_step: recommended,
    continuation_options: envelope.recommended_actions,
    diagnostics: [...diagnostics],
  };
}

export function decideArchitectContinuation(input: {
  parseResult: ArchitectContinuationParseResult;
  context: ArchitectContinuationContext;
  autonomyAllowsContinue: boolean;
  selected_action_id?: string | null;
}): ArchitectContinuationDecision {
  const { parseResult, context } = input;
  const maxPasses = normalizePositiveInteger(context.max_passes, 1);
  const completedPasses = normalizeNonNegativeInteger(context.completed_passes, 0);

  if (!parseResult.envelope) {
    return stoppedDecision("missing_or_malformed_envelope", parseResult.report, parseResult.diagnostics, context, completedPasses, maxPasses);
  }

  if (parseResult.envelope.status === "blocked" || parseResult.envelope.status === "failed") {
    return stoppedDecision(parseResult.envelope.stop_reason ?? parseResult.envelope.status, parseResult.report, parseResult.diagnostics, context, completedPasses, maxPasses);
  }

  if (parseResult.envelope.status === "needs_user_input") {
    return stoppedDecision("assistant_requested_user_input", parseResult.report, parseResult.diagnostics, context, completedPasses, maxPasses);
  }

  if (parseResult.envelope.uncertainty >= 0.8) {
    return stoppedDecision("high_uncertainty", parseResult.report, parseResult.diagnostics, context, completedPasses, maxPasses);
  }

  if (completedPasses >= maxPasses) {
    return stoppedDecision("pass_budget_exhausted", parseResult.report, parseResult.diagnostics, context, completedPasses, maxPasses);
  }

  const selected = selectContinuationAction(parseResult.report.continuation_options, input.selected_action_id);
  if (!selected) {
    return stoppedDecision("no_safe_continuation_action", parseResult.report, parseResult.diagnostics, context, completedPasses, maxPasses);
  }

  if (selected.kind === "stop") {
    return stoppedDecision("selected_action_stops", parseResult.report, parseResult.diagnostics, context, completedPasses, maxPasses, selected);
  }
  if (selected.kind === "pause") {
    return stoppedDecision("selected_action_pauses", parseResult.report, parseResult.diagnostics, context, completedPasses, maxPasses, selected);
  }
  if (selected.kind === "request_user_input") {
    return stoppedDecision("assistant_requested_user_input", parseResult.report, parseResult.diagnostics, context, completedPasses, maxPasses, selected);
  }

  const manifest = buildArchitectContinuationToolManifest(selected);
  const state = buildContinuationState({
    context,
    report: parseResult.report,
    selectedAction: input.autonomyAllowsContinue ? selected : null,
    completedPasses,
    maxPasses,
    stopped: false,
    reason: null,
    diagnostics: parseResult.diagnostics,
  });
  const token = encodeArchitectContinuationToken(state);

  if (!input.autonomyAllowsContinue) {
    return {
      status: "wait",
      reason: "autonomy_requires_manual_selection",
      report: parseResult.report,
      continuation_token: token,
      selected_action: null,
      tool_manifest: manifest,
    };
  }

  return {
    status: "continue",
    reason: "recommended_action_selected",
    report: parseResult.report,
    continuation_token: token,
    selected_action: selected,
    tool_manifest: manifest,
  };
}

export function buildArchitectContinuationPrompt(state: ArchitectContinuationState, selectedAction: ArchitectRecommendedAction): string {
  const manifest = buildArchitectContinuationToolManifest(selectedAction);
  const requiredTools = manifest.required_tools.length > 0 ? manifest.required_tools.join(", ") : "none";
  const preferredTools = manifest.preferred_tools.length > 0 ? manifest.preferred_tools.join(", ") : "none";
  return [
    "Continue the active DreamGraph Architect pass from the host-provided continuation state.",
    `Selected plan id: ${state.selected_plan_id ?? "none"}`,
    `Chat scope: ${state.chat_scope}`,
    `Previous pass report id: ${state.previous_pass_report_id}`,
    `Selected action id: ${selectedAction.id}`,
    `Selected action: ${selectedAction.label}`,
    `Action rationale: ${selectedAction.rationale}`,
    `Required DreamGraph MCP tools for this pass: ${requiredTools}`,
    `Preferred DreamGraph MCP tools for this pass: ${preferredTools}`,
    "Use governed DreamGraph MCP tool calls for repository facts and mutations. Do not substitute provider-native shell, read, or write routes for listed DreamGraph MCP tools.",
    "Complete only this selected step in the next bounded pass, verify it, inspect output sanity, and finish with a fenced architect_continuation JSON envelope for the following pass.",
    "Step prompt:",
    selectedAction.prompt,
  ].join("\n");
}

export function buildArchitectContinuationToolManifest(action: ArchitectRecommendedAction): ArchitectContinuationToolManifest {
  const inferred = inferArchitectContinuationToolManifest([action.id, action.label, action.rationale, action.prompt]);
  const requiredTools = mergeToolNames(normalizeToolNames(action.required_tools), inferred.required_tools);
  return {
    required_tools: requiredTools,
    preferred_tools: withoutToolNames(mergeToolNames(normalizeToolNames(action.preferred_tools), inferred.preferred_tools), requiredTools),
  };
}

export function inferArchitectContinuationToolManifest(parts: readonly string[]): ArchitectContinuationToolManifest {
  return inferContinuationTools(parts);
}

export function encodeArchitectContinuationToken(state: ArchitectContinuationState): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

export function decodeArchitectContinuationToken(
  token: string,
  expected: { selected_plan_id: string | null; chat_scope: "project" | "plan" },
): { ok: true; state: ArchitectContinuationState } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid_continuation_token_encoding" };
  }

  const record = asRecord(parsed);
  if (!record || record.version !== CONTINUATION_TOKEN_VERSION) {
    return { ok: false, reason: "invalid_continuation_token_version" };
  }

  const state = record as unknown as ArchitectContinuationState;
  if (state.chat_scope !== expected.chat_scope) {
    return { ok: false, reason: "continuation_token_scope_mismatch" };
  }
  if ((state.selected_plan_id ?? null) !== (expected.selected_plan_id ?? null)) {
    return { ok: false, reason: "continuation_token_plan_mismatch" };
  }
  if (!Array.isArray(state.recommended_actions) || !Array.isArray(state.required_tools) || !state.previous_pass_report_id) {
    return { ok: false, reason: "invalid_continuation_token_payload" };
  }

  return { ok: true, state };
}

export function normalizeArchitectContinuationToolName(name: string): string | null {
  return normalizeArchitectToolName(name);
}

function extractContinuationJson(text: string): string | null {
  const fencePattern = /```(?:json\s+)?architect_continuation\s*\n([\s\S]*?)```/i;
  const direct = fencePattern.exec(text);
  if (direct?.[1]) return direct[1].trim();

  const genericPattern = /```json\s*\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = genericPattern.exec(text)) != null) {
    const candidate = match[1]?.trim();
    if (candidate && looksLikeContinuationRecord(candidate)) {
      return candidate;
    }
  }

  const bare = extractBareContinuationJson(text);
  if (bare) return bare;

  return null;
}

function looksLikeContinuationRecord(candidate: string): boolean {
  if (looksLikeLegacyArchitectReportCandidate(candidate)) return true;
  if (!candidate.includes("summary")) return false;
  return candidate.includes("recommended_actions")
    || candidate.includes("recommended_next_actions")
    || candidate.includes("work_completed")
    || candidate.includes("files_inspected")
    || candidate.includes("tool_trace_summary");
}

function looksLikeLegacyArchitectReportCandidate(candidate: string): boolean {
  return (candidate.includes("pass_report_id") || candidate.includes("governed_tools_used"))
    && (candidate.includes("verification") || candidate.includes("follow_up_recommendation") || candidate.includes("completed_step"));
}

function extractBareContinuationJson(text: string): string | null {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const candidate = trimmed.slice(start, end + 1).trim();
  if (!looksLikeContinuationRecord(candidate)) return null;
  try {
    const parsed = JSON.parse(candidate);
    return asRecord(parsed) ? candidate : null;
  } catch {
    return null;
  }
}

function firstPresent(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function sanitizeRecommendedActions(value: unknown, diagnostics: string[]): ArchitectRecommendedAction[] {
  const rawActions = firstPresent(value, undefined);
  if (!Array.isArray(rawActions)) {
    diagnostics.push("recommended_actions_missing_or_not_array");
    return [];
  }

  const actionsValue = rawActions;

  const actions: ArchitectRecommendedAction[] = [];
  const seen = new Set<string>();
  for (const item of actionsValue.slice(0, MAX_ACTIONS)) {
    const record = asRecord(item);
    if (!record) {
      diagnostics.push("recommended_action_dropped_not_object");
      continue;
    }
    const labelSource = stringValue(firstPresent(record.label, record.action, record.item, record.title)) || "Continue";
    const label = sanitizeText(labelSource, 80);
    const id = sanitizeId(stringValue(record.id) || label, `action-${actions.length + 1}`);
    if (seen.has(id)) {
      diagnostics.push(`recommended_action_dropped_duplicate_id: ${id}`);
      continue;
    }
    const rationale = sanitizeText(stringValue(record.rationale) || stringValue(record.detail) || "No rationale supplied.");
    const prompt = sanitizeText(stringValue(record.prompt) || stringValue(record.action) || label, 2_000);
    const explicitRequiredTools = normalizeToolNames(record.required_tools);
    const explicitPreferredTools = normalizeToolNames(record.preferred_tools);
    const inferredTools = inferContinuationTools([id, label, rationale, prompt]);
    const requiredTools = mergeToolNames(explicitRequiredTools, inferredTools.required_tools);
    const preferredTools = withoutToolNames(mergeToolNames(explicitPreferredTools, inferredTools.preferred_tools), requiredTools);
    const disabledReason = nullableSanitizedText(record.disabled_reason);
    const action: ArchitectRecommendedAction = {
      id,
      label,
      rationale,
      kind: normalizeActionKind(record.kind),
      prompt,
      safe: record.safe === false ? false : true,
      recommended: record.recommended === true,
      required_tools: requiredTools,
      preferred_tools: preferredTools,
      disabled_reason: disabledReason,
    };
    seen.add(id);
    actions.push(action);
  }

  if (actions.filter((action) => action.recommended).length > 1) {
    let recommendedSeen = false;
    for (const action of actions) {
      if (!action.recommended) continue;
      if (!recommendedSeen) {
        recommendedSeen = true;
      } else {
        action.recommended = false;
        diagnostics.push(`recommended_action_unmarked_extra_recommendation: ${action.id}`);
      }
    }
  }

  return actions;
}

function synthesizeLegacyContinuationActions(record: Record<string, unknown>, diagnostics: string[]): ArchitectRecommendedAction[] {
  const complete = record.complete === true ? true : record.complete === false ? false : null;
  const nextRequiredAction = stringValue(firstPresent(record.next_required_action, record.nextRequiredAction));
  const nextRequiredActionList = sanitizeTextList(firstPresent(record.pending_slices, record.pendingSlices));
  if (complete !== false && !nextRequiredAction && nextRequiredActionList.length === 0) {
    return [];
  }

  const prompt = sanitizeText(nextRequiredAction || "Continue the remaining documented work sequentially under governed DreamGraph MCP authority.", 2_000);
  const label = sanitizeText(prompt.split("\n")[0] || "Continue remaining work", 80);
  const inferredTools = inferContinuationTools([label, prompt, ...nextRequiredActionList]);
  diagnostics.push("recommended_actions_synthesized_from_legacy_report");
  return [{
    id: "continue-from-legacy-report",
    label,
    rationale: "The assistant returned a noncanonical continuation report that says work remains but omitted recommended_actions.",
    kind: "continue",
    prompt,
    safe: true,
    recommended: true,
    required_tools: inferredTools.required_tools,
    preferred_tools: inferredTools.preferred_tools,
    disabled_reason: null,
  }];
}

function selectContinuationAction(actions: ArchitectRecommendedAction[], selectedActionId?: string | null): ArchitectRecommendedAction | null {
  const candidates = actions.filter((action) => action.safe && !action.disabled_reason);
  if (selectedActionId) {
    return candidates.find((action) => action.id === selectedActionId) ?? null;
  }
  return candidates.find((action) => action.recommended) ?? candidates[0] ?? null;
}

function stoppedDecision(
  reason: string,
  report: ArchitectPassReport,
  diagnostics: string[],
  context: ArchitectContinuationContext,
  completedPasses: number,
  maxPasses: number,
  selectedAction: ArchitectRecommendedAction | null = null,
): ArchitectContinuationDecision {
  const state = buildContinuationState({
    context,
    report,
    selectedAction,
    completedPasses,
    maxPasses,
    stopped: true,
    reason,
    diagnostics,
  });
  return {
    status: "stopped",
    reason,
    report,
    continuation_token: encodeArchitectContinuationToken(state),
    selected_action: selectedAction,
    tool_manifest: selectedAction ? buildArchitectContinuationToolManifest(selectedAction) : null,
  };
}

function buildContinuationState(input: {
  context: ArchitectContinuationContext;
  report: ArchitectPassReport;
  selectedAction: ArchitectRecommendedAction | null;
  completedPasses: number;
  maxPasses: number;
  stopped: boolean;
  reason: string | null;
  diagnostics: string[];
}): ArchitectContinuationState {
  const selectedAction = input.selectedAction;
  const selectedManifest = selectedAction ? buildArchitectContinuationToolManifest(selectedAction) : null;
  return {
    version: CONTINUATION_TOKEN_VERSION,
    selected_plan_id: input.context.selected_plan_id,
    chat_scope: input.context.chat_scope,
    previous_pass_report_id: input.report.id,
    pass_id: input.report.pass_id,
    recommended_actions: input.report.continuation_options,
    selected_action_id: selectedAction?.id ?? null,
    required_tools: selectedManifest?.required_tools ?? [],
    preferred_tools: selectedManifest?.preferred_tools ?? [],
    budget: {
      completed_passes: input.completedPasses,
      max_passes: input.maxPasses,
    },
    stop_context: {
      stopped: input.stopped,
      reason: input.reason,
      diagnostics: [...input.diagnostics],
    },
  };
}

function diagnosticReport(passId: string, summary: string, diagnostics: string[], now = new Date()): ArchitectPassReport {
  const envelope: ArchitectContinuationEnvelope = {
    schema: ARCHITECT_CONTINUATION_SCHEMA,
    pass_id: passId,
    status: "failed",
    summary,
    work_completed: [],
    files_touched: [],
    graph_entities_touched: [],
    tool_trace_summary: [],
    graph_plan_updates: [],
    evidence: [],
    blockers: diagnostics,
    uncertainty: 1,
    stop_reason: diagnostics[0] ?? "invalid_continuation_envelope",
    recommended_actions: [],
  };
  return buildArchitectPassReport(envelope, diagnostics, now);
}

function normalizeToolNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return mergeToolNames(value.filter((item): item is string => typeof item === "string"));
}

function inferContinuationTools(parts: readonly string[]): ArchitectContinuationToolManifest {
  return buildArchitectToolManifestFromText(parts);
}

function mergeToolNames(...groups: readonly (readonly string[])[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const item of group) {
      const normalized = normalizeArchitectContinuationToolName(item);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      names.push(normalized);
      if (names.length >= MAX_TOOLS) return names;
    }
  }
  return names;
}

function withoutToolNames(names: readonly string[], excluded: readonly string[]): string[] {
  const blocked = new Set(excluded);
  return names.filter((name) => !blocked.has(name));
}

function sanitizeTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => sanitizeTextListItem(item))
    .filter(Boolean)
    .slice(0, 50);
}

function sanitizeTextListItem(item: unknown): string {
  if (typeof item === "string") return sanitizeText(item);
  const record = asRecord(item);
  if (!record) return "";
  const primary = stringValue(firstPresent(record.item, record.detail, record.summary, record.action, record.label, record.title, record.path, record.file));
  const source = stringValue(firstPresent(record.source, record.filePath, record.file_path));
  if (source && primary) return sanitizeText(`${source}: ${primary}`);
  return primary ? sanitizeText(primary) : "";
}

function sanitizeText(value: string, max = MAX_TEXT): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function nullableSanitizedText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const sanitized = sanitizeText(value);
  return sanitized.length > 0 ? sanitized : null;
}

function sanitizeId(value: string, fallback: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return normalized || fallback;
}

function normalizePassStatus(value: unknown): ArchitectContinuationEnvelope["status"] {
  return value === "blocked" || value === "needs_user_input" || value === "uncertain" || value === "failed" || value === "completed" ? value : "completed";
}

function normalizeActionKind(value: unknown): ArchitectRecommendedAction["kind"] {
  return value === "pause" || value === "stop" || value === "request_user_input" || value === "continue" ? value : "continue";
}

function normalizeUncertainty(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(1, numeric));
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : fallback;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
