import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPlanSummary as buildArchitectPlanSummary,
  getArchitectPlansRoot,
  getArchitectProjectRoot,
  listPlanFiles as listArchitectPlanFiles,
  loadPlanDetail as loadArchitectPlanDetail,
  recordPlanActionAudit,
  type ArchitectPlanActionAuditInput,
  type ArchitectPlanActionKind,
} from "./plan-registry.js";
import { runArchitectCliBridge } from "./cli-bridge.js";
import { runArchitectNativeToolLoop, type ArchitectToolTraceEntry } from "./native-tool-loop.js";
import { buildAdaptiveFutureAuditTrail } from "../cognitive/adaptive-future-scaffold.js";
import {
  createLlmProviderForConfig,
  getArchitectLlmConfig,
  updateArchitectLlmConfig,
  type ArchitectLlmConfig,
  type LlmMessage,
  type LlmProviderType,
} from "../cognitive/llm.js";
import { getScheduleHistory, getSchedules, runScheduleNow, updateSchedule } from "../cognitive/scheduler.js";
import { getActiveScope, isInstanceMode, resolveInstanceAtStartup } from "../instance/lifecycle.js";
import { updateEngineEnvValues } from "../utils/engine-env.js";
import { loadJsonData } from "../utils/cache.js";
import { logger } from "../utils/logger.js";
import type { ADRLogFile, ArchitectureDecisionRecord } from "../types/index.js";

interface ArchitectPlanSummary {
  id: string;
  title: string;
  path: string;
  log_path: string | null;
  status: string | null;
  active_phase: string | null;
  updated_at: string;
  adr_bindings?: string[];
  graph_binding_count?: number;
  slice_count?: number;
  checkpoint_count?: number;
  operational_state?: {
    phase?: string | null;
    current_slice_id?: string | null;
    current_slice_title?: string | null;
    current_status?: string | null;
    plan_lifecycle?: string | null;
    execution_state?: string | null;
    active_phase?: string | null;
    active_slice?: { id?: string | null; title?: string | null; status?: string | null } | null;
    last_completed_slice?: { id?: string | null; title?: string | null; status?: string | null } | null;
    next_slice?: { id?: string | null; title?: string | null; status?: string | null } | null;
    task_memory_binding?: { binding_status?: string | null };
  };
}

interface ArchitectPlanTreeNode {
  id: string;
  title: string;
  status: string | null;
  active_phase: string | null;
  updated_at: string;
  current_slice_id: string | null;
  current_slice_title: string | null;
  current_status: string | null;
  slice_count: number;
  checkpoint_count: number;
  adr_binding_count: number;
  children: Array<{
    id: string;
    title: string;
    kind: "current_slice";
    status: string | null;
  }>;
}

interface ArchitectPlanTreeGroup {
  id: string;
  title: string;
  count: number;
  children: ArchitectPlanTreeNode[];
}

interface ArchitectPlanDetail extends ArchitectPlanSummary {
  markdown: string;
  headings: Array<{ level: number; title: string }>;
  resume_state: {
    last_log_heading: string | null;
    last_resume_note: string | null;
    log_excerpt: string | null;
  };
}

interface ArchitectAdrPreview {
  id: string;
  title: string;
  status: string;
  date: string | null;
  decided_by: string | null;
  decision_summary: string;
  problem_summary: string | null;
  guard_rails: string[];
  superseded_by: string | null;
  deprecated_at: string | null;
  deprecation_reason: string | null;
  tags: string[];
  affected_entities: string[];
  advisory_metadata: {
    source: "adr_log";
    read_model: "daemon_governed_preview";
    hard_enforcement: false;
    guard_rails_advisory: true;
  };
}

interface ArchitectAdrSubroute {
  adrId: string;
  suffix: string | null;
}

interface ArchitectEvent<T = unknown> {
  seq: number;
  kind: string;
  scope: "architect";
  ts: string;
  payload: T;
}

const PLANS_ROOT = resolve(
  fileURLToPath(import.meta.url),
  "..",
  "..",
  "..",
  "plans",
);
const EVENT_RING_SIZE = 128;
const HEARTBEAT_MS = 15_000;
const MAX_JSON_BODY_BYTES = 64 * 1024;
const ARCHITECT_PROVIDER_OPTIONS: LlmProviderType[] = ["openai", "anthropic", "ollama", "lmstudio", "sampling", "none"];
const ARCHITECT_ADAPTER_OPTIONS = ["native_api_tool_loop", "codex-cli", "copilot-cli", "deterministic_fallback"] as const;
const ARCHITECT_AUTONOMY_MODE_OPTIONS = ["autonomous", "supervised", "manual"] as const;
const ARCHITECT_SELECTED_PLAN_ENV_KEY = "DREAMGRAPH_ARCHITECT_SELECTED_PLAN_ID";
type ArchitectAdapterType = typeof ARCHITECT_ADAPTER_OPTIONS[number];
type ArchitectAutonomyMode = typeof ARCHITECT_AUTONOMY_MODE_OPTIONS[number];
type ArchitectExecutionRoute = ArchitectAdapterType;
type ArchitectPassStatus = "idle" | "running" | "partial" | "timed_out" | "complete" | "failed";
type ArchitectChatScope = "plan" | "project";

interface ArchitectSessionPassState {
  completed: number;
  tools: number;
  status: ArchitectPassStatus;
  updated_at: string;
}

interface ActiveArchitectSessionRuntime {
  adapter: ArchitectAdapterType;
  adapter_source: string;
  provider: LlmProviderType;
  provider_source: string;
  model: string;
  model_source: string;
  autonomy_mode: ArchitectAutonomyMode;
  autonomy_source: string;
  pass_state: ArchitectSessionPassState;
  execution_route: ArchitectExecutionRoute;
  session_id: string;
  session_source: "architect";
  provenance_authority: "dreamgraph_mcp";
}

type ArchitectRuntimeRouteContext = ActiveArchitectSessionRuntime;

interface ArchitectPlanChatUpdateResult {
  plan_id: string;
  plan_path: string;
  log_path: string | null;
  changed: true;
  update_mode: "replace_goal_placeholder" | "append_chat_update";
  section_title: string;
  audit_id: string | null;
  runtime: ActiveArchitectSessionRuntime;
}

const ACTIVE_ARCHITECT_SESSION_ID = `architect-${randomUUID()}`;

let nextEventSeq = 0;
const eventRing: ArchitectEvent[] = [];
const subscribers = new Set<(event: ArchitectEvent) => void>();
let instanceBindingRecovery: Promise<void> | null = null;
let activeArchitectPassState: ArchitectSessionPassState = {
  completed: 0,
  tools: 0,
  status: "idle",
  updated_at: new Date().toISOString(),
};

async function ensureArchitectInstanceBinding(): Promise<void> {
  if (getActiveScope() || !process.env.DREAMGRAPH_INSTANCE_UUID) return;

  instanceBindingRecovery ??= resolveInstanceAtStartup()
    .then(() => undefined)
    .catch((error) => {
      logger.warn(`Architect: failed to resolve active instance binding: ${(error as Error).message}`);
    });
  await instanceBindingRecovery;
}

function getInstanceId(): string | null {
  return isInstanceMode() ? getActiveScope()?.uuid ?? null : null;
}

function architectAutonomyModeFromText(value: string | null): ArchitectAutonomyMode | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "autonomous" || normalized === "auto") return "autonomous";
  if (normalized === "supervised") return "supervised";
  if (normalized === "manual") return "manual";
  return null;
}

function architectAutonomyModeField(body: Record<string, unknown>, field: string): ArchitectAutonomyMode | null {
  return architectAutonomyModeFromText(textField(body, field));
}

function getArchitectAutonomyMode(): { mode: ArchitectAutonomyMode; source: "architect" | "default" } {
  const mode = architectAutonomyModeFromText(process.env.DREAMGRAPH_ARCHITECT_AUTONOMY_MODE?.trim() ?? null);
  return mode ? { mode, source: "architect" } : { mode: "autonomous", source: "default" };
}

function selectedPlanIdFromText(value: string | null): string | null {
  const planId = value?.trim();
  return planId && isSafePlanId(planId) ? planId : null;
}

function getArchitectSelectedPlanConfig(): { planId: string | null; source: "architect" | "default" } {
  const planId = selectedPlanIdFromText(process.env[ARCHITECT_SELECTED_PLAN_ENV_KEY]?.trim() ?? null);
  return planId ? { planId, source: "architect" } : { planId: null, source: "default" };
}

function architectChatScopeFromText(value: string | null): ArchitectChatScope | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "plan") return "plan";
  if (normalized === "project" || normalized === "global" || normalized === "repo" || normalized === "ask") return "project";
  return null;
}

function parseArchitectChatSlashScope(message: string): { message: string; scope: ArchitectChatScope | null } {
  const match = message.match(/^\s*\/(ask|global|repo|plan)(?:\s+|$)/i);
  if (!match) return { message, scope: null };
  const command = match[1].toLowerCase();
  return {
    message: message.slice(match[0].length).trim(),
    scope: command === "plan" ? "plan" : "project",
  };
}

function updateActiveArchitectPassState(partial: Partial<Omit<ArchitectSessionPassState, "updated_at">>): ArchitectSessionPassState {
  activeArchitectPassState = {
    ...activeArchitectPassState,
    ...partial,
    updated_at: new Date().toISOString(),
  };
  return activeArchitectPassState;
}

function buildActiveArchitectSessionRuntime(overrides: Partial<Pick<ActiveArchitectSessionRuntime, "adapter" | "provider" | "model" | "autonomy_mode" | "pass_state">> = {}): ActiveArchitectSessionRuntime {
  const architect = getArchitectLlmConfig();
  const adapter = getArchitectAdapterConfig();
  const autonomy = getArchitectAutonomyMode();
  const runtimeAdapter = overrides.adapter ?? adapter.adapter;
  const runtimeProvider = overrides.provider ?? architect.provider;
  const runtimeModel = overrides.model ?? architect.model;
  const runtimeAutonomyMode = overrides.autonomy_mode ?? autonomy.mode;

  return {
    adapter: runtimeAdapter,
    adapter_source: overrides.adapter ? "request" : adapter.source,
    provider: runtimeProvider,
    provider_source: overrides.provider ? "request" : architect.providerSource,
    model: runtimeModel,
    model_source: overrides.model ? "request" : architect.modelSource,
    autonomy_mode: runtimeAutonomyMode,
    autonomy_source: overrides.autonomy_mode ? "request" : autonomy.source,
    pass_state: { ...(overrides.pass_state ?? activeArchitectPassState) },
    execution_route: runtimeAdapter,
    session_id: ACTIVE_ARCHITECT_SESSION_ID,
    session_source: "architect",
    provenance_authority: "dreamgraph_mcp",
  };
}

function buildArchitectRuntimeLabel(runtime: Pick<ActiveArchitectSessionRuntime, "adapter" | "provider" | "model">): string {
  if (runtime.adapter && runtime.adapter !== "native_api_tool_loop") {
    return `${runtime.adapter}/${runtime.model || "none"}`;
  }
  return `${runtime.provider || "none"}/${runtime.model || "none"}`;
}

function buildProjectScopePayload(): Record<string, unknown> {
  const scope = getActiveScope();
  const repos = scope?.repos ?? {};
  const engineEnvPath = scope?.engineEnvPath ?? null;
  const envInstanceUuid = process.env.DREAMGRAPH_INSTANCE_UUID ?? null;
  return {
    mode: scope ? "instance" : "legacy",
    binding_status: scope ? "bound" : envInstanceUuid ? "unresolved_env_uuid" : "legacy_unbound",
    binding_source: scope ? "instance_lifecycle_active_scope" : envInstanceUuid ? "DREAMGRAPH_INSTANCE_UUID" : "none",
    daemon_bound: Boolean(scope?.uuid && scope.instanceRoot),
    instance_id: scope?.uuid ?? envInstanceUuid,
    instance_name: scope?.name ?? null,
    home_dir: scope?.instanceRoot ?? null,
    instance_root: scope?.instanceRoot ?? null,
    master_dir: scope?.masterDir ?? process.env.DREAMGRAPH_MASTER_DIR ?? null,
    config_dir: scope?.configDir ?? null,
    runtime_dir: scope?.runtimeDir ?? null,
    data_dir: scope?.dataDir ?? null,
    logs_dir: scope?.logsDir ?? null,
    engine_env_path: engineEnvPath,
    engine_env_exists: engineEnvPath ? existsSync(engineEnvPath) : false,
    config_source: engineEnvPath ? "active_scope.engineEnvPath" : null,
    project_root: getArchitectProjectRoot(),
    project_root_source: scope?.projectRoot ? "instance.project_root" : scope ? "project_root_fallback" : "repository_fallback_no_active_scope",
    plans_root: getArchitectPlansRoot(),
    project_bound: Boolean(scope?.projectRoot),
    repos,
    repo_count: Object.keys(repos).length,
  };
}

function buildArchitectLlmPayload(runtime: ActiveArchitectSessionRuntime = buildActiveArchitectSessionRuntime()): Record<string, unknown> {
  return {
    adapter: runtime.adapter,
    adapter_source: runtime.adapter_source,
    provider: runtime.provider,
    provider_source: runtime.provider_source,
    model: runtime.model,
    model_source: runtime.model_source,
    fallback_order: ["architect", "general", "normalizer", "dreamer"],
    temperature: getArchitectLlmConfig().temperature,
    max_tokens: getArchitectLlmConfig().maxTokens,
    base_url: getArchitectLlmConfig().baseUrl,
    autonomy_mode: runtime.autonomy_mode,
    execution_route: runtime.execution_route,
    session_id: runtime.session_id,
    provenance_authority: runtime.provenance_authority,
  };
}

function buildArchitectStatusPayload(): Record<string, unknown> {
  const runtime = buildActiveArchitectSessionRuntime();
  return {
    contract_version: "v1",
    shell_path: "/architect",
    api_base: "/api/architect/v1",
    phase: "project-bound-architect-chat-control-plane",
    status: "ready",
    mutation_endpoints_enabled: true,
    cognitive_operations_enabled: true,
    auth_scope: "daemon-inherited-loopback",
    audit_mode: "governed_plan_log",
    project_scope: buildProjectScopePayload(),
    runtime,
    architect_runtime: runtime,
    architect_llm: buildArchitectLlmPayload(runtime),
    browser_surface: {
      theme: "dark",
      mobile_usable: true,
      primary_interaction: "architect_chat",
      preserved_routes: ["/", "/explorer", "/architect"],
    },
    routes: {
      chat: "/api/architect/v1/chat",
      chat_method: "POST",
      chat_request_content_type: "application/json",
      chat_response_transports: ["application/json", "text/event-stream"],
      config: "POST /api/architect/v1/config",
      plans: "/api/architect/v1/plans",
      plan_create: "POST /api/architect/v1/plans",
      plan_archive: "POST /api/architect/v1/plans/{planId}/archive",
      plan_detail: "/api/architect/v1/plans/{planId}",
      plan_actions: "POST /api/architect/v1/plans/{planId}/actions",
      future_review: "/api/architect/v1/plans/{planId}/future-review",
      review_gates: "POST /api/architect/v1/plans/{planId}/review-gates",
      schedules: "/api/architect/v1/schedules",
      schedule_actions: "POST /api/architect/v1/schedules/{scheduleId}/actions",
      adrs: "/api/architect/v1/adrs",
      adr_preview: "/api/architect/v1/adrs/{adrId}",
      adr_edit_proposal: "POST /api/architect/v1/adrs/{adrId}/edits",
      events: "/api/architect/v1/events",
      event_transport: "text/event-stream",
    },
    adaptive_future_projection: {
      advisory: true,
      persistence: "plan_bound_review_record",
      fallback_visible: true,
      review_decisions: ["accept", "reject", "defer", "supersede"],
      adr_guard_rails: ["ADR-203", "ADR-204", "ADR-214"],
    },
    vscode_interop: {
      companion_surface: true,
      deep_links: true,
      command_bridge: false,
      cutover_requires_superseding_adr: true,
      governing_adrs: ["ADR-206", "ADR-207", "ADR-210", "ADR-211", "ADR-212", "ADR-214"],
    },
  };
}

function publishEvent(kind: string, payload: unknown): ArchitectEvent {
  const event: ArchitectEvent = {
    seq: ++nextEventSeq,
    kind,
    scope: "architect",
    ts: new Date().toISOString(),
    payload,
  };

  eventRing.push(event);
  if (eventRing.length > EVENT_RING_SIZE) {
    eventRing.shift();
  }

  for (const subscriber of subscribers) {
    try {
      subscriber(event);
    } catch (error) {
      logger.warn(`architect subscriber failed (${kind}): ${(error as Error).message}`);
    }
  }

  return event;
}

function replayEvents(sinceSeq: number): ArchitectEvent[] {
  if (sinceSeq <= 0) return [...eventRing];
  return eventRing.filter((event) => event.seq > sinceSeq);
}

function subscribe(listener: (event: ArchitectEvent) => void): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

publishEvent("architect.status", buildArchitectStatusPayload());
const heartbeat = setInterval(() => {
  publishEvent("architect.noop", {
    ...buildArchitectStatusPayload(),
    status: "idle",
    note: "Project-bound Architect chat and plan controls are live; browser requests stay daemon-scoped to the active instance and attached project root.",
  });
}, HEARTBEAT_MS);
if (typeof heartbeat.unref === "function") {
  heartbeat.unref();
}

function json(res: ServerResponse, statusCode: number, body: unknown, headers?: Record<string, string>): void {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function html(res: ServerResponse, statusCode: number, body: string): void {
  res.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

function jsonError(res: ServerResponse, statusCode: number, code: string, message: string): void {
  json(res, statusCode, { ok: false, error: code, message });
}

function computeEtag(input: string): string {
  const digest = createHash("sha256").update(input).digest("hex");
  return `"sha256-${digest.slice(0, 20)}"`;
}

function sendJsonWithEtag(req: IncomingMessage, res: ServerResponse, payload: unknown): void {
  const body = JSON.stringify(payload);
  const etag = computeEtag(body);
  const incoming = req.headers["if-none-match"];
  if (typeof incoming === "string" && incoming === etag) {
    res.writeHead(304, { ETag: etag });
    res.end();
    return;
  }

  json(res, 200, payload, {
    ETag: etag,
    "Cache-Control": "no-cache",
  });
}

function isSafePlanId(planId: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(planId) &&
    planId !== "." &&
    planId !== ".." &&
    !planId.endsWith(".implementation-log")
  );
}

function normalizePlanTitle(value: string | null): string {
  const compact = (value ?? "").replace(/\s+/g, " ").trim();
  return compact.length > 0 ? compact.slice(0, 120) : "Untitled Architect Plan";
}

function slugifyPlanId(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 80);
  return slug.length > 0 ? slug : "architect-plan";
}

async function pickAvailablePlanId(baseId: string): Promise<string> {
  const plansRoot = getArchitectPlansRoot();
  let candidate = baseId;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const planPath = resolve(plansRoot, `${candidate}.md`);
    const logPath = resolve(plansRoot, `${candidate}.implementation-log.md`);
    if (!existsSync(planPath) && !existsSync(logPath)) return candidate;
    candidate = `${baseId}-${suffix}`;
  }
  throw new Error("Unable to allocate a unique Architect plan id");
}

function buildCreatedPlanMarkdown(planId: string, title: string, timestamp: string): string {
  return [
    `# ${title}`,
    "",
    "Status: Draft",
    "Scope: standalone Architect plan created through the daemon-governed browser surface",
    "",
    "## 0. Goal",
    "",
    "Describe the goal for this Architect plan.",
    "",
    "## 1. Implementation Notes",
    "",
    `Created: ${timestamp}`,
    `Plan id: \`${planId}\``,
    "",
  ].join("\n");
}

function buildCreatedPlanLog(planId: string, title: string, timestamp: string): string {
  return [
    `# ${title} Implementation Log`,
    "",
    `### ${timestamp} - slice: plan-created - status: created`,
    "",
    `- Plan id: \`${planId}\``,
    "- Actor/session id: `standalone-architect-browser`",
    "- Action: created plan through daemon-governed `/api/architect/v1/plans` endpoint",
    "- Result: markdown plan and appendable implementation log created under the active project `plans/` folder",
    "- Resume note: continue by selecting the plan in the standalone Architect plan rail",
    "",
  ].join("\n");
}

function isArchitectRuntimeIdentityQuestion(message: string): boolean {
  return /\b(model|provider|adapter|runtime|route|session)\b/i.test(message);
}

function shouldApplyPlanChatUpdate(message: string, plan: ArchitectPlanProjection | null): boolean {
  if (!plan || isArchitectRuntimeIdentityQuestion(message)) return false;
  const compact = message.trim();
  if (!compact) return false;
  if (/(^|\n)\s*[-*]\s+\S/.test(compact)) return true;
  return /\b(this plan should|plan should|add|append|include|update|change|design|requirements?|features?|needed|needs|must)\b/i.test(compact);
}

function normalizePlanChatUpdateContent(message: string): string {
  return message
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\0/g, "")
    .trim()
    .slice(0, 24_000);
}

function applyPlanChatUpdateToMarkdown(markdown: string, content: string, timestamp: string): { markdown: string; mode: ArchitectPlanChatUpdateResult["update_mode"]; sectionTitle: string } {
  const placeholder = "Describe the goal for this Architect plan.";
  if (markdown.includes(placeholder)) {
    return {
      markdown: markdown.replace(placeholder, content),
      mode: "replace_goal_placeholder",
      sectionTitle: "0. Goal",
    };
  }

  const sectionTitle = `Chat Update - ${timestamp}`;
  const nextMarkdown = [
    markdown.trimEnd(),
    "",
    `## ${sectionTitle}`,
    "",
    "Captured from standalone Architect chat:",
    "",
    content,
    "",
  ].join("\n");
  return { markdown: nextMarkdown, mode: "append_chat_update", sectionTitle };
}

async function applyPlanChatUpdate(
  plan: ArchitectPlanProjection,
  message: string,
  runtime: ActiveArchitectSessionRuntime,
): Promise<ArchitectPlanChatUpdateResult | null> {
  const content = normalizePlanChatUpdateContent(message);
  if (!content) return null;

  const timestamp = new Date().toISOString();
  const planPath = resolve(getArchitectPlansRoot(), `${plan.id}.md`);
  const currentMarkdown = await readFile(planPath, "utf-8");
  const update = applyPlanChatUpdateToMarkdown(currentMarkdown, content, timestamp);
  if (update.markdown === currentMarkdown) return null;

  await writeFile(planPath, update.markdown, "utf-8");
  const audit = await recordPlanActionAudit(plan.id, {
    kind: "plan_action",
    action: "chat_plan_update",
    audit_reason: "Operator chat request applied to the selected plan markdown by the daemon-governed Architect chat endpoint.",
    actor: "standalone-architect-browser",
    slice_id: "standalone-architect-chat-plan-update",
    evidence: `runtime=${runtime.adapter}/${runtime.provider}/${runtime.model || "none"}; session=${runtime.session_id}`,
    content,
  });

  return {
    plan_id: plan.id,
    plan_path: plan.path,
    log_path: audit?.log_path ?? plan.log_path,
    changed: true,
    update_mode: update.mode,
    section_title: update.sectionTitle,
    audit_id: audit?.audit_id ?? null,
    runtime,
  };
}

function parseFirstMatch(markdown: string, pattern: RegExp): string | null {
  const match = markdown.match(pattern);
  return match?.[1]?.trim() ?? null;
}

function parseHeadings(markdown: string): Array<{ level: number; title: string }> {
  return Array.from(markdown.matchAll(/^(#{1,3})\s+(.+)$/gm)).map((match) => ({
    level: match[1].length,
    title: match[2].trim(),
  }));
}

function extractLastLogHeading(logMarkdown: string): string | null {
  const matches = Array.from(logMarkdown.matchAll(/^###\s+(.+)$/gm));
  return matches.length > 0 ? matches[matches.length - 1][1].trim() : null;
}

function extractLastResumeNote(logMarkdown: string): string | null {
  const matches = Array.from(logMarkdown.matchAll(/^- Resume note:\s*(.+)$/gm));
  return matches.length > 0 ? matches[matches.length - 1][1].trim() : null;
}

function extractLogExcerpt(logMarkdown: string): string | null {
  const lines = logMarkdown.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return null;
  return lines.slice(-8).join("\n");
}

async function loadOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

async function listPlanFiles(): Promise<string[]> {
  const entries = await readdir(PLANS_ROOT, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".md") && !name.endsWith(".implementation-log.md"))
    .sort((a, b) => a.localeCompare(b));
}

async function buildPlanSummary(fileName: string): Promise<ArchitectPlanSummary> {
  const planPath = resolve(PLANS_ROOT, fileName);
  const markdown = await readFile(planPath, "utf-8");
  const fileStat = await stat(planPath);
  const id = basename(fileName, ".md");
  const logPath = `${id}.implementation-log.md`;
  const logMarkdown = await loadOptionalFile(resolve(PLANS_ROOT, logPath));

  return {
    id,
    title: parseFirstMatch(markdown, /^#\s+(.+)$/m) ?? id,
    path: `plans/${fileName}`,
    log_path: logMarkdown == null ? null : `plans/${logPath}`,
    status: parseFirstMatch(markdown, /^- Status:\s+`([^`]+)`$/m),
    active_phase: parseFirstMatch(markdown, /^- Active phase:\s+`([^`]+)`$/m),
    updated_at: fileStat.mtime.toISOString(),
  };
}

async function loadPlanDetail(planId: string): Promise<ArchitectPlanDetail | null> {
  if (!isSafePlanId(planId)) return null;

  const fileName = `${planId}.md`;
  const planPath = resolve(PLANS_ROOT, fileName);
  let markdown: string;
  try {
    markdown = await readFile(planPath, "utf-8");
  } catch {
    return null;
  }

  const summary = await buildPlanSummary(fileName);
  const logPath = resolve(PLANS_ROOT, `${planId}.implementation-log.md`);
  const logMarkdown = await loadOptionalFile(logPath);

  return {
    ...summary,
    markdown,
    headings: parseHeadings(markdown),
    resume_state: {
      last_log_heading: logMarkdown == null ? null : extractLastLogHeading(logMarkdown),
      last_resume_note: logMarkdown == null ? null : extractLastResumeNote(logMarkdown),
      log_excerpt: logMarkdown == null ? null : extractLogExcerpt(logMarkdown),
    },
  };
}

function buildMeta(): Record<string, unknown> {
  const runtime = buildActiveArchitectSessionRuntime();
  const selection = getArchitectSelectedPlanConfig();
  return {
    generated_at: new Date().toISOString(),
    instance_id: getInstanceId(),
    project_scope: buildProjectScopePayload(),
    runtime,
    architect_runtime: runtime,
    architect_llm: buildArchitectLlmPayload(runtime),
    selected_plan_id: selection.planId,
    architect_selection: {
      selected_plan_id: selection.planId,
      source: selection.source,
      env_key: ARCHITECT_SELECTED_PLAN_ENV_KEY,
    },
    auth_scope: "daemon-inherited-loopback",
    audit_mode: "governed_plan_log",
    mutation_endpoints_enabled: true,
  };
}

function parseArchitectPlanSubroute(pathname: string): { planId: string; suffix: string | null } | null {
  const base = "/api/architect/v1/plans/";
  if (!pathname.startsWith(base)) return null;
  const remainder = pathname.slice(base.length);
  if (!remainder) return { planId: "", suffix: null };
  const [encodedPlanId, ...rest] = remainder.split("/");
  return {
    planId: decodeURIComponent(encodedPlanId),
    suffix: rest.length > 0 ? rest.join("/") : null,
  };
}

function parseArchitectAdrSubroute(pathname: string): ArchitectAdrSubroute | null {
  const base = "/api/architect/v1/adrs/";
  if (!pathname.startsWith(base)) return null;
  const remainder = pathname.slice(base.length);
  if (!remainder) return { adrId: "", suffix: null };
  const [encodedAdrId, ...rest] = remainder.split("/");
  return {
    adrId: decodeURIComponent(encodedAdrId),
    suffix: rest.length > 0 ? rest.join("/") : null,
  };
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_JSON_BODY_BYTES) {
      throw new Error("body_too_large");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("bad_json");
  }
  return parsed as Record<string, unknown>;
}

function textField(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function optionalTextField(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  return typeof value === "string" ? value.trim() : null;
}

function architectProviderField(body: Record<string, unknown>, field: string): LlmProviderType | null {
  const value = textField(body, field);
  if (!value) return null;
  return ARCHITECT_PROVIDER_OPTIONS.includes(value as LlmProviderType) ? (value as LlmProviderType) : null;
}

function architectAdapterFromText(value: string | null): ArchitectAdapterType | null {
  if (!value) return null;
  return ARCHITECT_ADAPTER_OPTIONS.includes(value as ArchitectAdapterType) ? (value as ArchitectAdapterType) : null;
}

function architectAdapterField(body: Record<string, unknown>, field: string): ArchitectAdapterType | null {
  return architectAdapterFromText(textField(body, field));
}

function getArchitectAdapterConfig(): { adapter: ArchitectAdapterType; source: "architect" | "default" } {
  const adapter = architectAdapterFromText(process.env.DREAMGRAPH_LLM_ARCHITECT_ADAPTER?.trim() ?? null);
  return adapter ? { adapter, source: "architect" } : { adapter: "native_api_tool_loop", source: "default" };
}

function buildArchitectLlmRequestConfig(body: Record<string, unknown>): ArchitectLlmConfig {
  const base = getArchitectLlmConfig();
  const provider = architectProviderField(body, "provider") ?? architectProviderField(body, "architect_provider") ?? base.provider;
  const model = textField(body, "model") ?? textField(body, "architect_model") ?? base.model;
  const baseUrl = textField(body, "base_url") ?? textField(body, "baseUrl") ?? base.baseUrl;

  return {
    ...base,
    provider,
    providerSource: provider === base.provider ? base.providerSource : "architect",
    model,
    modelSource: model === base.model ? base.modelSource : "architect",
    baseUrl,
  };
}

function buildPlanActionInput(
  kind: ArchitectPlanActionKind,
  body: Record<string, unknown>,
): ArchitectPlanActionAuditInput | { error: string; message: string } {
  const action = textField(body, "action") ?? (kind === "review_gate" ? textField(body, "operation") : null);
  const auditReason = textField(body, "audit_reason") ?? textField(body, "reason");
  if (!action) {
    return { error: "bad_request", message: "Missing action" };
  }
  if (!auditReason) {
    return { error: "bad_request", message: "Missing audit_reason" };
  }

  return {
    kind,
    action,
    audit_reason: auditReason,
    actor: textField(body, "actor"),
    slice_id: textField(body, "slice_id"),
    gate_id: textField(body, "gate_id"),
    decision: textField(body, "decision"),
    evidence: textField(body, "evidence"),
    content: textField(body, "content"),
  };
}

async function handlePlanActionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  planId: string,
  kind: ArchitectPlanActionKind,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const message = (error as Error).message;
    if (message === "body_too_large") {
      jsonError(res, 413, "body_too_large", "Architect plan action payload is too large");
      return;
    }
    jsonError(res, 400, "bad_json", "Expected a JSON object request body");
    return;
  }

  const input = buildPlanActionInput(kind, body);
  if ("error" in input) {
    jsonError(res, 400, input.error, input.message);
    return;
  }

  const result = await recordPlanActionAudit(planId, input);
  if (!result) {
    jsonError(res, 404, "not_found", `No Architect plan with id: ${planId}`);
    return;
  }

  publishEvent(kind === "review_gate" ? "architect.review_gate" : "architect.plan_action", result);
  json(res, 200, {
    ok: true,
    contract: "architect",
    version: "v1",
    ...buildMeta(),
    result,
  });
}

function normalizePlanGroupTitle(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function derivePlanGroup(plan: ArchitectPlanSummary): { id: string; title: string } {
  const raw = plan.id || plan.title || "plans";
  const prefix = raw.split(/[._-]/).find((part) => part.length >= 3) ?? "plans";
  const id = prefix.toLowerCase();
  return { id, title: normalizePlanGroupTitle(id) || "Plans" };
}

function buildPlanTreeProjection(plans: ArchitectPlanSummary[]): ArchitectPlanTreeGroup[] {
  const groups = new Map<string, ArchitectPlanTreeGroup>();
  for (const plan of plans) {
    const groupInfo = derivePlanGroup(plan);
    const group = groups.get(groupInfo.id) ?? { id: groupInfo.id, title: groupInfo.title, count: 0, children: [] };
    const operational = plan.operational_state ?? {};
    const currentSliceId = operational.current_slice_id ?? null;
    const currentSliceTitle = operational.current_slice_title ?? null;
    group.children.push({
      id: plan.id,
      title: plan.title || plan.id,
      status: operational.plan_lifecycle ?? plan.status ?? null,
      active_phase: plan.active_phase ?? operational.active_phase ?? operational.phase ?? null,
      updated_at: plan.updated_at,
      current_slice_id: currentSliceId,
      current_slice_title: currentSliceTitle,
      current_status: operational.current_status ?? null,
      slice_count: plan.slice_count ?? 0,
      checkpoint_count: plan.checkpoint_count ?? 0,
      adr_binding_count: plan.adr_bindings?.length ?? 0,
      children: currentSliceId || currentSliceTitle ? [{
        id: currentSliceId ?? `${plan.id}:current-slice`,
        title: currentSliceTitle ?? currentSliceId ?? "Current slice",
        kind: "current_slice",
        status: operational.current_status ?? null,
      }] : [],
    });
    group.count = group.children.length;
    groups.set(group.id, group);
  }

  return Array.from(groups.values())
    .sort((left, right) => left.title.localeCompare(right.title))
    .map((group) => ({
      ...group,
      children: group.children.sort((left, right) => left.title.localeCompare(right.title)),
    }));
}

function buildPlanFilterProjection(plans: ArchitectPlanSummary[]): Record<string, unknown> {
  const statuses = new Set<string>();
  const phases = new Set<string>();
  for (const plan of plans) {
    if (plan.status) statuses.add(plan.status);
    if (plan.operational_state?.plan_lifecycle) statuses.add(plan.operational_state.plan_lifecycle);
    if (plan.active_phase) phases.add(plan.active_phase);
    if (plan.operational_state?.active_phase) phases.add(plan.operational_state.active_phase);
    if (plan.operational_state?.phase) phases.add(plan.operational_state.phase);
  }
  return {
    source: "daemon_projection",
    state_owner: "browser_ui_local",
    status_options: Array.from(statuses).sort((left, right) => left.localeCompare(right)),
    phase_options: Array.from(phases).sort((left, right) => left.localeCompare(right)),
  };
}

function emptyAdrLog(): ADRLogFile {
  return {
    metadata: {
      description: "Architecture Decision Records",
      schema_version: "",
      total_decisions: 0,
      last_updated: null,
    },
    decisions: [],
  };
}

async function loadArchitectAdrLog(): Promise<ADRLogFile> {
  const scopeDataDir = getActiveScope()?.dataDir;
  try {
    const log = scopeDataDir
      ? JSON.parse(await readFile(resolve(scopeDataDir, "adr_log.json"), "utf-8")) as ADRLogFile
      : await loadJsonData<ADRLogFile>("adr_log.json");
    return {
      metadata: { ...emptyAdrLog().metadata, ...(log.metadata ?? {}) },
      decisions: Array.isArray(log.decisions) ? log.decisions : [],
    };
  } catch {
    return emptyAdrLog();
  }
}

function summarizeAdrText(value: unknown, limit = 220): string | null {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3)).trim()}...` : text;
}

function buildAdrPreview(decision: ArchitectureDecisionRecord): ArchitectAdrPreview {
  return {
    id: decision.id,
    title: decision.title,
    status: decision.status,
    date: decision.date ?? null,
    decided_by: decision.decided_by ?? null,
    decision_summary: summarizeAdrText(decision.decision?.chosen) ?? "No decision summary recorded.",
    problem_summary: summarizeAdrText(decision.context?.problem) ?? null,
    guard_rails: Array.isArray(decision.guard_rails) ? decision.guard_rails.slice(0, 8) : [],
    superseded_by: decision.superseded_by ?? null,
    deprecated_at: decision.deprecated_at ?? null,
    deprecation_reason: decision.deprecation_reason ?? null,
    tags: Array.isArray(decision.tags) ? decision.tags : [],
    affected_entities: Array.isArray(decision.context?.affected_entities) ? decision.context.affected_entities : [],
    advisory_metadata: {
      source: "adr_log",
      read_model: "daemon_governed_preview",
      hard_enforcement: false,
      guard_rails_advisory: true,
    },
  };
}

async function handleAdrIndex(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const log = await loadArchitectAdrLog();
  const adrs = log.decisions.map(buildAdrPreview);
  sendJsonWithEtag(req, res, {
    ok: true,
    contract: "architect",
    version: "v1",
    ...buildMeta(),
    adr_surface: {
      source: "daemon_governed_adr_log",
      read_only: true,
      direct_browser_filesystem_access: false,
      total: adrs.length,
    },
    adrs,
  });
}

async function handleAdrPreview(req: IncomingMessage, res: ServerResponse, adrId: string): Promise<void> {
  const normalizedId = adrId.trim().toUpperCase();
  if (!/^ADR-\d{3,}$/.test(normalizedId)) {
    jsonError(res, 400, "bad_request", "Invalid ADR id");
    return;
  }
  const log = await loadArchitectAdrLog();
  const decision = log.decisions.find((candidate) => candidate.id.toUpperCase() === normalizedId);
  if (!decision) {
    jsonError(res, 404, "not_found", `No ADR with id: ${normalizedId}`);
    return;
  }
  sendJsonWithEtag(req, res, {
    ok: true,
    contract: "architect",
    version: "v1",
    ...buildMeta(),
    adr: buildAdrPreview(decision),
    full_content: decision,
    editor_contract: buildAdrEditorContract(normalizedId),
  });
}

function buildAdrEditorContract(adrId: string): Record<string, unknown> {
  return {
    mode: "proposal_only",
    endpoint: `/api/architect/v1/adrs/${encodeURIComponent(adrId)}/edits`,
    method: "POST",
    mutation_authority: "daemon_governed_plan_log",
    direct_browser_filesystem_access: false,
    applies_directly: false,
    review_model: "plan_action_audit_then_keep_undo_review",
    guard_rails: [
      "Accepted ADR content is not silently overwritten from the browser.",
      "ADR edit submissions are recorded as audited proposals against the selected plan.",
      "Guard-rail warnings must remain visible before any follow-on mutation/review flow applies a change.",
    ],
  };
}

function stringArrayField(body: Record<string, unknown>, field: string): string[] | null {
  const value = body[field];
  if (!Array.isArray(value)) return null;
  return value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean);
}

async function handleAdrEditProposal(req: IncomingMessage, res: ServerResponse, adrId: string): Promise<void> {
  const normalizedId = adrId.trim().toUpperCase();
  if (!/^ADR-\d{3,}$/.test(normalizedId)) {
    jsonError(res, 400, "bad_request", "Invalid ADR id");
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const message = (error as Error).message;
    if (message === "body_too_large") {
      jsonError(res, 413, "body_too_large", "ADR edit proposal payload is too large");
      return;
    }
    jsonError(res, 400, "bad_json", "Expected a JSON object request body");
    return;
  }

  const planId = textField(body, "plan_id") ?? textField(body, "planId");
  if (!planId || !isSafePlanId(planId)) {
    jsonError(res, 400, "bad_request", "ADR edit proposals require a selected safe plan_id for audit binding");
    return;
  }

  const log = await loadArchitectAdrLog();
  const decision = log.decisions.find((candidate) => candidate.id.toUpperCase() === normalizedId);
  if (!decision) {
    jsonError(res, 404, "not_found", `No ADR with id: ${normalizedId}`);
    return;
  }

  const proposed = {
    id: decision.id,
    title: textField(body, "title") ?? decision.title,
    status: textField(body, "status") ?? decision.status,
    decision_summary: textField(body, "decision_summary") ?? decision.decision?.chosen ?? "",
    problem_summary: optionalTextField(body, "problem_summary") ?? decision.context?.problem ?? "",
    guard_rails: stringArrayField(body, "guard_rails") ?? decision.guard_rails ?? [],
    tags: stringArrayField(body, "tags") ?? decision.tags ?? [],
  };
  const changedFields = [
    proposed.title !== decision.title ? "title" : null,
    proposed.status !== decision.status ? "status" : null,
    proposed.decision_summary !== (decision.decision?.chosen ?? "") ? "decision_summary" : null,
    proposed.problem_summary !== (decision.context?.problem ?? "") ? "problem_summary" : null,
    JSON.stringify(proposed.guard_rails) !== JSON.stringify(decision.guard_rails ?? []) ? "guard_rails" : null,
    JSON.stringify(proposed.tags) !== JSON.stringify(decision.tags ?? []) ? "tags" : null,
  ].filter((field): field is string => Boolean(field));

  if (changedFields.length === 0) {
    jsonError(res, 400, "bad_request", "ADR edit proposal does not change any editable field");
    return;
  }

  const warnings = [
    "ADR edit captured as a proposal only; adr_log.json was not modified by this browser request.",
    decision.status === "accepted" ? "Accepted ADR content changes require explicit governed review before apply." : null,
    proposed.status !== decision.status ? "Status changes should use ADR deprecation/supersession semantics where applicable." : null,
    proposed.guard_rails.length === 0 ? "Proposal removes all guard rails from this ADR." : null,
  ].filter((warning): warning is string => Boolean(warning));

  const audit = await recordPlanActionAudit(planId, {
    kind: "plan_action",
    action: "adr_edit_proposal",
    audit_reason: textField(body, "audit_reason") ?? `ADR edit proposal recorded for ${normalizedId} from standalone Architect editor.`,
    actor: textField(body, "actor") ?? "standalone-architect-browser",
    slice_id: textField(body, "slice_id") ?? "slice-3-adr-editor-surfaces-governed-mutation-path",
    evidence: `ADR ${normalizedId}; changed fields: ${changedFields.join(", ")}`,
    content: JSON.stringify({ adr_id: normalizedId, changed_fields: changedFields, proposed, warnings }).slice(0, 6000),
  });
  if (!audit) {
    jsonError(res, 404, "not_found", `No Architect plan with id: ${planId}`);
    return;
  }

  const result = {
    adr_id: normalizedId,
    plan_id: planId,
    status: "proposal_recorded",
    changed: false,
    changed_fields: changedFields,
    proposed,
    audit_id: audit.audit_id,
    audit_scope: "daemon_governed_adr_edit_proposal",
    guard_rail_warnings: warnings,
    editor_contract: buildAdrEditorContract(normalizedId),
  };
  publishEvent("architect.adr_edit_proposal", result);
  json(res, 202, {
    ok: true,
    contract: "architect",
    version: "v1",
    ...buildMeta(),
    result,
  });
}

async function handlePlansIndex(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const plans = await Promise.all(
    (await listArchitectPlanFiles()).map((fileName) => buildArchitectPlanSummary(fileName)),
  );
  sendJsonWithEtag(req, res, {
    ok: true,
    contract: "architect",
    version: "v1",
    ...buildMeta(),
    plans,
    plan_tree: buildPlanTreeProjection(plans),
    plan_filters: buildPlanFilterProjection(plans),
  });
}

async function handlePlanCreateRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const message = (error as Error).message;
    if (message === "body_too_large") {
      jsonError(res, 413, "body_too_large", "Architect plan create payload is too large");
      return;
    }
    jsonError(res, 400, "bad_json", "Expected a JSON object request body");
    return;
  }

  const title = normalizePlanTitle(textField(body, "title") ?? textField(body, "name"));
  const requestedId = textField(body, "id") ?? textField(body, "plan_id");
  const baseId = requestedId && isSafePlanId(requestedId) ? requestedId : slugifyPlanId(title);
  const planId = await pickAvailablePlanId(baseId);
  const timestamp = new Date().toISOString();
  const plansRoot = getArchitectPlansRoot();
  await mkdir(plansRoot, { recursive: true });
  await writeFile(resolve(plansRoot, `${planId}.md`), buildCreatedPlanMarkdown(planId, title, timestamp), { encoding: "utf-8", flag: "wx" });
  await writeFile(resolve(plansRoot, `${planId}.implementation-log.md`), buildCreatedPlanLog(planId, title, timestamp), { encoding: "utf-8", flag: "wx" });

  const plan = await buildArchitectPlanSummary(`${planId}.md`);
  const result = {
    plan_id: planId,
    title,
    status: "created",
    changed: true,
    plan_path: `plans/${planId}.md`,
    log_path: `plans/${planId}.implementation-log.md`,
    audit_scope: "daemon_governed_plan_create",
    guardRails: [
      "The browser requested a governed plan create action; the daemon wrote the plan artifact inside the active project plans/ folder.",
      "The companion implementation log is appendable and resume-safe from creation.",
    ],
  };

  publishEvent("architect.plan_action", result);
  json(res, 201, {
    ok: true,
    contract: "architect",
    version: "v1",
    ...buildMeta(),
    result,
    plan,
  });
}

async function handlePlanArchiveRequest(req: IncomingMessage, res: ServerResponse, planId: string): Promise<void> {
  if (!isSafePlanId(planId)) {
    jsonError(res, 400, "bad_request", "Invalid Architect plan id");
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const message = (error as Error).message;
    if (message === "body_too_large") {
      jsonError(res, 413, "body_too_large", "Architect plan archive payload is too large");
      return;
    }
    jsonError(res, 400, "bad_json", "Expected a JSON object request body");
    return;
  }

  const detail = await loadArchitectPlanDetail(planId);
  if (!detail) {
    jsonError(res, 404, "not_found", `No Architect plan with id: ${planId}`);
    return;
  }

  const auditReason = textField(body, "audit_reason") ?? `Operator archived Architect plan ${planId} from the standalone browser plan rail.`;
  const audit = await recordPlanActionAudit(planId, {
    kind: "plan_action",
    action: "archive_plan",
    audit_reason: auditReason,
    actor: textField(body, "actor") ?? "standalone-architect-browser",
    slice_id: textField(body, "slice_id") ?? "standalone-architect-plan-panel",
    evidence: detail.path,
    content: "Standalone Architect archived this plan through a daemon-governed plan-panel action.",
  });
  if (!audit) {
    jsonError(res, 404, "not_found", `No Architect plan with id: ${planId}`);
    return;
  }

  const timestamp = new Date().toISOString();
  const archiveStamp = timestamp.replace(/[:.]/g, "-");
  const plansRoot = getArchitectPlansRoot();
  const archiveRoot = resolve(plansRoot, "archive");
  await mkdir(archiveRoot, { recursive: true });

  const archivedPlanFileName = `${planId}.${archiveStamp}.md`;
  await rename(resolve(plansRoot, `${planId}.md`), resolve(archiveRoot, archivedPlanFileName));

  const logFileName = `${planId}.implementation-log.md`;
  const logPath = resolve(plansRoot, logFileName);
  let archivedLogPath: string | null = null;
  if (existsSync(logPath)) {
    const archivedLogFileName = `${planId}.${archiveStamp}.implementation-log.md`;
    await rename(logPath, resolve(archiveRoot, archivedLogFileName));
    archivedLogPath = `plans/archive/${archivedLogFileName}`;
  }

  const result = {
    plan_id: planId,
    title: detail.title,
    status: "archived",
    changed: true,
    audit_id: audit.audit_id,
    archived_path: `plans/archive/${archivedPlanFileName}`,
    archived_log_path: archivedLogPath,
    audit_reason: audit.audit_reason,
    audit_scope: "daemon_governed_plan_archive",
    guardRails: [
      "The browser requested a governed archive action; the daemon moved the plan artifact inside the active project plans/archive folder.",
      "The archive action was captured in the plan implementation log before the artifacts were moved.",
    ],
  };

  publishEvent("architect.plan_action", result);
  json(res, 200, {
    ok: true,
    contract: "architect",
    version: "v1",
    ...buildMeta(),
    result,
  });
}

async function handlePlanDetail(req: IncomingMessage, res: ServerResponse, planId: string): Promise<void> {
  const plan = await loadArchitectPlanDetail(planId);
  if (!plan) {
    jsonError(res, 404, "not_found", `No Architect plan with id: ${planId}`);
    return;
  }

  sendJsonWithEtag(req, res, {
    ok: true,
    contract: "architect",
    version: "v1",
    ...buildMeta(),
    plan: {
      ...plan,
      vscode_links: buildVsCodeDeepLinks(plan),
    },
  });
}

async function handleArchitectConfigRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const message = (error as Error).message;
    if (message === "body_too_large") {
      jsonError(res, 413, "body_too_large", "Architect config payload is too large");
      return;
    }
    jsonError(res, 400, "bad_json", "Expected a JSON object request body");
    return;
  }

  const current = getArchitectLlmConfig();
  const adapter = architectAdapterField(body, "adapter") ?? getArchitectAdapterConfig().adapter;
  const requestedProvider = architectProviderField(body, "provider") ?? current.provider;
  const provider = adapter === "native_api_tool_loop" ? requestedProvider : "none";
  const model = optionalTextField(body, "model") ?? current.model;
  const autonomyMode =
    architectAutonomyModeField(body, "autonomy_mode") ?? architectAutonomyModeField(body, "mode") ?? getArchitectAutonomyMode().mode;

  if (adapter === "native_api_tool_loop" && provider !== "none" && model.length === 0) {
    jsonError(res, 400, "bad_request", "Native API Architect routing requires a model name");
    return;
  }

  const updates = {
    DREAMGRAPH_LLM_ARCHITECT_ADAPTER: adapter,
    DREAMGRAPH_LLM_ARCHITECT_PROVIDER: provider,
    DREAMGRAPH_LLM_ARCHITECT_MODEL: model,
    DREAMGRAPH_ARCHITECT_AUTONOMY_MODE: autonomyMode,
  };
  const scope = getActiveScope();
  if (scope?.engineEnvPath) {
    updateEngineEnvValues(scope.engineEnvPath, updates);
  }
  for (const [key, value] of Object.entries(updates)) {
    process.env[key] = value;
  }
  const architect = updateArchitectLlmConfig({ provider, model });
  const runtime = buildActiveArchitectSessionRuntime();
  const result = {
    changed: true,
    persisted: Boolean(scope?.engineEnvPath),
    engine_env_path: scope?.engineEnvPath ?? null,
    adapter: runtime.adapter,
    provider: runtime.provider,
    model: runtime.model,
    mode: runtime.autonomy_mode,
    autonomy_mode: runtime.autonomy_mode,
    provider_source: architect.providerSource,
    model_source: architect.modelSource,
    runtime,
  };
  const meta = buildMeta();
  publishEvent("architect.config", {
    status: "configured",
    ...result,
    runtime,
    project_scope: meta.project_scope,
    architect_runtime: runtime,
    architect_llm: meta.architect_llm,
  });
  json(res, 200, {
    ok: true,
    contract: "architect",
    version: "v1",
    ...meta,
    runtime,
    architect_runtime: runtime,
    result,
  }, { "Cache-Control": "no-store" });
}

async function handleArchitectSelectionRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const message = (error as Error).message;
    if (message === "body_too_large") {
      jsonError(res, 413, "body_too_large", "Architect selection payload is too large");
      return;
    }
    jsonError(res, 400, "bad_json", "Expected a JSON object request body");
    return;
  }

  const selectionFieldPresent = ["planId", "plan_id", "selected_plan_id"].some((field) => Object.prototype.hasOwnProperty.call(body, field));
  const rawSelectionValue = body.planId ?? body.plan_id ?? body.selected_plan_id;
  const rawSelectionText = typeof rawSelectionValue === "string" ? rawSelectionValue.trim() : rawSelectionValue == null ? "" : null;
  const clearSelection = body.clear === true || (selectionFieldPresent && rawSelectionText === "");

  const scope = getActiveScope();
  if (clearSelection) {
    const updates: Record<string, string> = { [ARCHITECT_SELECTED_PLAN_ENV_KEY]: "" };
    if (scope?.engineEnvPath) {
      updateEngineEnvValues(scope.engineEnvPath, updates);
    }
    process.env[ARCHITECT_SELECTED_PLAN_ENV_KEY] = "";

    const result = {
      changed: true,
      persisted: Boolean(scope?.engineEnvPath),
      engine_env_path: scope?.engineEnvPath ?? null,
      selected_plan_id: null,
      selected_plan_title: null,
      env_key: ARCHITECT_SELECTED_PLAN_ENV_KEY,
    };
    const meta = buildMeta();
    publishEvent("architect.config", {
      status: "selected_plan_cleared",
      ...result,
      project_scope: meta.project_scope,
      architect_selection: meta.architect_selection,
    });
    json(res, 200, {
      ok: true,
      contract: "architect",
      version: "v1",
      ...meta,
      result,
    }, { "Cache-Control": "no-store" });
    return;
  }

  if (rawSelectionText == null) {
    jsonError(res, 400, "bad_request", "Missing or invalid selected Architect plan id");
    return;
  }

  const planId = selectedPlanIdFromText(rawSelectionText);
  if (!planId) {
    jsonError(res, 400, "bad_request", "Missing or invalid selected Architect plan id");
    return;
  }

  const plan = await loadArchitectPlanDetail(planId);
  if (!plan) {
    jsonError(res, 404, "not_found", `No Architect plan with id: ${planId}`);
    return;
  }

  const updates: Record<string, string> = { [ARCHITECT_SELECTED_PLAN_ENV_KEY]: planId };
  if (scope?.engineEnvPath) {
    updateEngineEnvValues(scope.engineEnvPath, updates);
  }
  process.env[ARCHITECT_SELECTED_PLAN_ENV_KEY] = planId;

  const result = {
    changed: true,
    persisted: Boolean(scope?.engineEnvPath),
    engine_env_path: scope?.engineEnvPath ?? null,
    selected_plan_id: planId,
    selected_plan_title: plan.title,
    env_key: ARCHITECT_SELECTED_PLAN_ENV_KEY,
  };
  const meta = buildMeta();
  publishEvent("architect.config", {
    status: "selected_plan_saved",
    ...result,
    project_scope: meta.project_scope,
    architect_selection: meta.architect_selection,
  });
  json(res, 200, {
    ok: true,
    contract: "architect",
    version: "v1",
    ...meta,
    result,
  }, { "Cache-Control": "no-store" });
}

function buildArchitectChatSystemPrompt(plan: ArchitectPlanProjection | null, runtime: ArchitectRuntimeRouteContext, chatScope: ArchitectChatScope): string {
  const project = buildProjectScopePayload();
  const planContext = chatScope === "plan"
    ? plan
      ? `Chat scope: plan. Active plan: ${plan.title} (${plan.id}); lifecycle=${plan.operational_state.plan_lifecycle ?? "planning"}; execution=${plan.operational_state.execution_state ?? "idle"}; phase=${plan.operational_state.active_phase ?? plan.operational_state.phase ?? plan.active_phase ?? "unknown"}; last_completed=${plan.operational_state.last_completed_slice?.title ?? "none"}; next_slice=${plan.operational_state.next_slice?.title ?? "none"}.`
      : "Chat scope: plan. No active plan is selected."
    : "Chat scope: project. Treat this as a global project/repo/graph prompt. Do not inject or assume selected-plan context, and do not write selected-plan implementation-log or planning action records unless the user explicitly changes scope to plan.";
  const runtimeBlock = [
    "Current execution runtime:",
    `- Adapter: ${runtime.adapter}`,
    `- Provider: ${runtime.provider}`,
    `- Model: ${runtime.model || "none"}`,
    `- Autonomy mode: ${runtime.autonomy_mode}`,
    `- Pass state: ${runtime.pass_state.completed} completed; ${runtime.pass_state.tools} tools; ${runtime.pass_state.status}`,
    `- Execution route: ${runtime.execution_route}`,
    `- Session id: ${runtime.session_id}`,
    `- Session source: ${runtime.session_source}`,
    `- Provenance authority: ${runtime.provenance_authority}`,
  ].join("\n");
  return [
    "You are DreamGraph Architect inside the daemon-served standalone browser surface.",
    "Use the provided DreamGraph MCP tools for project facts, graph health, ADRs, workflows, data model, source inspection, and verification before answering repository-specific questions.",
    "Keep answers concise, project-bound, and grounded in daemon authority. Do not claim direct browser filesystem authority.",
    "Project scope is not unsafe mode: source, graph, ADR, and file mutations still require the normal governed DreamGraph MCP/tool authority.",
    "If asked which model, provider, adapter, route, autonomy state, or session you are running, answer from the Current execution runtime block. Never say this runtime identity is unknown inside DreamGraph.",
    `Project root: ${String(project.project_root ?? "unbound")}. Plans root: ${String(project.plans_root ?? "unbound")}.`,
    runtimeBlock,
    planContext,
  ].join("\n");
}

function deterministicArchitectChatReply(
  message: string,
  fallbackReason: string | null,
  plan: ArchitectPlanProjection | null,
  runtime: ActiveArchitectSessionRuntime,
  chatScope: ArchitectChatScope,
  planUpdate: ArchitectPlanChatUpdateResult | null = null,
): string {
  const project = buildProjectScopePayload();
  const planLabel = chatScope === "plan" && plan ? `${plan.title} (${plan.id})` : "project scope";
  const reason = fallbackReason ? ` LLM fallback reason: ${fallbackReason}.` : "";
  if (isArchitectRuntimeIdentityQuestion(message)) {
    return [
      "Current execution runtime:",
      `- Adapter: ${runtime.adapter}`,
      `- Provider: ${runtime.provider}`,
      `- Model: ${runtime.model || "none"}`,
      `- Autonomy mode: ${runtime.autonomy_mode}`,
      `- Pass state: ${runtime.pass_state.completed} completed; ${runtime.pass_state.tools} tools; ${runtime.pass_state.status}`,
      `- Execution route: ${runtime.execution_route}`,
      `- Session id: ${runtime.session_id}`,
      `- Session source: ${runtime.session_source}`,
      `- Provenance authority: ${runtime.provenance_authority}`,
      reason.trim(),
    ].filter(Boolean).join("\n");
  }
  if (planUpdate) {
    return [
      `Updated ${plan?.title ?? planUpdate.plan_id} (${planUpdate.plan_id}).`,
      `- Plan markdown: ${planUpdate.plan_path}`,
      planUpdate.log_path ? `- Implementation log: ${planUpdate.log_path}` : null,
      `- Applied as: ${planUpdate.update_mode}`,
      `- Section: ${planUpdate.section_title}`,
      reason.trim(),
    ].filter(Boolean).join("\n");
  }
  return `Architect is bound to ${String(project.project_root ?? "the active project")} in ${planLabel}.${reason} I can load plans from the project plans/ folder, show the selected runtime routing, and use DreamGraph MCP tools through daemon-governed authority.`;
}

function wantsChatSseResponse(req: IncomingMessage, body: Record<string, unknown>): boolean {
  const accept = req.headers.accept;
  const acceptText = Array.isArray(accept) ? accept.join(",") : accept ?? "";
  const responseTransport = textField(body, "response_transport") ?? textField(body, "responseTransport");
  return acceptText.toLowerCase().includes("text/event-stream") || responseTransport === "sse" || body.stream === true;
}

function writeSsePayload(res: ServerResponse, eventName: string, payload: unknown): void {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeChatSseResponse(res: ServerResponse, payload: Record<string, unknown>): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform, no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  writeComment(res, "architect-chat");
  writeSsePayload(res, "architect.chat.status", {
    ok: true,
    phase: "completed",
    generated_at: payload.generated_at,
    project_scope: payload.project_scope,
    architect_llm: payload.architect_llm,
  });
  writeSsePayload(res, "architect.chat.result", payload);
  res.end();
}

function architectToolTraceKey(entry: ArchitectToolTraceEntry): string {
  return entry.trace_id ?? `${entry.tool}:${entry.iteration}`;
}

function mergeArchitectToolTraceEntries(
  current: ArchitectToolTraceEntry[],
  incoming: ArchitectToolTraceEntry | ArchitectToolTraceEntry[],
): ArchitectToolTraceEntry[] {
  const entries = Array.isArray(incoming) ? incoming : [incoming];
  const byKey = new Map(current.map((entry) => [architectToolTraceKey(entry), entry]));
  for (const entry of entries) {
    byKey.set(architectToolTraceKey(entry), entry);
  }
  return [...byKey.values()].sort((left, right) => left.iteration - right.iteration);
}

function architectPassStatusFromFallback(fallbackReason: string | null): ArchitectPassStatus {
  if (!fallbackReason) return "complete";
  if (fallbackReason.includes("_BRIDGE_TIMEOUT") || fallbackReason.toLowerCase().includes("timed out")) return "timed_out";
  return "failed";
}

async function handleArchitectChatRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const message = (error as Error).message;
    if (message === "body_too_large") {
      jsonError(res, 413, "body_too_large", "Architect chat payload is too large");
      return;
    }
    jsonError(res, 400, "bad_json", "Expected a JSON object request body");
    return;
  }

  const rawMessage = textField(body, "message");
  if (!rawMessage) {
    jsonError(res, 400, "bad_request", "Missing message");
    return;
  }

  const selectedPlanId = textField(body, "plan_id") ?? textField(body, "planId") ?? textField(body, "selected_plan_id");
  const slashOverride = parseArchitectChatSlashScope(rawMessage);
  const bodyScope = architectChatScopeFromText(textField(body, "scope") ?? textField(body, "chat_scope") ?? textField(body, "chatScope"));
  const chatScope: ArchitectChatScope = slashOverride.scope ?? bodyScope ?? (selectedPlanId ? "plan" : "project");
  const message = slashOverride.message.trim();
  if (!message) {
    jsonError(res, 400, "bad_request", "Missing message after chat scope command");
    return;
  }

  if (chatScope === "plan" && !selectedPlanId) {
    jsonError(res, 400, "bad_request", "Plan chat scope requires a selected Architect plan id");
    return;
  }

  const planId = chatScope === "plan" ? selectedPlanId : null;
  const continuationToken = textField(body, "continuation_token") ?? textField(body, "continuationToken");
  const mode = architectAutonomyModeField(body, "autonomy_mode") ?? architectAutonomyModeField(body, "mode") ?? getArchitectAutonomyMode().mode;
  const adapter = architectAdapterField(body, "adapter") ?? getArchitectAdapterConfig().adapter;
  const plan = planId ? await loadArchitectPlanDetail(planId) : null;
  if (planId && !plan) {
    jsonError(res, 404, "not_found", `No Architect plan with id: ${planId}`);
    return;
  }

  const architectConfig = buildArchitectLlmRequestConfig(body);
  const provider = createLlmProviderForConfig(architectConfig);
  let providerAvailable = false;
  let fallbackReason: string | null = null;
  let assistantText: string | null = null;
  let completionModel = architectConfig.model;
  let toolTrace: ArchitectToolTraceEntry[] = [];
  let provenance: unknown = null;
  let toolLoopRoute: unknown = null;
  let planUpdate: ArchitectPlanChatUpdateResult | null = null;
  let runtime = buildActiveArchitectSessionRuntime({
    adapter,
    provider: architectConfig.provider,
    model: architectConfig.model,
    autonomy_mode: mode,
    pass_state: updateActiveArchitectPassState({ status: "running", tools: 0 }),
  });

  if (adapter === "deterministic_fallback") {
    fallbackReason = "operator_selected_deterministic_fallback";
  } else if (adapter === "codex-cli" || adapter === "copilot-cli") {
    const messages: LlmMessage[] = [
      { role: "system", content: buildArchitectChatSystemPrompt(plan, runtime, chatScope) },
      { role: "user", content: message },
    ];
    try {
      const completion = await runArchitectCliBridge({
        adapter,
        req,
        messages,
        userMessage: message,
        model: architectConfig.model,
        timeoutMs: architectConfig.timeoutMs,
        onToolTrace: (entry) => {
          toolTrace = mergeArchitectToolTraceEntries(toolTrace, entry);
          runtime = buildActiveArchitectSessionRuntime({
            adapter,
            provider: architectConfig.provider,
            model: architectConfig.model,
            autonomy_mode: mode,
            pass_state: updateActiveArchitectPassState({ status: "running", tools: toolTrace.length }),
          });
          publishEvent("architect.tool_result", {
            chat_scope: chatScope,
            selected_plan_id: selectedPlanId ?? null,
            plan_id: plan?.id ?? null,
            continuation_token_present: continuationToken != null,
            mode,
            iteration: entry.iteration,
            trace_id: entry.trace_id,
            tool: entry.tool,
            args_summary: entry.args_summary,
            status: entry.status,
            duration_ms: entry.duration_ms,
            result_preview: entry.result_preview,
            runtime,
            architect_runtime: runtime,
          });
        },
      });
      providerAvailable = true;
      assistantText = completion.content.trim();
      completionModel = completion.model || architectConfig.model;
      toolTrace = mergeArchitectToolTraceEntries(toolTrace, completion.tool_trace);
      provenance = completion.provenance;
      toolLoopRoute = completion.route;
      fallbackReason = completion.route.fallback_reason;
      if (!assistantText) {
        fallbackReason = fallbackReason ?? "empty_cli_bridge_response";
      }
    } catch (error) {
      fallbackReason = `architect_provider_failed: ${(error as Error).message.slice(0, 240)}`;
    }
  } else if (architectConfig.provider === "none" || architectConfig.model.length === 0) {
    fallbackReason = "architect_llm_not_configured";
  } else {
    providerAvailable = await provider.isAvailable().catch(() => false);
    if (!providerAvailable) {
      fallbackReason = "architect_provider_unavailable";
    } else {
      const messages: LlmMessage[] = [
        { role: "system", content: buildArchitectChatSystemPrompt(plan, runtime, chatScope) },
        { role: "user", content: message },
      ];
      try {
        const completion = await runArchitectNativeToolLoop({
          req,
          config: architectConfig,
          provider,
          messages,
          userMessage: message,
          onToolTrace: (entry) => {
            toolTrace = mergeArchitectToolTraceEntries(toolTrace, entry);
            runtime = buildActiveArchitectSessionRuntime({
              adapter,
              provider: architectConfig.provider,
              model: architectConfig.model,
              autonomy_mode: mode,
              pass_state: updateActiveArchitectPassState({ status: "running", tools: toolTrace.length }),
            });
            publishEvent("architect.tool_result", {
              chat_scope: chatScope,
              selected_plan_id: selectedPlanId ?? null,
              plan_id: plan?.id ?? null,
              continuation_token_present: continuationToken != null,
              mode,
              iteration: entry.iteration,
              trace_id: entry.trace_id,
              tool: entry.tool,
              args_summary: entry.args_summary,
              status: entry.status,
              duration_ms: entry.duration_ms,
              result_preview: entry.result_preview,
              runtime,
              architect_runtime: runtime,
            });
          },
        });
        assistantText = completion.content.trim();
        completionModel = completion.model || architectConfig.model;
        toolTrace = mergeArchitectToolTraceEntries(toolTrace, completion.tool_trace);
        provenance = completion.provenance;
        toolLoopRoute = completion.route;
        fallbackReason = completion.route.fallback_reason;
        if (!assistantText) {
          fallbackReason = fallbackReason ?? "empty_llm_response";
        }
      } catch (error) {
        fallbackReason = `architect_provider_failed: ${(error as Error).message.slice(0, 240)}`;
      }
    }
  }

  if (!assistantText && chatScope === "plan" && shouldApplyPlanChatUpdate(message, plan)) {
    planUpdate = await applyPlanChatUpdate(plan!, message, runtime);
  }

  const finalPassState = updateActiveArchitectPassState({
    completed: activeArchitectPassState.completed + 1,
    tools: toolTrace.length,
    status: architectPassStatusFromFallback(fallbackReason),
  });
  runtime = buildActiveArchitectSessionRuntime({
    adapter,
    provider: architectConfig.provider,
    model: architectConfig.model,
    autonomy_mode: mode,
    pass_state: finalPassState,
  });
  const provenanceRecord = asRecord(provenance);
  const runtimeProvenance: Record<string, unknown> = {
    ...(provenanceRecord ?? {}),
    authority: String(provenanceRecord?.authority ?? runtime.provenance_authority),
    runtime,
    session_id: runtime.session_id,
    execution_route: runtime.execution_route,
    provenance_authority: runtime.provenance_authority,
  };

  const result = {
    role: "assistant",
    content: assistantText ?? deterministicArchitectChatReply(message, fallbackReason, plan, runtime, chatScope, planUpdate),
    created_at: new Date().toISOString(),
    chat_scope: chatScope,
    selected_plan_id: selectedPlanId ?? null,
    plan_id: plan?.id ?? null,
    continuation_token: continuationToken,
    mode: runtime.autonomy_mode,
    runtime,
    route: {
      adapter: runtime.adapter,
      provider: runtime.provider,
      provider_source: runtime.provider_source,
      model: runtime.model,
      model_source: runtime.model_source,
      fallback_order: ["architect", "general", "normalizer", "dreamer"],
      temperature: architectConfig.temperature,
      max_tokens: architectConfig.maxTokens,
      base_url: architectConfig.baseUrl,
      provider_available: providerAvailable,
      completion_model: completionModel,
      fallback_reason: fallbackReason,
      execution_route: runtime.execution_route,
      session_id: runtime.session_id,
      autonomy_mode: runtime.autonomy_mode,
      pass_state: runtime.pass_state,
      provenance_authority: runtime.provenance_authority,
      runtime,
      tool_loop: toolLoopRoute,
    },
    provenance: runtimeProvenance,
    tool_trace: toolTrace.map((entry) => ({ ...entry, runtime })),
    plan_update: planUpdate,
    project_scope: buildProjectScopePayload(),
  };

  publishEvent("architect.chat", {
    chat_scope: chatScope,
    selected_plan_id: selectedPlanId ?? null,
    plan_id: result.plan_id,
    message_length: message.length,
    continuation_token_present: continuationToken != null,
    mode: runtime.autonomy_mode,
    route: result.route,
    runtime,
    architect_runtime: runtime,
    tool_trace_count: toolTrace.length,
    plan_update: planUpdate,
    provenance: runtimeProvenance,
  });

  const meta = buildMeta();
  const payload = {
    ok: true,
    contract: "architect",
    version: "v1",
    transport: wantsChatSseResponse(req, body) ? "sse" : "json",
    ...meta,
    runtime,
    architect_runtime: runtime,
    result,
  };

  if (wantsChatSseResponse(req, body)) {
    writeChatSseResponse(res, payload);
    return;
  }

  json(res, 200, payload, { "Cache-Control": "no-store" });
}

function writeEvent(res: ServerResponse, event: ArchitectEvent): void {
  res.write(`id: ${event.seq}\n`);
  res.write(`event: ${event.kind}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function writeComment(res: ServerResponse, text: string): void {
  res.write(`: ${text}\n\n`);
}

function parseLastEventId(req: IncomingMessage): number {
  const raw = req.headers["last-event-id"];
  if (typeof raw !== "string") return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function handleArchitectEvents(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  writeComment(res, "open");

  const lastEventId = parseLastEventId(req);
  const replay = replayEvents(lastEventId);
  if (lastEventId > 0 && eventRing.length > 0 && eventRing[0].seq > lastEventId + 1) {
    writeComment(res, `gap: earliest=${eventRing[0].seq}`);
  }
  for (const event of replay) {
    writeEvent(res, event);
  }

  const unsubscribe = subscribe((event) => {
    try {
      writeEvent(res, event);
    } catch (error) {
      logger.warn(`architect sse write failed (${event.kind}): ${(error as Error).message}`);
    }
  });

  const cleanup = (): void => {
    unsubscribe();
  };

  req.on("close", cleanup);
  req.on("error", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);
}

type ArchitectPlanProjection = NonNullable<Awaited<ReturnType<typeof loadArchitectPlanDetail>>>;
type ArchitectScheduleProjectionSource = Awaited<ReturnType<typeof getSchedules>>[number];
type ArchitectScheduleExecutionSource = Awaited<ReturnType<typeof getScheduleHistory>>[number];
type ArchitectScheduleActionName = "run_now" | "pause" | "resume";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function textFrom(record: Record<string, unknown> | null, fields: string[]): string | null {
  if (!record) return null;
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function normalizeScheduleAction(value: string | null): ArchitectScheduleActionName | null {
  const normalized = value?.trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "run_now" || normalized === "pause" || normalized === "resume") {
    return normalized;
  }
  return null;
}

function parseArchitectScheduleSubroute(pathname: string): { scheduleId: string; suffix: string | null } | null {
  const base = "/api/architect/v1/schedules/";
  if (!pathname.startsWith(base)) return null;
  const remainder = pathname.slice(base.length);
  if (!remainder) return { scheduleId: "", suffix: null };
  const [encodedScheduleId, ...rest] = remainder.split("/");
  return {
    scheduleId: decodeURIComponent(encodedScheduleId),
    suffix: rest.length > 0 ? rest.join("/") : null,
  };
}

function buildVsCodeFileUri(relativePath: string): string {
  const absolutePath = resolve(getArchitectProjectRoot(), relativePath).replace(/\\/g, "/");
  return encodeURI(`vscode://file/${absolutePath}`);
}

function buildVsCodeDeepLinks(plan: ArchitectPlanProjection): Record<string, string> {
  const links: Record<string, string> = {
    plan_markdown: buildVsCodeFileUri(plan.path),
  };
  if (plan.log_path) {
    links.implementation_log = buildVsCodeFileUri(plan.log_path);
  }
  return links;
}

function buildFutureDecisionTemplates(planId: string): Array<Record<string, unknown>> {
  const endpoint = `/api/architect/v1/plans/${encodeURIComponent(planId)}/review-gates`;
  const baseBody = {
    action: "future_review_decision",
    gate_id: "phase-6-adaptive-future-review",
    slice_id: "phase-6-afe-and-scheduler-integration",
  };
  return [
    {
      id: "accept",
      label: "Accept Recommendation",
      method: "POST",
      endpoint,
      body: {
        ...baseBody,
        decision: "accept",
        audit_reason: "Operator accepted the advisory Adaptive Future recommendation for this plan slice.",
      },
    },
    {
      id: "reject",
      label: "Reject",
      method: "POST",
      endpoint,
      body: {
        ...baseBody,
        decision: "reject",
        audit_reason: "Operator rejected the advisory Adaptive Future recommendation for this plan slice.",
      },
    },
    {
      id: "defer",
      label: "Defer",
      method: "POST",
      endpoint,
      body: {
        ...baseBody,
        decision: "defer",
        audit_reason: "Operator deferred the advisory Adaptive Future recommendation pending more evidence.",
      },
    },
    {
      id: "supersede",
      label: "Supersede",
      method: "POST",
      endpoint,
      body: {
        ...baseBody,
        decision: "supersede",
        audit_reason: "Operator marked the advisory Adaptive Future recommendation as superseded by a newer plan path.",
      },
    },
  ];
}

interface ArchitectFutureReviewRouteMetadata {
  route: "llm" | "deterministic";
  fallback: "none" | "deterministic_fallback";
  fallback_reason: string | null;
  provider: string;
  provider_source: string;
  provider_available: boolean;
  model: string;
  model_source: string;
  base_url: string | null;
  runtime: ActiveArchitectSessionRuntime;
}

async function resolveArchitectFutureReviewRouteMetadata(): Promise<ArchitectFutureReviewRouteMetadata> {
  const architectConfig = getArchitectLlmConfig();
  const runtime = buildActiveArchitectSessionRuntime();
  const base = {
    provider: runtime.provider,
    provider_source: runtime.provider_source,
    model: runtime.model,
    model_source: runtime.model_source,
    base_url: architectConfig.baseUrl ?? null,
    runtime,
  };

  if (runtime.adapter !== "native_api_tool_loop") {
    return {
      ...base,
      route: "deterministic",
      fallback: "deterministic_fallback",
      fallback_reason: runtime.adapter === "deterministic_fallback"
        ? "operator_selected_deterministic_fallback"
        : `${runtime.adapter}_future_review_cli_bridge_not_invoked`,
      provider_available: false,
    };
  }

  if (architectConfig.provider === "none" || architectConfig.model.length === 0) {
    return {
      ...base,
      route: "deterministic",
      fallback: "deterministic_fallback",
      fallback_reason: "architect_llm_not_configured",
      provider_available: false,
    };
  }

  const provider = createLlmProviderForConfig(architectConfig);
  const providerAvailable = await provider.isAvailable().catch(() => false);
  if (!providerAvailable) {
    return {
      ...base,
      route: "deterministic",
      fallback: "deterministic_fallback",
      fallback_reason: "architect_provider_unavailable",
      provider_available: false,
    };
  }

  return {
    ...base,
    route: "llm",
    fallback: "none",
    fallback_reason: null,
    provider_available: true,
  };
}

async function buildArchitectFutureReviewProjection(plan: ArchitectPlanProjection): Promise<Record<string, unknown>> {
  const operational = plan.operational_state;
  const currentSliceId = operational.current_slice_id ?? plan.registry.slices[0]?.id ?? "plan-level-review";
  const currentSlice = plan.registry.slices.find((slice) => slice.id === currentSliceId) ?? plan.registry.slices[0] ?? null;
  const nextSlice =
    plan.registry.slices.find((slice) => {
      if (slice.id === currentSlice?.id) return false;
      return !/complete|done|verified/i.test(slice.status ?? "");
    }) ?? null;
  const activeSlice = currentSlice?.id ?? currentSliceId;
  const routeMetadata = await resolveArchitectFutureReviewRouteMetadata();
  const routeNote =
    routeMetadata.route === "llm"
      ? `Model-backed route selected from ${routeMetadata.provider}/${routeMetadata.model}.`
      : `Deterministic fallback selected because ${routeMetadata.fallback_reason ?? "unknown_reason"}.`;
  const primaryObjections = [
    "This is a projection layer; it does not execute schedule mutations without a guarded action.",
  ];
  if (routeMetadata.fallback_reason) {
    primaryObjections.push(`Model-backed future generation unavailable: ${routeMetadata.fallback_reason}.`);
  }

  const planSlug = slugifyPlanId(plan.id);
  const currentSliceSlug = slugifyPlanId(activeSlice);
  const nextSliceSlug = slugifyPlanId(nextSlice?.id ?? "plan-level-governance");
  const selectedCandidateId = `${planSlug}:${currentSliceSlug}:governed-review`;
  const nextCandidateId = `${planSlug}:${nextSliceSlug}:advance-or-review`;
  const deferCandidateId = `${planSlug}:defer-until-plan-evidence-matures`;
  const candidateLabels = new Map<string, string>([
    [selectedCandidateId, currentSlice ? `Continue ${currentSlice.title}` : `Review ${plan.title}`],
    [nextCandidateId, nextSlice ? `Advance ${nextSlice.title}` : `Review plan-level governance for ${plan.title}`],
    [deferCandidateId, `Defer AFE decision for ${plan.title}`],
  ]);
  const adrBindingCount = plan.registry.summary.adr_binding_count;
  const graphBindingCount = plan.registry.summary.graph_binding_count;
  const checkpointCount = plan.registry.summary.checkpoint_count;
  const verifiedCheckpointCount = operational.verified_checkpoint_count;
  const adrAlignment = Math.min(0.97, 0.68 + adrBindingCount * 0.035);
  const evidenceStrength = Math.min(0.95, 0.58 + graphBindingCount * 0.02 + checkpointCount * 0.01);
  const verificationPath = Math.min(0.95, 0.62 + checkpointCount * 0.015 + verifiedCheckpointCount * 0.04);
  const graphSyncImpact = Math.min(0.94, 0.56 + graphBindingCount * 0.025 + adrBindingCount * 0.015);
  const adrAnchors = Array.from(new Set([...plan.registry.adr_bindings.slice(0, 3), "ADR-214"]));
  const baseAnchors = [
    { kind: "plan" as const, id: plan.id, label: plan.title, source_file: plan.path },
    { kind: "source" as const, id: "src/architect/routes.ts", label: "Standalone Architect route layer" },
    ...adrAnchors.map((id) => ({ kind: "adr" as const, id, label: id })),
  ];
  const currentSliceAnchor = currentSlice
    ? [{ kind: "plan" as const, id: `${plan.id}:${currentSlice.id}`, label: currentSlice.title, source_file: plan.path }]
    : [];
  const nextSliceAnchor = nextSlice
    ? [{ kind: "plan" as const, id: `${plan.id}:${nextSlice.id}`, label: nextSlice.title, source_file: plan.path }]
    : [];

  const audit = buildAdaptiveFutureAuditTrail({
    task_class: "planning_doc",
    selected_candidate_id: selectedCandidateId,
    route: routeMetadata.route,
    fallback: routeMetadata.fallback,
    notes: [
      "Projection is advisory and subordinate to accepted ADRs, API contracts, workflow constraints, and graph evidence.",
      routeNote,
      `Projection is bound to ${plan.title} and active slice ${currentSlice?.title ?? activeSlice}.`,
      "Human review decisions are recorded through the governed review-gates endpoint.",
    ],
    candidates: [
      {
        id: selectedCandidateId,
        task_class: "planning_doc",
        selected: true,
        score_factors: {
          adr_alignment: adrAlignment,
          workflow_fit: currentSlice ? 0.9 : 0.68,
          verification_path: verificationPath,
          graph_sync_impact: graphSyncImpact,
          blast_radius: currentSlice ? 0.3 : 0.44,
          evidence_strength: evidenceStrength,
        },
        anchors: [...baseAnchors, ...currentSliceAnchor],
        objections: [
          `Review stays bound to ${plan.title}${currentSlice ? ` / ${currentSlice.title}` : ""} instead of reusing another plan's recommendation.`,
          ...primaryObjections,
        ],
      },
      {
        id: nextCandidateId,
        task_class: "planning_doc",
        score_factors: {
          adr_alignment: Math.max(0.55, adrAlignment - 0.08),
          workflow_fit: nextSlice ? 0.72 : 0.54,
          verification_path: Math.max(0.5, verificationPath - 0.12),
          graph_sync_impact: Math.max(0.45, graphSyncImpact - 0.1),
          blast_radius: nextSlice ? 0.38 : 0.5,
          evidence_strength: Math.max(0.5, evidenceStrength - 0.08),
        },
        anchors: [...baseAnchors, ...nextSliceAnchor],
        objections: [
          nextSlice
            ? `Advancing to ${nextSlice.title} may skip unresolved current state ${operational.current_status ?? plan.status ?? "unknown"}.`
            : `No distinct next slice was projected for ${plan.title}; keep this as a plan-level governance review option.`,
        ],
      },
      {
        id: deferCandidateId,
        task_class: "planning_doc",
        score_factors: {
          adr_alignment: Math.max(0.45, adrAlignment - 0.2),
          workflow_fit: 0.42,
          verification_path: Math.max(0.48, verificationPath - 0.16),
          graph_sync_impact: Math.max(0.32, graphSyncImpact - 0.22),
          blast_radius: 0.18,
          evidence_strength: Math.max(0.42, evidenceStrength - 0.18),
        },
        anchors: baseAnchors,
        objections: [
          `Deferring AFE review would leave ${plan.title} without a current advisory decision surface.`,
        ],
      },
    ],
  });

  return {
    planId: plan.id,
    generatedAt: new Date().toISOString(),
    advisory: true,
    hard_enforcement: false,
    active_slice_id: activeSlice,
    selected_candidate_id: audit.selected_candidate_id ?? null,
    model_provenance: {
      route: audit.route,
      fallback: audit.fallback,
      fallback_reason: routeMetadata.fallback_reason,
      audit_version: audit.audit_version,
      provider: routeMetadata.provider,
      provider_source: routeMetadata.provider_source,
      provider_available: routeMetadata.provider_available,
      model: routeMetadata.model,
      model_source: routeMetadata.model_source,
      base_url: routeMetadata.base_url,
      runtime: routeMetadata.runtime,
      session_id: routeMetadata.runtime.session_id,
      execution_route: routeMetadata.runtime.execution_route,
      provenance_authority: routeMetadata.runtime.provenance_authority,
      adr_bindings: ["ADR-203", "ADR-204", "ADR-214"],
    },
    review_status: {
      human_review_required: true,
      supersession_aware: true,
      decision_surface: "review-gates",
      current_decision: "pending",
    },
    candidates: audit.candidates.map((candidate) => ({
      id: candidate.id,
      label: candidateLabels.get(candidate.id) ?? candidate.id,
      task_class: candidate.task_class,
      future_fit_score: candidate.score,
      score_factors: candidate.score_factors,
      selected: candidate.selected,
      evidence: candidate.anchors,
      objections: candidate.objections,
      validation_failures: candidate.validation_failures,
      review_status: candidate.selected ? "recommended" : "available",
    })),
    known_prior_future_outcomes: plan.registry.checkpoints.slice(-8).map((checkpoint) => ({
      id: checkpoint.id,
      slice_id: checkpoint.slice_id,
      status: checkpoint.status,
      timestamp: checkpoint.timestamp,
      resume_note: checkpoint.resume_note,
    })),
    notes: audit.notes,
    guardRails: [
      "Adaptive Future Engine output is advisory and cannot override accepted ADRs, API contracts, workflow constraints, or graph evidence.",
      "Candidate futures, scores, objections, provenance, fallback reason, human review, and supersession state remain visible.",
      "Review decisions are recorded through daemon-governed review gates; the browser does not write graph or filesystem state directly.",
    ],
    review_decisions: buildFutureDecisionTemplates(plan.id),
  };
}

function buildScheduleLinkedContext(schedule: ArchitectScheduleProjectionSource): Record<string, unknown> {
  const parameters = asRecord(schedule.parameters);
  return {
    plan_id: textFrom(parameters, ["plan_id", "planId", "plan"]),
    slice_id: textFrom(parameters, ["slice_id", "sliceId", "slice"]),
    tension_id: textFrom(parameters, ["tension_id", "tensionId", "tension"]),
    source: parameters == null ? "schedule_metadata_absent" : "schedule_parameters",
  };
}

function buildScheduleActionTemplates(schedule: ArchitectScheduleProjectionSource, linkedContext: Record<string, unknown>): Array<Record<string, unknown>> {
  const endpoint = `/api/architect/v1/schedules/${encodeURIComponent(schedule.id)}/actions`;
  const baseBody = {
    plan_id: linkedContext.plan_id ?? null,
    slice_id: linkedContext.slice_id ?? "phase-6-afe-and-scheduler-integration",
  };
  return [
    {
      id: "run_now",
      label: "Run Now",
      method: "POST",
      endpoint,
      body: {
        ...baseBody,
        action: "run_now",
        audit_reason: `Operator requested guarded run-now for schedule ${schedule.id}.`,
      },
    },
    {
      id: "pause",
      label: "Pause",
      method: "POST",
      endpoint,
      body: {
        ...baseBody,
        action: "pause",
        audit_reason: `Operator requested guarded pause for schedule ${schedule.id}.`,
      },
    },
    {
      id: "resume",
      label: "Resume",
      method: "POST",
      endpoint,
      body: {
        ...baseBody,
        action: "resume",
        audit_reason: `Operator requested guarded resume for schedule ${schedule.id}.`,
      },
    },
  ];
}

function buildScheduleProjection(
  schedule: ArchitectScheduleProjectionSource,
  history: ArchitectScheduleExecutionSource[],
): Record<string, unknown> {
  const linkedContext = buildScheduleLinkedContext(schedule);
  return {
    id: schedule.id,
    name: schedule.name,
    action: schedule.action,
    status: schedule.status,
    enabled: schedule.enabled,
    trigger_type: schedule.trigger_type,
    next_run_at: schedule.next_run_at,
    last_run_at: schedule.last_run_at,
    run_count: schedule.run_count,
    max_runs: schedule.max_runs,
    error_count: schedule.error_count,
    last_error: schedule.last_error,
    linked_context: linkedContext,
    routing_diagnostics: {
      tool_group: "scheduler",
      action_tool: "run_schedule_now",
      mutation_tool: "update_schedule",
      product_vocabulary_signals: ["dream", "schedule", "scheduler", String(schedule.action)],
    },
    recent_executions: history
      .filter((execution) => execution.schedule_id === schedule.id)
      .slice(-3)
      .reverse()
      .map((execution) => ({
        id: execution.id,
        triggered_at: execution.triggered_at,
        completed_at: execution.completed_at,
        success: execution.success,
        duration_ms: execution.duration_ms,
        result_summary: execution.result_summary,
        error: execution.error,
      })),
    actions: buildScheduleActionTemplates(schedule, linkedContext),
  };
}

async function handlePlanFutureReview(req: IncomingMessage, res: ServerResponse, planId: string): Promise<void> {
  const plan = await loadArchitectPlanDetail(planId);
  if (!plan) {
    jsonError(res, 404, "not_found", `No Architect plan with id: ${planId}`);
    return;
  }

  sendJsonWithEtag(req, res, {
    ok: true,
    contract: "architect",
    version: "v1",
    ...buildMeta(),
    future_review: await buildArchitectFutureReviewProjection(plan),
  });
}

async function handleArchitectSchedulesIndex(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const [schedules, history] = await Promise.all([
    getSchedules(),
    getScheduleHistory(undefined, 80),
  ]);
  const projections = schedules.map((schedule) => buildScheduleProjection(schedule, history));

  sendJsonWithEtag(req, res, {
    ok: true,
    contract: "architect",
    version: "v1",
    ...buildMeta(),
    scheduler: {
      source: "dream_scheduler",
      total: schedules.length,
      enabled: schedules.filter((schedule) => schedule.enabled).length,
      paused: schedules.filter((schedule) => !schedule.enabled || schedule.status === "paused").length,
      recent_execution_count: history.length,
      diagnostics: "Scheduler product vocabulary remains a valid routing signal; tool attachment is advisory until a guarded action is invoked.",
    },
    guardRails: [
      "Scheduler mutations are daemon-mediated, audited, and authenticated by the inherited loopback daemon session.",
      "Run-now, pause, and resume are explicit governed actions; listing schedules is projection-only.",
      "Schedule records can link to plan, slice, and tension ids through schedule parameters when present.",
    ],
    schedules: projections,
    recent_history: history.slice(-20).reverse(),
  });
}

async function handleArchitectScheduleActionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  scheduleId: string,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const message = (error as Error).message;
    if (message === "body_too_large") {
      jsonError(res, 413, "body_too_large", "Architect schedule action payload is too large");
      return;
    }
    jsonError(res, 400, "bad_json", "Expected a JSON object request body");
    return;
  }

  const action = normalizeScheduleAction(textField(body, "action"));
  const auditReason = textField(body, "audit_reason") ?? textField(body, "reason");
  const planId = textField(body, "plan_id") ?? textField(body, "planId");
  const sliceId = textField(body, "slice_id") ?? textField(body, "sliceId") ?? "phase-6-afe-and-scheduler-integration";
  const actor = textField(body, "actor") ?? "standalone-architect-browser";

  if (!action) {
    jsonError(res, 400, "bad_request", "Missing or unsupported schedule action");
    return;
  }
  if (!auditReason) {
    jsonError(res, 400, "bad_request", "Missing audit_reason");
    return;
  }
  if (planId) {
    const auditPlan = await loadArchitectPlanDetail(planId);
    if (!auditPlan) {
      jsonError(res, 404, "not_found", `No Architect plan with id: ${planId}`);
      return;
    }
  }

  let actionResult: unknown;
  try {
    if (action === "run_now") {
      actionResult = await runScheduleNow(scheduleId);
    } else {
      const updated = await updateSchedule(scheduleId, { enabled: action === "resume" });
      if (!updated) {
        jsonError(res, 404, "not_found", `No schedule with id: ${scheduleId}`);
        return;
      }
      actionResult = updated;
    }
  } catch (error) {
    const message = (error as Error).message;
    const statusCode = message.startsWith("Schedule not found:") ? 404 : 409;
    jsonError(res, statusCode, "schedule_action_failed", message);
    return;
  }

  const planAudit = planId
    ? await recordPlanActionAudit(planId, {
        kind: "plan_action",
        action: `scheduler:${action}`,
        audit_reason: auditReason,
        actor,
        slice_id: sliceId,
        evidence: `schedule:${scheduleId}`,
        content: "Standalone Architect scheduler action executed through daemon-governed Phase 6 endpoint.",
      })
    : null;

  const result = {
    schedule_id: scheduleId,
    action,
    status: "recorded",
    changed: true,
    audit_scope: planAudit ? "plan_implementation_log" : "daemon_event_stream",
    plan_audit: planAudit,
    action_result: actionResult,
    guardRails: [
      "The browser requested a governed scheduler action; the daemon executed the scheduler operation.",
      "Plan-linked actions are captured in the append-only implementation log when plan_id is supplied.",
    ],
  };

  publishEvent("architect.schedule_action", result);
  json(res, 200, {
    ok: true,
    contract: "architect",
    version: "v1",
    ...buildMeta(),
    result,
  });
}

function renderArchitectShell(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DreamGraph Architect</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0f1412;
      --panel: rgba(23, 32, 29, 0.96);
      --panel-strong: #1d2925;
      --ink: #edf5ee;
      --muted: #a9b8af;
      --line: rgba(237, 245, 238, 0.16);
      --accent: #68d8b6;
      --accent-soft: rgba(104, 216, 182, 0.16);
      --processing: #39a7ff;
      --warn: #f2b56b;
      --danger: #ff8d8d;
      --shadow: 0 18px 44px rgba(0, 0, 0, 0.32);
      --mono: "JetBrains Mono", "Cascadia Code", "IBM Plex Mono", "SFMono-Regular", Consolas, monospace;
      --sans: "IBM Plex Sans", "Inter", "Segoe UI Variable", "Segoe UI", "Aptos", sans-serif;
      --data-font: "Cascadia Code", "IBM Plex Mono", "SFMono-Regular", Consolas, monospace;
      --architect-left-sidebar-width: 280px;
      --architect-right-sidebar-width: 360px;
    }
    * { box-sizing: border-box; }
    html,
    body {
      height: 100%;
    }
    body {
      margin: 0;
      font-family: var(--sans);
      color: var(--ink);
      background: var(--bg);
      min-height: 100vh;
      overflow: hidden;
    }
    main {
      display: grid;
      grid-template-columns: minmax(42px, var(--architect-left-sidebar-width)) minmax(360px, 1fr) minmax(42px, var(--architect-right-sidebar-width));
      gap: 10px;
      height: 100vh;
      padding: 10px;
      align-items: stretch;
      overflow: hidden;
    }
    body.architect-left-collapsed main {
      grid-template-columns: 42px minmax(360px, 1fr) minmax(42px, var(--architect-right-sidebar-width));
    }
    body.architect-right-collapsed main {
      grid-template-columns: minmax(42px, var(--architect-left-sidebar-width)) minmax(360px, 1fr) 42px;
    }
    body.architect-left-collapsed.architect-right-collapsed main {
      grid-template-columns: 42px minmax(360px, 1fr) 42px;
    }
    section {
      min-width: 0;
    }
    .panel {
      min-width: 0;
      min-height: 0;
      overflow: hidden;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(10px);
    }
    .rail {
      display: grid;
      grid-template-rows: auto auto auto minmax(0, 1fr) auto;
      gap: 6px;
      max-height: calc(100vh - 20px);
      padding: 8px;
      position: relative;
    }
    .content {
      position: relative;
    }
    .architect-sidebar-collapse {
      position: absolute;
      top: 6px;
      z-index: 25;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border: 1px solid var(--line);
      border-radius: 5px;
      background: rgba(104, 216, 182, 0.1);
      color: var(--ink);
      cursor: pointer;
      font: 800 0.66rem/1 var(--sans);
    }
    [data-architect-sidebar="left"] > .architect-sidebar-collapse { right: 6px; }
    [data-architect-sidebar="right"] > .architect-sidebar-collapse { left: 6px; }
    .architect-sidebar-collapse:hover,
    .architect-sidebar-collapse:focus-visible {
      border-color: rgba(104, 216, 182, 0.5);
      outline: none;
    }
    .architect-sidebar-handle {
      position: absolute;
      top: 0;
      bottom: 0;
      z-index: 24;
      width: 8px;
      cursor: col-resize;
      touch-action: none;
    }
    [data-architect-sidebar="left"] .architect-sidebar-handle { right: -4px; }
    [data-architect-sidebar="right"] .architect-sidebar-handle { left: -4px; }
    .architect-sidebar-handle::after {
      content: "";
      position: absolute;
      top: 12px;
      bottom: 12px;
      left: 3px;
      width: 2px;
      border-radius: 999px;
      background: rgba(104, 216, 182, 0.26);
    }
    .architect-sidebar-handle:hover::after,
    .architect-sidebar-handle:focus-visible::after,
    .architect-sidebar-handle.is-resizing::after {
      background: rgba(104, 216, 182, 0.9);
    }
    body.architect-resizing {
      cursor: col-resize;
      user-select: none;
    }
    .section-title {
      margin: 0 0 6px;
      padding-right: 30px;
      font-size: 0.68rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .plan-toolbar {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 5px;
      margin-bottom: 6px;
    }
    .plan-toolbar .mini-button {
      min-height: 26px;
      padding: 4px 6px;
      font-size: 0.66rem;
      line-height: 1.1;
    }
    .mini-button.danger {
      background: rgba(255, 141, 141, 0.1);
    }
    .mini-button.danger:hover {
      border-color: rgba(255, 141, 141, 0.48);
      background: rgba(255, 141, 141, 0.16);
    }
    .mini-button:disabled {
      cursor: not-allowed;
      opacity: 0.58;
    }
    .plan-filters {
      display: grid;
      grid-template-columns: 1fr;
      gap: 5px;
      margin-bottom: 6px;
    }
    .plan-filter-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 5px;
    }
    .plan-filter-field {
      display: grid;
      gap: 2px;
      color: var(--muted);
      font-size: 0.56rem;
      line-height: 1.1;
      text-transform: uppercase;
    }
    .plan-filter-field input,
    .plan-filter-field select {
      min-width: 0;
      width: 100%;
      box-sizing: border-box;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.045);
      color: var(--ink);
      padding: 5px 6px;
      font: 0.66rem/1.2 var(--sans);
    }
    .plan-list {
      display: grid;
      gap: 6px;
      min-height: 0;
      overflow: auto;
      align-content: start;
      padding-right: 3px;
    }
    .plan-tree-group {
      display: grid;
      gap: 4px;
    }
    .plan-tree-heading {
      display: flex;
      justify-content: space-between;
      gap: 6px;
      padding: 0 2px;
      color: var(--muted);
      font-size: 0.58rem;
      line-height: 1.2;
      text-transform: uppercase;
    }
    .plan-tree-children {
      display: grid;
      gap: 5px;
    }
    .stack {
      display: grid;
      gap: 8px;
    }
    button.plan-item {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 0;
      width: 100%;
      min-width: 0;
      height: auto;
      min-height: unset;
      box-sizing: border-box;
      text-align: left;
      border: 1px solid var(--line);
      background: var(--panel-strong);
      border-radius: 6px;
      padding: 0.35rem 0.45rem;
      color: inherit;
      cursor: pointer;
      font-size: 0.62rem;
      line-height: 1.2;
      white-space: normal;
      overflow: visible;
      overflow-wrap: anywhere;
      word-break: normal;
      transition: border-color 140ms ease, background 140ms ease;
    }
    button.plan-item:hover {
      border-color: rgba(104, 216, 182, 0.4);
      background: #24342f;
    }
    button.plan-item.active {
      border-color: rgba(104, 216, 182, 0.5);
      background: var(--accent-soft);
    }
    button.plan-item.has-current-slice {
      box-shadow: inset 3px 0 0 rgba(104, 216, 182, 0.72);
    }
    .plan-slice-child {
      margin-top: 0.25rem;
      padding: 0.25rem 0.35rem;
      border-left: 1px solid rgba(104, 216, 182, 0.42);
      background: rgba(104, 216, 182, 0.08);
      color: var(--muted);
      font-size: 0.6rem;
      line-height: 1.2;
      overflow-wrap: anywhere;
    }
    button.plan-item .plan-title {
      display: -webkit-box;
      max-width: 100%;
      overflow: hidden;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      font-weight: 700;
      font-size: 0.78rem;
      line-height: 1.15;
      white-space: normal;
      overflow-wrap: anywhere;
      text-overflow: ellipsis;
    }
    button.plan-item .plan-meta {
      display: block;
      max-width: 100%;
      margin-top: 0.15rem;
      overflow: visible;
      font-size: 0.62rem;
      line-height: 1.2;
      color: var(--muted);
      white-space: normal;
      overflow-wrap: anywhere;
    }
    .meta {
      font-size: 0.6rem;
      line-height: 1.18;
      color: var(--muted);
      overflow-wrap: anywhere;
    }
    .adr-preview-trigger {
      border: 1px solid rgba(104, 216, 182, 0.32);
      border-radius: 6px;
      padding: 0.05rem 0.28rem;
      background: rgba(104, 216, 182, 0.1);
      color: var(--accent);
      font: inherit;
      cursor: help;
    }
    .adr-preview-card {
      margin-top: 0.35rem;
      border: 1px solid rgba(104, 216, 182, 0.24);
      border-radius: 8px;
      padding: 0.45rem;
      background: #101916;
      color: var(--ink);
      font-size: 0.66rem;
      line-height: 1.32;
    }
    .adr-preview-card strong {
      display: block;
      margin-bottom: 0.2rem;
      color: var(--accent);
    }
    .adr-preview-status {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem;
      margin: 0.25rem 0;
    }
    .adr-preview-status span {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 0.08rem 0.32rem;
      color: var(--muted);
      font-size: 0.58rem;
    }
    .adr-editor {
      display: grid;
      gap: 7px;
    }
    .adr-editor-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(92px, 0.38fr);
      gap: 6px;
    }
    .adr-editor label {
      display: grid;
      gap: 3px;
      color: var(--muted);
      font-size: 0.62rem;
      line-height: 1.15;
      text-transform: uppercase;
    }
    .adr-editor input,
    .adr-editor select,
    .adr-editor textarea {
      width: 100%;
      min-width: 0;
      box-sizing: border-box;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #111815;
      color: var(--ink);
      padding: 6px 7px;
      font: 0.72rem/1.3 var(--sans);
    }
    .adr-editor textarea {
      min-height: 72px;
      resize: vertical;
    }
    .adr-editor-warning {
      border: 1px solid rgba(242, 181, 107, 0.34);
      border-radius: 7px;
      padding: 6px 7px;
      background: rgba(242, 181, 107, 0.08);
      color: var(--warn);
      font-size: 0.68rem;
      line-height: 1.3;
    }
    .content,
    .chat-panel {
      max-height: calc(100vh - 20px);
      padding: 10px;
    }
    .content {
      overflow: auto;
    }
    .runtime-strip {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 0;
    }
    .runtime-pill {
      min-width: 0;
      max-width: 100%;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 6px 8px;
      background: rgba(255, 255, 255, 0.045);
      color: var(--muted);
      font-size: 0.72rem;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .chat-panel {
      display: grid;
      grid-template-rows: auto auto auto minmax(0, 1fr);
      gap: 8px;
      overflow: hidden;
    }
    .architect-center-tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      border-bottom: 1px solid var(--line);
      padding-bottom: 6px;
    }
    .architect-tab-button {
      min-height: 28px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.045);
      color: var(--muted);
      cursor: pointer;
      padding: 4px 9px;
      font: 700 0.72rem/1.2 var(--sans);
    }
    .architect-tab-button[aria-selected="true"] {
      border-color: rgba(104, 216, 182, 0.54);
      background: var(--accent-soft);
      color: var(--accent);
    }
    .architect-tab-panels {
      min-height: 0;
      overflow: hidden;
    }
    .architect-tab-panel {
      min-height: 0;
      height: 100%;
      overflow: hidden;
    }
    .architect-tab-panel.chat-workspace {
      display: grid;
      grid-template-rows: minmax(0, 1fr) auto;
      gap: 8px;
    }
    .architect-tab-panel[hidden] {
      display: none !important;
    }
    .architect-tab-panel.plan-workspace,
    .architect-tab-panel.adr-workspace {
      overflow: auto;
      padding-right: 4px;
    }
    .architect-tab-panel h2 {
      margin: 0 0 8px;
      font-size: 1rem;
      line-height: 1.2;
    }
    .runtime-controls {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 6px;
      align-items: end;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px;
      background: rgba(255, 255, 255, 0.045);
    }
    .control-field {
      display: grid;
      gap: 3px;
      min-width: 0;
      color: var(--muted);
      font-size: 0.66rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .control-field select,
    .control-field input,
    .pass-view {
      width: 100%;
      min-width: 0;
      height: 28px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #111815;
      color: var(--ink);
      padding: 4px 6px;
      font: 0.72rem/1.2 var(--sans);
    }
    .control-field option {
      background: #111815;
      color: var(--ink);
    }
    .control-field select:disabled {
      color: var(--muted);
      opacity: 0.82;
    }
    .pass-view {
      display: inline-flex;
      align-items: center;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--accent);
    }
    .chat-log {
      display: grid;
      gap: 8px;
      align-content: start;
      min-height: 0;
      overflow: auto;
      padding-right: 4px;
      font-size: 0.82rem;
    }
    .chat-message {
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px 10px;
      background: rgba(255, 255, 255, 0.045);
      font-size: 0.82rem;
      line-height: 1.36;
      overflow-wrap: anywhere;
    }
    .chat-message-body {
      display: grid;
      gap: 8px;
      min-width: 0;
      white-space: normal;
    }
    .chat-message-body p,
    .chat-message-body ul,
    .chat-message-body ol,
    .chat-message-body pre,
    .chat-message-body details {
      margin: 0;
    }
    .chat-message-body ul,
    .chat-message-body ol {
      padding-left: 18px;
    }
    .chat-message-body li {
      margin: 2px 0;
    }
    .chat-message-body code {
      font-family: var(--mono);
      font-size: 0.9em;
      color: var(--accent);
    }
    .chat-heading {
      display: block;
      color: var(--accent);
      font-size: 0.82rem;
      font-weight: 800;
    }
    .chat-inline-heading {
      display: inline;
      margin: 0;
      color: var(--accent);
      font-size: inherit;
      font-weight: 800;
      text-transform: none;
      letter-spacing: 0;
    }
    .chat-card {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.04);
      padding: 8px 10px;
    }
    .chat-card pre {
      max-height: 28vh;
      margin-top: 8px;
      padding: 10px;
      font-size: 0.74rem;
    }
    .chat-card-title {
      display: block;
      margin-bottom: 5px;
      color: var(--accent);
      font-size: 0.72rem;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .tool-trace-panel {
      border: 0;
      padding: 0;
      background: transparent;
    }
    .tool-trace-panel > summary {
      cursor: pointer;
      color: var(--accent);
      font-size: 0.76rem;
      font-weight: 800;
      text-transform: uppercase;
    }
    .tool-trace-list {
      display: grid;
      gap: 6px;
      margin-top: 6px;
    }
    .tool-trace-row {
      display: grid;
      gap: 5px;
      border: 1px solid rgba(57, 167, 255, 0.28);
      border-radius: 6px;
      padding: 7px 8px;
      background: rgba(57, 167, 255, 0.06);
    }
    .tool-trace-header {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      font-size: 0.72rem;
      font-weight: 700;
    }
    .tool-trace-pill {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 2px 6px;
      color: var(--muted);
      font-size: 0.66rem;
      font-weight: 700;
    }
    .tool-trace-pill.status-running,
    .tool-trace-pill.status-pending {
      border-color: rgba(255, 198, 109, 0.54);
      color: #ffd38a;
    }
    .tool-trace-pill.status-completed {
      border-color: rgba(104, 216, 182, 0.52);
      color: #82e6c8;
    }
    .tool-trace-pill.status-failed {
      border-color: rgba(255, 122, 122, 0.52);
      color: #ff9b9b;
    }
    .tool-trace-row details {
      padding: 0;
      background: transparent;
    }
    .tool-trace-row summary {
      color: var(--accent);
      font-size: 0.68rem;
      font-weight: 800;
      text-transform: uppercase;
    }
    .chat-message.user {
      border-color: rgba(104, 216, 182, 0.42);
      background: rgba(104, 216, 182, 0.1);
    }
    .chat-message.tool {
      border-color: rgba(57, 167, 255, 0.42);
      background: rgba(57, 167, 255, 0.08);
    }
    .chat-message strong {
      display: block;
      margin-bottom: 5px;
      font-size: 0.68rem;
      color: var(--muted);
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .chat-message .chat-inline-heading {
      display: inline;
      margin: 0;
      color: var(--accent);
      font-size: inherit;
      text-transform: none;
      letter-spacing: 0;
    }
    .chat-form {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-areas:
        "input actions"
        "status status";
      gap: 8px;
      align-items: end;
    }
    .prompt-surface {
      grid-area: input;
      position: relative;
      min-width: 0;
    }
    .chat-input {
      width: 100%;
      min-height: 48px;
      max-height: 26vh;
      resize: none;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.055);
      color: var(--ink);
      padding: 30px 10px 10px;
      font: 0.82rem/1.34 var(--sans);
      overflow: auto;
    }
    .chat-input:focus {
      outline: 2px solid rgba(104, 216, 182, 0.32);
      border-color: rgba(104, 216, 182, 0.52);
    }
    .chat-submit-row {
      grid-area: actions;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
    }
    .chat-submit-row .action-button {
      width: auto;
      min-width: 86px;
    }
    .scope-pill {
      position: absolute;
      top: 7px;
      left: 8px;
      z-index: 1;
      max-width: min(280px, calc(100% - 16px));
      height: 18px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.055);
      color: var(--muted);
      cursor: pointer;
      padding: 1px 7px;
      font-size: 0.68rem;
      font-weight: 700;
      line-height: 1.2;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .scope-pill:hover {
      border-color: rgba(255, 255, 255, 0.2);
      background: rgba(255, 255, 255, 0.08);
      color: var(--ink);
    }
    .scope-pill[data-scope="project"] {
      border-color: rgba(57, 167, 255, 0.2);
      background: rgba(57, 167, 255, 0.065);
    }
    .scope-pill:disabled {
      cursor: not-allowed;
      opacity: 0.62;
    }
    .processing-light {
      width: 14px;
      height: 14px;
      border: 2px solid rgba(57, 167, 255, 0.22);
      border-top-color: var(--processing);
      border-radius: 999px;
      box-shadow: 0 0 18px rgba(57, 167, 255, 0.72);
      opacity: 0;
      visibility: hidden;
    }
    .chat-form.processing .processing-light {
      opacity: 1;
      visibility: visible;
      animation: architectProcessingRing 820ms linear infinite;
    }
    .chat-form .status {
      grid-area: status;
      margin-top: 0;
    }
    .action-button:disabled,
    .chat-input:disabled {
      cursor: not-allowed;
      opacity: 0.62;
    }
    @keyframes architectProcessingRing {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 6px 0 10px;
    }
    .chip {
      max-width: 100%;
      border-radius: 999px;
      padding: 4px 7px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 0.7rem;
      line-height: 1.2;
      overflow-wrap: anywhere;
    }
    .chip.warn {
      background: rgba(242, 181, 107, 0.14);
      color: var(--warn);
    }
    .dense-list {
      margin: 0;
      padding: 0;
      list-style: none;
      display: grid;
      gap: 6px;
    }
    .dense-list li {
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 7px 8px;
      background: rgba(255, 255, 255, 0.045);
      overflow-wrap: anywhere;
    }
    .dense-list strong {
      display: block;
      margin-bottom: 4px;
      font-size: 0.9rem;
    }
    .empty {
      color: var(--muted);
    }
    .action-row {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .action-button {
      width: 100%;
      min-width: 0;
      min-height: 36px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: var(--panel-strong);
      color: var(--ink);
      cursor: pointer;
      font-weight: 600;
      padding: 6px 8px;
      overflow-wrap: anywhere;
    }
    .action-button:hover {
      border-color: rgba(104, 216, 182, 0.46);
      background: #24342f;
    }
    .inline-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }
    .mini-button {
      min-width: 0;
      max-width: 100%;
      min-height: 32px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: rgba(104, 216, 182, 0.1);
      color: var(--ink);
      cursor: pointer;
      padding: 6px 8px;
      font-size: 0.78rem;
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .mini-button:hover {
      border-color: rgba(104, 216, 182, 0.5);
      background: rgba(104, 216, 182, 0.18);
    }
    .inline-actions > * {
      flex: 1 1 132px;
    }
    a {
      color: var(--accent);
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
    details {
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 8px 9px 10px;
      background: rgba(255, 255, 255, 0.045);
    }
    summary {
      cursor: pointer;
      font-weight: 600;
    }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      background: rgba(255, 255, 255, 0.055);
      font-family: var(--mono);
      font-size: 0.84rem;
      line-height: 1.45;
      max-height: 46vh;
      overflow: auto;
      margin-bottom: 0;
    }
    .event-log {
      display: grid;
      gap: 6px;
      max-height: 220px;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px;
      background: rgba(255, 255, 255, 0.045);
      font-size: 0.72rem;
      line-height: 1.32;
    }
    .event-row {
      display: grid;
      gap: 4px;
      border-bottom: 1px solid rgba(237, 245, 238, 0.08);
      padding-bottom: 6px;
      color: var(--muted);
      overflow-wrap: anywhere;
    }
    .event-row:first-child {
      color: var(--ink);
    }
    .event-row:last-child {
      border-bottom: 0;
      padding-bottom: 0;
    }
    .event-row-tag {
      width: fit-content;
      border: 1px solid rgba(104, 216, 182, 0.28);
      border-radius: 999px;
      padding: 2px 6px;
      color: var(--accent);
      font-size: 0.62rem;
      font-weight: 700;
      text-transform: uppercase;
    }
    .event-json {
      padding: 6px 8px;
    }
    .event-json pre {
      max-height: 180px;
      margin-top: 6px;
      padding: 8px;
      font-size: 0.68rem;
    }
    .status {
      margin-top: 12px;
      color: var(--muted);
      font-size: 0.82rem;
    }
    #rail-status {
      font-size: 0.58rem;
      line-height: 1.18;
      overflow-wrap: anywhere;
    }
    @media (max-width: 920px) {
      body {
        overflow: auto;
      }
      main {
        grid-template-columns: 1fr;
        height: auto;
        min-height: 100vh;
        overflow: visible;
      }
      .panel,
      .rail,
      .content,
      .chat-panel {
        max-height: none;
      }
      .chat-panel {
        min-height: 72vh;
        order: 1;
      }
      .rail {
        grid-template-rows: auto auto auto auto;
        order: 2;
      }
      .plan-list {
        max-height: 36vh;
      }
      .content {
        order: 3;
      }
    }
    @media (max-width: 640px) {
      main {
        gap: 12px;
        padding: 10px;
      }
      .rail,
      .content,
      .chat-panel {
        padding: 12px;
      }
      .action-row {
        grid-template-columns: 1fr;
      }
      .inline-actions,
      .runtime-controls {
        display: grid;
        grid-template-columns: 1fr;
      }
      pre {
        max-height: 34vh;
      }
    }
  </style>
</head>
<body>
  <main>
    <section class="panel rail" data-architect-sidebar="left">
      <button class="architect-sidebar-collapse" data-architect-collapse="left" type="button" aria-label="Collapse plans sidebar" title="Collapse plans sidebar"><</button>
      <h2 class="section-title">Plans</h2>
      <div class="plan-toolbar" aria-label="Plan actions">
        <button id="create-plan-button" class="mini-button" type="button">New Plan</button>
        <button id="archive-plan-button" class="mini-button danger" type="button" disabled>Archive</button>
      </div>
      <div class="plan-filters" aria-label="Plan filters">
        <label class="plan-filter-field">Search
          <input id="plan-search-input" type="search" autocomplete="off" placeholder="Title, id, slice">
        </label>
        <div class="plan-filter-row">
          <label class="plan-filter-field">Status
            <select id="plan-status-filter"><option value="">All</option></select>
          </label>
          <label class="plan-filter-field">Phase
            <select id="plan-phase-filter"><option value="">All</option></select>
          </label>
        </div>
      </div>
      <div id="plan-list" class="plan-list"></div>
      <p id="rail-status" class="status">Loading project plans...</p>
      <div class="architect-sidebar-handle" data-architect-resize-handle="left" role="separator" aria-orientation="vertical" aria-label="Resize plans sidebar" tabindex="0"></div>
    </section>
    <section class="panel chat-panel">
      <div class="runtime-strip" aria-label="Architect runtime">
        <span id="project-scope" class="runtime-pill">Project scope loading...</span>
        <span id="architect-model-config" class="runtime-pill">Architect model loading...</span>
        <span id="live-event-status" class="runtime-pill">Events connecting...</span>
      </div>
      <div class="runtime-controls" aria-label="Architect controls">
        <label class="control-field">Provider / Adapter
          <select id="architect-adapter-select">
            <option value="native_api_tool_loop">Native API tool loop</option>
            <option value="codex-cli">Codex CLI</option>
            <option value="copilot-cli">Copilot CLI</option>
            <option value="deterministic_fallback">Deterministic fallback</option>
          </select>
        </label>
        <label class="control-field">API Provider
          <select id="architect-provider-select">
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="ollama">Ollama</option>
            <option value="lmstudio">LM Studio</option>
            <option value="sampling">Sampling</option>
            <option value="none">None</option>
          </select>
        </label>
        <label class="control-field">Model
          <select id="architect-model-input"></select>
        </label>
        <label class="control-field">Autonomy
          <select id="architect-autonomy-mode-select">
            <option value="autonomous">Autonomous</option>
            <option value="supervised">Supervised</option>
            <option value="manual">Manual</option>
          </select>
        </label>
        <label class="control-field">Passes
          <span id="architect-pass-view" class="pass-view">0 passes | 0 tools</span>
        </label>
      </div>
      <div class="architect-center-tabs" role="tablist" aria-label="Center workspace">
        <button id="architect-tab-chat" class="architect-tab-button" type="button" role="tab" aria-selected="true" aria-controls="architect-panel-chat" data-architect-tab="chat">Chat</button>
        <button id="architect-tab-plan" class="architect-tab-button" type="button" role="tab" aria-selected="false" aria-controls="architect-panel-plan" data-architect-tab="plan">Plan</button>
        <button id="architect-tab-adr" class="architect-tab-button" type="button" role="tab" aria-selected="false" aria-controls="architect-panel-adr" data-architect-tab="adr">ADR Editor</button>
      </div>
      <div class="architect-tab-panels">
        <div id="architect-panel-chat" class="architect-tab-panel chat-workspace" role="tabpanel" aria-labelledby="architect-tab-chat" data-architect-tab-panel="chat">
          <div id="chat-log" class="chat-log" aria-live="polite"></div>
          <form id="chat-form" class="chat-form">
            <div class="prompt-surface">
              <button id="chat-scope-pill" class="scope-pill" type="button" data-scope="project" aria-pressed="false" aria-label="Toggle chat scope">🌍 Project</button>
              <textarea id="chat-input" class="chat-input" name="message" placeholder="Ask Architect about this project or the selected plan..."></textarea>
            </div>
            <div class="chat-submit-row">
              <span id="chat-processing-light" class="processing-light" aria-hidden="true"></span>
              <button id="chat-submit" class="action-button" type="submit">Send</button>
            </div>
            <p id="chat-status" class="status">Architect chat is bound to the active project and daemon configuration.</p>
          </form>
        </div>
        <div id="architect-panel-plan" class="architect-tab-panel plan-workspace" role="tabpanel" aria-labelledby="architect-tab-plan" data-architect-tab-panel="plan" hidden>
          <h2 id="center-plan-title">No plan selected</h2>
          <div id="center-plan-chips" class="chips"></div>
          <details class="architect-plan-snapshot" open>
            <summary>Raw Markdown Snapshot</summary>
            <pre id="center-plan-body">Select a plan to view its raw markdown snapshot.</pre>
          </details>
        </div>
        <div id="architect-panel-adr" class="architect-tab-panel adr-workspace" role="tabpanel" aria-labelledby="architect-tab-adr" data-architect-tab-panel="adr" hidden>
          <h2>ADR Editor</h2>
          <div id="adr-editor" class="adr-editor" aria-live="polite">
            <p id="adr-editor-status" class="status">Open an ADR from bindings, preview, or chat reference.</p>
          </div>
        </div>
      </div>
    </section>
    <section class="panel content" data-architect-sidebar="right">
      <h2 id="plan-title">No plan selected</h2>
      <div id="plan-chips" class="chips"></div>
      <div class="stack" id="right-sidebar-stack">
        <details class="architect-right-accordion" open>
          <summary>Registry Summary</summary>
          <div id="registry-summary" class="chips"></div>
        </details>
        <details class="architect-right-accordion">
          <summary>Governed Actions</summary>
          <div class="action-row">
            <button id="record-action-button" class="action-button" type="button">Record Action</button>
            <button id="review-gate-button" class="action-button" type="button">Review Gate</button>
          </div>
          <p id="action-status" class="status">Select a plan to record governed actions.</p>
        </details>
        <details class="architect-right-accordion">
          <summary>Adaptive Future Review</summary>
          <div id="future-summary" class="chips"></div>
          <ul id="future-candidate-list" class="dense-list"></ul>
          <div id="future-decision-buttons" class="inline-actions"></div>
          <p id="future-status" class="status">Select a plan to load advisory future review.</p>
        </details>
        <details class="architect-right-accordion">
          <summary>Scheduler and Dreams</summary>
          <div id="schedule-summary" class="chips"></div>
          <ul id="schedule-list" class="dense-list"></ul>
          <p id="schedule-status" class="status">Scheduler projection not loaded yet.</p>
        </details>
        <details class="architect-right-accordion">
          <summary>ADR Bindings</summary>
          <ul id="adr-list" class="dense-list"></ul>
        </details>
        <details class="architect-right-accordion">
          <summary>Graph Bindings</summary>
          <ul id="graph-binding-list" class="dense-list"></ul>
        </details>
        <details class="architect-right-accordion">
          <summary>Slices</summary>
          <ul id="slice-list" class="dense-list"></ul>
        </details>
        <details class="architect-right-accordion">
          <summary>Checkpoints</summary>
          <ul id="checkpoint-list" class="dense-list"></ul>
        </details>
        <details class="architect-right-accordion">
          <summary>Evidence Links</summary>
          <ul id="evidence-link-list" class="dense-list"></ul>
        </details>
        <details class="architect-right-accordion">
          <summary>VS Code Escape Hatches</summary>
          <ul id="vscode-link-list" class="dense-list"></ul>
        </details>
        <details class="architect-right-accordion">
          <summary>Raw Markdown Snapshot</summary>
          <pre id="plan-body">Select a plan to view its raw markdown snapshot.</pre>
        </details>
        <details class="architect-right-accordion" open>
          <summary>Live Events</summary>
          <div id="event-log" class="event-log" role="log" aria-live="polite">Connecting...</div>
        </details>
      </div>
      <button class="architect-sidebar-collapse" data-architect-collapse="right" type="button" aria-label="Collapse context sidebar" title="Collapse context sidebar">></button>
      <div class="architect-sidebar-handle" data-architect-resize-handle="right" role="separator" aria-orientation="vertical" aria-label="Resize context sidebar" tabindex="0"></div>
    </section>
  </main>
  <script>
    const initialRuntimePayload = ${JSON.stringify(buildMeta()).replace(/</g, "\\u003c")};
    const planListEl = document.getElementById('plan-list');
    const planSearchInputEl = document.getElementById('plan-search-input');
    const planStatusFilterEl = document.getElementById('plan-status-filter');
    const planPhaseFilterEl = document.getElementById('plan-phase-filter');
    const createPlanButtonEl = document.getElementById('create-plan-button');
    const archivePlanButtonEl = document.getElementById('archive-plan-button');
    const railStatusEl = document.getElementById('rail-status');
    const planTitleEl = document.getElementById('plan-title');
    const planChipsEl = document.getElementById('plan-chips');
    const centerPlanTitleEl = document.getElementById('center-plan-title');
    const centerPlanChipsEl = document.getElementById('center-plan-chips');
    const registrySummaryEl = document.getElementById('registry-summary');
    const projectScopeEl = document.getElementById('project-scope');
    const architectModelConfigEl = document.getElementById('architect-model-config');
    const liveEventStatusEl = document.getElementById('live-event-status');
    const chatLogEl = document.getElementById('chat-log');
    const chatFormEl = document.getElementById('chat-form');
    const chatInputEl = document.getElementById('chat-input');
    const chatScopePillEl = document.getElementById('chat-scope-pill');
    const chatSubmitEl = document.getElementById('chat-submit');
    const chatProcessingLightEl = document.getElementById('chat-processing-light');
    const chatStatusEl = document.getElementById('chat-status');
    const architectAdapterSelectEl = document.getElementById('architect-adapter-select');
    const architectProviderSelectEl = document.getElementById('architect-provider-select');
    const architectModelInputEl = document.getElementById('architect-model-input');
    const architectAutonomyModeSelectEl = document.getElementById('architect-autonomy-mode-select');
    const architectPassViewEl = document.getElementById('architect-pass-view');
    const recordActionButtonEl = document.getElementById('record-action-button');
    const reviewGateButtonEl = document.getElementById('review-gate-button');
    const actionStatusEl = document.getElementById('action-status');
    const futureSummaryEl = document.getElementById('future-summary');
    const futureCandidateListEl = document.getElementById('future-candidate-list');
    const futureDecisionButtonsEl = document.getElementById('future-decision-buttons');
    const futureStatusEl = document.getElementById('future-status');
    const scheduleSummaryEl = document.getElementById('schedule-summary');
    const scheduleListEl = document.getElementById('schedule-list');
    const scheduleStatusEl = document.getElementById('schedule-status');
    const adrEditorEl = document.getElementById('adr-editor');
    const adrEditorStatusEl = document.getElementById('adr-editor-status');
    const adrListEl = document.getElementById('adr-list');
    const graphBindingListEl = document.getElementById('graph-binding-list');
    const sliceListEl = document.getElementById('slice-list');
    const checkpointListEl = document.getElementById('checkpoint-list');
    const evidenceLinkListEl = document.getElementById('evidence-link-list');
    const vscodeLinkListEl = document.getElementById('vscode-link-list');
    const planBodyEl = document.getElementById('plan-body');
    const centerPlanBodyEl = document.getElementById('center-plan-body');
    const eventLogEl = document.getElementById('event-log');
    let activePlanId = null;
    let activePlanButton = null;
    let activePlanLoadToken = 0;
    let planIndexCache = [];
    let planTreeCache = [];
    let planFilterProjection = { status_options: [], phase_options: [] };
    let futureDecisionTemplates = [];
    let chatProcessing = false;
    let liveToolTraceSeen = false;
    let activeToolTracePanel = null;
    let activeToolTraceRows = new Map();
    let adrPreviewCache = new Map();
    let activeAdrEditorId = null;
    let activeAdrEditorPayload = null;
    let autonomyPassCount = 0;
    let architectControlPersistTimer = 0;
    let lastNativeArchitectProvider = '';
    let activeArchitectRuntime = (initialRuntimePayload && (initialRuntimePayload.runtime || initialRuntimePayload.architect_runtime || initialRuntimePayload.architect_llm)) || {};
    let lastPersistedPlanId = initialRuntimePayload && (initialRuntimePayload.selected_plan_id || (initialRuntimePayload.architect_selection && initialRuntimePayload.architect_selection.selected_plan_id)) || null;
    let activeChatScope = lastPersistedPlanId ? 'plan' : 'project';
    const architectControlStorageKey = 'architect.chat.controls.v1';
    const architectCenterTabButtons = Array.from(document.querySelectorAll('[data-architect-tab]'));
    const architectCenterTabPanels = Array.from(document.querySelectorAll('[data-architect-tab-panel]'));
    const architectCenterTabStorageKey = 'architect.center.tab.v1';
    const architectModelOptionsByProvider = {
      anthropic: ['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
      openai: ['gpt-5.5', 'gpt-5', 'gpt-5.4', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o-mini', 'o3', 'o4-mini'],
      ollama: ['qwen3:8b', 'llama3.1', 'mistral', 'codellama'],
      lmstudio: ['local-model'],
      sampling: ['client'],
      none: [''],
      'copilot-cli': ['claude-opus-4.7', 'claude-opus-4.6', 'gpt-5.5', 'gpt-5.4', 'gpt-4o', 'claude-sonnet-4.6', 'auto'],
      'codex-cli': ['gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.2', 'gpt-5-mini', 'auto'],
    };

    function resolveArchitectCenterTab(tabId) {
      const requested = tabId || 'chat';
      return architectCenterTabButtons.some(function(button) { return button.dataset.architectTab === requested; }) ? requested : 'chat';
    }

    function setArchitectCenterTab(tabId) {
      const normalized = resolveArchitectCenterTab(tabId);
      for (const button of architectCenterTabButtons) {
        const selected = button.dataset.architectTab === normalized;
        button.setAttribute('aria-selected', selected ? 'true' : 'false');
      }
      for (const panel of architectCenterTabPanels) {
        panel.hidden = panel.dataset.architectTabPanel !== normalized;
      }
      try { window.localStorage.setItem(architectCenterTabStorageKey, normalized); } catch (_) { /* storage may be unavailable */ }
    }

    function hydrateArchitectCenterTabs() {
      for (const button of architectCenterTabButtons) {
        button.addEventListener('click', function() { setArchitectCenterTab(button.dataset.architectTab || 'chat'); });
      }
      let saved = 'chat';
      try { saved = window.localStorage.getItem(architectCenterTabStorageKey) || 'chat'; } catch (_) { saved = 'chat'; }
      setArchitectCenterTab(saved);
    }

    function cloneChips(source, target) {
      resetNode(target);
      for (const child of Array.from(source.children)) {
        target.appendChild(child.cloneNode(true));
      }
    }

    function renderEventLine(row, line) {
      const text = String(line || '');
      let label = 'event';
      let body = text;
      if (text.charAt(0) === '[') {
        const end = text.indexOf(']');
        if (end > 1) {
          label = text.slice(1, end);
          body = text.slice(end + 1).trim();
        }
      }
      const tag = document.createElement('span');
      tag.className = 'event-row-tag';
      tag.textContent = label;
      row.appendChild(tag);

      const parsed = tryParseJsonPayload(body);
      if (parsed) {
        const summary = document.createElement('span');
        summary.textContent = summarizeJsonObject(parsed.value) || parsed.prefix || 'structured event';
        row.appendChild(summary);
        appendJsonCard(row, parsed.prefix || 'Event payload', parsed.value, 'event-json');
        return;
      }

      const bodyNode = document.createElement('span');
      bodyNode.textContent = body || text;
      row.appendChild(bodyNode);
    }

    function appendEventLine(line) {
      if (eventLogEl.textContent === 'Connecting...') {
        resetNode(eventLogEl);
      }
      const row = document.createElement('div');
      row.className = 'event-row';
      renderEventLine(row, line);
      eventLogEl.insertBefore(row, eventLogEl.firstChild);
      while (eventLogEl.children.length > 16) {
        eventLogEl.removeChild(eventLogEl.lastChild);
      }
    }

    function parseArchitectEvent(event) {
      try {
        return JSON.parse(event.data);
      } catch (error) {
        return {
          seq: '?',
          kind: event.type || 'architect.unknown',
          ts: new Date().toISOString(),
          payload: { status: 'unparseable' },
        };
      }
    }

    function summarizeEventEnvelope(envelope) {
      const payload = envelope.payload || {};
      const route = payload.route || {};
      const runtime = payload.runtime || payload.architect_runtime || route.runtime || payload.architect_llm || {};
      const llm = payload.architect_llm || {};
      const status = payload.status || payload.action || payload.phase || 'updated';
      const adapter = route.adapter || runtime.adapter || llm.adapter || payload.adapter || 'native_api_tool_loop';
      const provider = route.provider || runtime.provider || llm.provider || payload.provider;
      const model = route.completion_model || route.model || runtime.model || llm.model || payload.model;
      const tool = payload.tool ? ' | ' + payload.tool : '';
      const duration = typeof payload.duration_ms === 'number' ? ' | ' + payload.duration_ms + 'ms' : '';
      const modelText = adapter && adapter !== 'native_api_tool_loop'
        ? ' | ' + adapter + '/' + (model || 'none')
        : (provider ? ' | ' + provider + '/' + (model || 'none') : '');
      return '#' + envelope.seq + ' ' + status + tool + duration + modelText;
    }

    function renderLiveEventStatus(envelope, label) {
      liveEventStatusEl.textContent = label + ': ' + summarizeEventEnvelope(envelope);
      liveEventStatusEl.title = (envelope.kind || 'architect.event') + ' | ' + (envelope.ts || 'no timestamp');
    }

    function appendTypedEventLine(label, event) {
      const envelope = parseArchitectEvent(event);
      if (envelope.payload && (envelope.payload.project_scope || envelope.payload.runtime || envelope.payload.architect_runtime || envelope.payload.architect_llm)) {
        renderRuntime(envelope.payload);
      }
      renderLiveEventStatus(envelope, label);
      appendEventLine('[' + label + '] ' + summarizeEventEnvelope(envelope));
      return envelope;
    }

    function setChatProcessing(processing) {
      chatProcessing = processing;
      chatFormEl.classList.toggle('processing', processing);
      chatFormEl.setAttribute('aria-busy', processing ? 'true' : 'false');
      chatSubmitEl.disabled = processing;
      chatScopePillEl.disabled = processing;
      chatInputEl.disabled = processing;
      chatProcessingLightEl.setAttribute('aria-hidden', processing ? 'false' : 'true');
    }

    function runtimeFromPayload(payload) {
      if (!payload) return activeArchitectRuntime || {};
      const result = payload.result || {};
      const route = result.route || {};
      return payload.runtime || payload.architect_runtime || result.runtime || route.runtime || payload.architect_llm || activeArchitectRuntime || {};
    }

    function updateActiveArchitectRuntime(payload) {
      const runtime = runtimeFromPayload(payload);
      activeArchitectRuntime = Object.assign({}, activeArchitectRuntime || {}, runtime || {});
      return activeArchitectRuntime;
    }

    function architectRuntimeLabel(runtime) {
      const adapter = runtime.adapter || 'native_api_tool_loop';
      const model = runtime.model || 'none';
      if (adapter && adapter !== 'native_api_tool_loop') return adapter + '/' + model;
      return (runtime.provider || 'none') + '/' + model;
    }

    function stripJsonFenceLanguage(text) {
      const trimmed = String(text).trim();
      return trimmed.slice(0, 4).toLowerCase() === 'json' ? trimmed.slice(4).trim() : trimmed;
    }

    function firstJsonPayloadIndex(text) {
      const objectIndex = text.indexOf('{');
      const arrayIndex = text.indexOf('[');
      if (objectIndex < 0) return arrayIndex;
      if (arrayIndex < 0) return objectIndex;
      return Math.min(objectIndex, arrayIndex);
    }

    function collapseWhitespace(value) {
      return String(value).trim().replace(new RegExp(String.fromCharCode(92) + 's+', 'g'), ' ');
    }

    function tryParseJsonPayload(value) {
      if (!value) return null;
      if (typeof value === 'object') return { prefix: '', value: value };
      const text = String(value).trim();
      const fence = String.fromCharCode(96).repeat(3);
      let candidate = text;
      if (text.startsWith(fence) && text.endsWith(fence)) {
        candidate = stripJsonFenceLanguage(text.slice(fence.length, -fence.length));
      }
      const firstBrace = firstJsonPayloadIndex(candidate);
      if (firstBrace < 0) return null;
      const prefix = candidate.slice(0, firstBrace).trim();
      const jsonText = candidate.slice(firstBrace).trim();
      try {
        return { prefix: prefix, value: JSON.parse(jsonText) };
      } catch (_) {
        return null;
      }
    }

    function summarizeJsonObject(value) {
      if (!value || typeof value !== 'object') return '';
      const data = value.data && typeof value.data === 'object' ? value.data : value;
      const parts = [];
      if (value.success === true) parts.push('success');
      if (data.current_state) parts.push('state ' + data.current_state);
      if (data.dream_graph_stats) {
        const stats = data.dream_graph_stats;
        parts.push('nodes ' + String(stats.total_nodes || 0));
        parts.push('edges ' + String(stats.total_edges || 0));
      }
      if (data.validated_stats) {
        const validated = data.validated_stats;
        parts.push('validated ' + String(validated.validated || 0));
        parts.push('latent ' + String(validated.latent || 0));
      }
      if (data.tension_stats) {
        const tensions = data.tension_stats;
        parts.push('tensions ' + String(tensions.unresolved || tensions.total || 0));
      }
      if (data.provider || data.model || data.route) {
        parts.push([data.provider, data.model || data.route].filter(Boolean).join('/'));
      }
      return parts.length > 0 ? parts.join(' | ') : Object.keys(data).slice(0, 8).join(', ');
    }

    function summarizeNamedItems(items, keys, fallback) {
      if (!Array.isArray(items) || items.length === 0) return '';
      const labels = items.slice(0, 5).map(function(item) {
        if (!item || typeof item !== 'object') return String(item);
        for (const key of keys) {
          if (item[key]) return String(item[key]);
        }
        return fallback;
      });
      const suffix = items.length > labels.length ? ' +' + String(items.length - labels.length) + ' more' : '';
      return labels.join(', ') + suffix;
    }

    function describeStructuredToolResult(value) {
      if (!value || typeof value !== 'object') return [];
      const data = value.data && typeof value.data === 'object' ? value.data : value;
      const lines = [];
      const summary = summarizeJsonObject(value);
      if (summary) lines.push('Summary: ' + summary);
      if (typeof data.total === 'number') lines.push('Total: ' + String(data.total));
      const decisions = summarizeNamedItems(data.decisions, ['id', 'title'], 'decision');
      if (decisions) lines.push('Decisions: ' + decisions);
      const entries = summarizeNamedItems(data.entries, ['id', 'name'], 'entry');
      if (entries) lines.push('Entries: ' + entries);
      if (Array.isArray(data.guard_rail_warnings)) lines.push('Guard warnings: ' + String(data.guard_rail_warnings.length));
      const fields = Object.keys(data).slice(0, 8).join(', ');
      if (fields) lines.push('Fields: ' + fields);
      return lines;
    }

    function formatToolResultPreview(tool, preview) {
      if (!preview) return '';
      const parsed = tryParseJsonPayload(preview);
      if (parsed) {
        return summarizeJsonObject(parsed.value) || 'structured result received';
      }
      const text = collapseWhitespace(preview);
      return text.length > 180 ? text.slice(0, 180) + '...' : text;
    }

    function compactToolPreview(preview) {
      if (!preview) return '';
      const parsed = tryParseJsonPayload(preview);
      if (parsed) {
        const lines = describeStructuredToolResult(parsed.value);
        return lines.length > 0 ? lines.join(String.fromCharCode(10)) : 'Structured result received';
      }
      const text = collapseWhitespace(preview);
      return text.length > 900 ? text.slice(0, 900) + '...' : text;
    }

    function summarizeProvenance(provenance) {
      if (!provenance || typeof provenance !== 'object') return 'no provenance';
      const runtime = provenance.runtime || {};
      const calls = Array.isArray(provenance.tool_calls) ? provenance.tool_calls : [];
      const tools = calls.map(function(call) { return call.tool + ':' + call.status + ':' + call.duration_ms + 'ms'; }).join(' | ');
      const route = provenance.route || runtime.execution_route || runtime.adapter || 'route unknown';
      const provider = provenance.provider || runtime.provider || 'provider unknown';
      const model = provenance.model || runtime.model || 'model unknown';
      const session = runtime.session_id ? ' | session ' + runtime.session_id : '';
      return route + ' | ' + provider + '/' + model + session + (tools ? ' | ' + tools : ' | no tool calls');
    }

    function toolTraceRowKey(item) {
      return item.trace_id || [item.tool || item.name || 'tool', item.iteration || '0'].join(':');
    }

    function toolShortName(item) {
      const raw = String(item.tool || item.name || 'tool');
      const parts = raw.split(':');
      return parts[parts.length - 1] || raw;
    }

    function parsedToolArgs(item) {
      const parsed = tryParseJsonPayload(item.args_summary || item.arguments || item.input || '');
      return parsed && parsed.value && typeof parsed.value === 'object' ? parsed.value : null;
    }

    function semanticToolArgSummary(item) {
      const args = parsedToolArgs(item);
      const tool = toolShortName(item);
      if (args) {
        const filePath = args.filePath || args.path || args.file_path;
        if (tool === 'read_source_code') {
          const range = args.startLine && args.endLine ? ' lines ' + args.startLine + '-' + args.endLine : (args.entity ? ' entity ' + args.entity : '');
          return 'Read ' + (filePath || 'source') + range;
        }
        if (tool === 'search_source_code') return 'Searched ' + (args.pathPrefix || args.repo || 'project') + ' for ' + (args.query || 'text');
        if (tool === 'patch_file' || tool === 'edit_file') return 'Patched ' + (filePath || 'file');
        if (tool === 'run_command') return 'Ran ' + (args.command || 'command');
        if (tool === 'graph_rag_retrieve') return 'Retrieved graph context for ' + (args.query || 'query');
        if (tool === 'list_directory') return 'Listed ' + (args.dirPath || args.path || '.');
        if (tool === 'query_resource') return 'Queried ' + (args.uri || 'resource');
      }
      return collapseWhitespace(item.args_summary || '').slice(0, 160);
    }

    function unwrapToolResultPreview(preview) {
      const parsed = tryParseJsonPayload(preview);
      if (!parsed) return null;
      const value = parsed.value;
      if (value && Array.isArray(value.content) && value.content[0] && typeof value.content[0].text === 'string') {
        const nested = tryParseJsonPayload(value.content[0].text);
        return nested ? nested.value : value.content[0].text;
      }
      return value;
    }

    function semanticToolResultSummary(item) {
      if (item.status === 'running' || item.status === 'pending') return 'Waiting for result';
      const value = unwrapToolResultPreview(item.result_preview);
      const tool = toolShortName(item);
      if (value && typeof value === 'object') {
        const data = value.data && typeof value.data === 'object' ? value.data : value;
        if (tool === 'run_command') {
          const exitCode = typeof data.exitCode === 'number' ? data.exitCode : null;
          if (data.timedOut) return 'Timed out after ' + (data.durationMs || item.duration_ms || 0) + 'ms';
          return exitCode === 0 ? 'Passed' : 'Failed' + (exitCode == null ? '' : ' exit ' + exitCode);
        }
        if (tool === 'search_source_code' && typeof data.matchCount === 'number') return String(data.matchCount) + ' matches';
        if (tool === 'list_directory' && Array.isArray(data.entries)) return String(data.entries.length) + ' items';
        if (tool === 'graph_rag_retrieve') return summarizeJsonObject(value) || 'Context retrieved';
        return summarizeJsonObject(value) || 'Structured result received';
      }
      return formatToolResultPreview(item.tool || item.name || 'tool', item.result_preview);
    }

    function ensureToolTracePanel(provenance) {
      if (activeToolTracePanel) return activeToolTracePanel;
      const node = document.createElement('div');
      node.className = 'chat-message tool';
      const label = document.createElement('strong');
      label.textContent = 'Tool trace';
      const body = document.createElement('div');
      body.className = 'chat-message-body';
      const details = document.createElement('details');
      details.className = 'tool-trace-panel';
      details.open = true;
      const summary = document.createElement('summary');
      summary.textContent = 'Tool trace (0)';
      const list = document.createElement('div');
      list.className = 'tool-trace-list';
      details.appendChild(summary);
      details.appendChild(list);
      body.appendChild(details);
      if (provenance) {
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = summarizeProvenance(provenance);
        body.appendChild(meta);
      }
      node.appendChild(label);
      node.appendChild(body);
      chatLogEl.appendChild(node);
      activeToolTracePanel = { node: node, summary: summary, list: list };
      activeToolTraceRows = new Map();
      return activeToolTracePanel;
    }

    function updateToolTracePanelSummary() {
      if (!activeToolTracePanel) return;
      const items = Array.from(activeToolTraceRows.values()).map(function(record) { return record.item; });
      const completed = items.filter(function(item) { return item.status === 'completed'; }).length;
      const failed = items.filter(function(item) { return item.status === 'failed'; }).length;
      const running = items.filter(function(item) { return item.status === 'running' || item.status === 'pending'; }).length;
      const parts = [String(items.length)];
      if (running) parts.push(String(running) + ' running');
      if (completed) parts.push(String(completed) + ' completed');
      if (failed) parts.push(String(failed) + ' failed');
      activeToolTracePanel.summary.textContent = 'Tool trace (' + parts.join('; ') + ')';
    }

    function renderToolTraceRow(row, item) {
      resetNode(row);
      const header = document.createElement('div');
      header.className = 'tool-trace-header';
      const name = document.createElement('span');
      name.textContent = item.tool || item.name || 'tool';
      const status = document.createElement('span');
      status.className = 'tool-trace-pill status-' + (item.status || 'updated');
      status.textContent = item.status || 'updated';
      const duration = document.createElement('span');
      duration.className = 'tool-trace-pill';
      duration.textContent = typeof item.duration_ms === 'number' && item.duration_ms > 0 ? String(item.duration_ms) + 'ms' : 'running';
      header.appendChild(name);
      header.appendChild(status);
      header.appendChild(duration);
      row.appendChild(header);
      const argLine = semanticToolArgSummary(item);
      if (argLine) {
        const args = document.createElement('div');
        args.className = 'meta';
        args.textContent = argLine;
        row.appendChild(args);
      }
      const resultLine = semanticToolResultSummary(item);
      if (resultLine) {
        const result = document.createElement('div');
        result.className = 'meta';
        result.textContent = resultLine;
        row.appendChild(result);
      }
      if (item.result_preview || item.args_summary) {
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = 'Details';
        details.appendChild(summary);
        const pre = document.createElement('pre');
        pre.textContent = compactToolPreview(item.result_preview || item.args_summary);
        details.appendChild(pre);
        row.appendChild(details);
      }
    }

    function appendToolTraceMessage(trace, provenance) {
      const panel = ensureToolTracePanel(provenance);
      const items = Array.isArray(trace) ? trace : [];
      if (items.length === 0 && provenance) {
        updateToolTracePanelSummary();
        return;
      }
      for (const item of items) {
        const key = toolTraceRowKey(item);
        let record = activeToolTraceRows.get(key);
        if (!record) {
          const row = document.createElement('div');
          row.className = 'tool-trace-row';
          panel.list.appendChild(row);
          record = { row: row, item: item };
          activeToolTraceRows.set(key, record);
        }
        record.item = item;
        renderToolTraceRow(record.row, item);
      }
      updateToolTracePanelSummary();
      chatLogEl.scrollTop = chatLogEl.scrollHeight;
    }

    function appendToolTraceEvent(event) {
      const envelope = appendTypedEventLine('tool', event);
      const payload = envelope.payload || {};
      if (!chatProcessing) return;
      liveToolTraceSeen = true;
      appendToolTraceMessage([payload], null);
    }

    function resetNode(node) {
      while (node.firstChild) {
        node.removeChild(node.firstChild);
      }
    }

    function appendChip(node, label, value, warn) {
      const chip = document.createElement('span');
      chip.className = 'chip' + (warn ? ' warn' : '');
      chip.textContent = label + ': ' + value;
      node.appendChild(chip);
    }

    function saveArchitectControls() {
      try {
        window.localStorage.setItem(architectControlStorageKey, JSON.stringify({
          adapter: architectAdapterSelectEl.value,
          provider: architectProviderSelectEl.value,
          model: architectModelInputEl.value,
          mode: architectAutonomyModeSelectEl.value,
        }));
      } catch (_) { /* storage may be unavailable */ }
      window.clearTimeout(architectControlPersistTimer);
      architectControlPersistTimer = window.setTimeout(function() {
        persistArchitectControls().catch(function() { /* status is rendered by persistArchitectControls */ });
      }, 180);
    }

    function architectRouteLabel(controls) {
      const adapter = controls.adapter || 'native_api_tool_loop';
      const model = controls.model || 'none';
      if (adapter && adapter !== 'native_api_tool_loop') return adapter + '/' + model;
      return (controls.provider || 'none') + '/' + model;
    }

    async function persistArchitectControls() {
      window.clearTimeout(architectControlPersistTimer);
      architectControlPersistTimer = 0;
      const controls = selectedArchitectControls();
      try {
        const response = await fetch('/api/architect/v1/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            adapter: controls.adapter,
            provider: controls.provider,
            model: controls.model,
            mode: controls.mode,
            autonomy_mode: controls.mode,
          }),
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.message || ('Architect config failed with HTTP ' + response.status));
        }
        const runtime = updateActiveArchitectRuntime(payload);
        renderRuntime(payload);
        const result = payload.result || {};
        chatStatusEl.textContent = 'Architect runtime saved: ' + architectRuntimeLabel(runtime) + ' | ' + (runtime.autonomy_mode || controls.mode) + (result.persisted ? ' | engine.env updated' : ' | in-memory only');
        appendEventLine('[config] selected ' + architectRuntimeLabel(runtime));
        return payload;
      } catch (error) {
        chatStatusEl.textContent = 'Architect route save failed: ' + String(error instanceof Error ? error.message : error);
        throw error;
      }
    }

    function modelProviderKeyForControls() {
      const adapter = architectAdapterSelectEl.value || 'native_api_tool_loop';
      if (adapter === 'codex-cli' || adapter === 'copilot-cli') return adapter;
      return architectProviderSelectEl.value || 'none';
    }

    function renderArchitectModelOptions(providerKey, preferredModel) {
      const models = architectModelOptionsByProvider[providerKey] || [];
      resetNode(architectModelInputEl);
      const normalizedPreferred = preferredModel || '';
      const visibleModels = models.length > 0 ? models : [normalizedPreferred];
      for (const model of visibleModels) {
        const option = document.createElement('option');
        option.value = model;
        option.textContent = model || 'No model';
        architectModelInputEl.appendChild(option);
      }
      if (normalizedPreferred && visibleModels.indexOf(normalizedPreferred) < 0) {
        const option = document.createElement('option');
        option.value = normalizedPreferred;
        option.textContent = normalizedPreferred;
        architectModelInputEl.insertBefore(option, architectModelInputEl.firstChild);
      }
      architectModelInputEl.value = normalizedPreferred && Array.from(architectModelInputEl.options).some(function(option) { return option.value === normalizedPreferred; })
        ? normalizedPreferred
        : (visibleModels[0] || '');
    }

    function syncArchitectControlState(preferredModel) {
      const adapter = architectAdapterSelectEl.value || 'native_api_tool_loop';
      const cliAdapter = adapter === 'codex-cli' || adapter === 'copilot-cli';
      const deterministic = adapter === 'deterministic_fallback';
      if (cliAdapter || deterministic) {
        if (architectProviderSelectEl.value && architectProviderSelectEl.value !== 'none') {
          lastNativeArchitectProvider = architectProviderSelectEl.value;
        }
        architectProviderSelectEl.value = 'none';
      } else if (architectProviderSelectEl.value === 'none' && lastNativeArchitectProvider) {
        architectProviderSelectEl.value = lastNativeArchitectProvider;
      }
      architectProviderSelectEl.disabled = cliAdapter || deterministic;
      renderArchitectModelOptions(modelProviderKeyForControls(), preferredModel);
      architectModelInputEl.disabled = deterministic;
    }

    function hydrateArchitectControls(payload) {
      const runtime = updateActiveArchitectRuntime(payload);
      let saved = {};
      try { saved = JSON.parse(window.localStorage.getItem(architectControlStorageKey) || '{}') || {}; } catch (_) { saved = {}; }
      architectAdapterSelectEl.value = runtime.adapter || saved.adapter || 'native_api_tool_loop';
      architectProviderSelectEl.value = runtime.provider || saved.provider || 'none';
      if (!architectProviderSelectEl.value) architectProviderSelectEl.value = 'none';
      lastNativeArchitectProvider = architectProviderSelectEl.value !== 'none' ? architectProviderSelectEl.value : '';
      architectAutonomyModeSelectEl.value = runtime.autonomy_mode || saved.mode || 'autonomous';
      syncArchitectControlState(runtime.model || saved.model || '');
      architectAdapterSelectEl.addEventListener('change', function() {
        syncArchitectControlState('');
        saveArchitectControls();
      });
      architectProviderSelectEl.addEventListener('change', function() {
        syncArchitectControlState('');
        saveArchitectControls();
      });
      architectModelInputEl.addEventListener('change', saveArchitectControls);
      architectAutonomyModeSelectEl.addEventListener('change', saveArchitectControls);
    }

    function selectedArchitectControls() {
      const adapter = architectAdapterSelectEl.value || 'native_api_tool_loop';
      return {
        adapter: adapter,
        provider: deterministicProviderForAdapter(adapter),
        model: architectModelInputEl.value.trim(),
        mode: architectAutonomyModeSelectEl.value || 'autonomous',
      };
    }

    function activePlanTitleForScope() {
      const plan = planIndexCache.find(function(item) { return item.id === activePlanId; });
      return (plan && plan.title) || planTitleEl.textContent || activePlanId || 'selected plan';
    }

    function effectiveChatScope(scope) {
      return scope === 'plan' && activePlanId ? 'plan' : 'project';
    }

    function renderChatScopePill() {
      activeChatScope = effectiveChatScope(activeChatScope);
      if (activeChatScope === 'plan') {
        const title = activePlanTitleForScope();
        chatScopePillEl.textContent = '📍 Plan: ' + title;
        chatScopePillEl.title = 'Messages are bound to selected plan';
        chatScopePillEl.dataset.scope = 'plan';
        chatScopePillEl.setAttribute('aria-pressed', 'true');
        chatScopePillEl.setAttribute('aria-label', 'Plan scope: ' + title + '. Toggle chat scope');
      } else {
        chatScopePillEl.textContent = '🌍 Project';
        chatScopePillEl.title = 'Messages will use project-wide context';
        chatScopePillEl.dataset.scope = 'project';
        chatScopePillEl.setAttribute('aria-pressed', 'false');
        chatScopePillEl.setAttribute('aria-label', activePlanId ? 'Project scope. Toggle chat scope' : 'Project scope');
      }
    }

    function setChatScope(scope) {
      activeChatScope = effectiveChatScope(scope);
      renderChatScopePill();
      return activeChatScope;
    }

    function toggleChatScope() {
      if (activeChatScope === 'plan') {
        setChatScope('project');
        chatStatusEl.textContent = 'Project scope active. Selected plan context will not be injected.';
        return;
      }
      if (!activePlanId) {
        setChatScope('project');
        chatStatusEl.textContent = 'Project scope active. Select a plan before switching to Plan scope.';
        return;
      }
      setChatScope('plan');
      chatStatusEl.textContent = 'Plan scope active for ' + activePlanId + '.';
    }

    function parseChatSlashOverride(message) {
      const whitespace = String.fromCharCode(92) + 's';
      const pattern = new RegExp('^' + whitespace + '*/(ask|global|repo|plan)(?:' + whitespace + '+|$)', 'i');
      const match = String(message || '').match(pattern);
      if (!match) return { message: message, scope: null };
      const command = match[1].toLowerCase();
      return {
        message: String(message || '').slice(match[0].length).trim(),
        scope: command === 'plan' ? 'plan' : 'project'
      };
    }

    function deterministicProviderForAdapter(adapter) {
      if (adapter === 'deterministic_fallback' || adapter === 'codex-cli' || adapter === 'copilot-cli') return 'none';
      return architectProviderSelectEl.value || 'none';
    }

    function updateAutonomyPassView(status, toolCount) {
      architectPassViewEl.textContent = String(autonomyPassCount) + ' passes | ' + String(toolCount || 0) + ' tools | ' + status;
    }

    function renderRuntime(payload) {
      const project = payload.project_scope || (payload.result && payload.result.project_scope) || {};
      const runtime = updateActiveArchitectRuntime(payload);
      const instanceId = project.instance_id || 'unbound';
      const projectRoot = project.project_root || 'unbound';
      projectScopeEl.textContent = 'Project: ' + projectRoot;
      projectScopeEl.title = 'Instance: ' + instanceId + ' | plans: ' + (project.plans_root || 'unknown') + ' | binding: ' + (project.binding_status || (project.daemon_bound ? 'bound' : 'unbound'));
      const passState = runtime.pass_state || {};
      if (typeof passState.completed === 'number') {
        autonomyPassCount = Math.max(autonomyPassCount, passState.completed);
      }
      architectModelConfigEl.textContent = 'Model: ' + architectRuntimeLabel(runtime);
      architectModelConfigEl.title = 'session: ' + (runtime.session_id || 'unknown') + ' | route: ' + (runtime.execution_route || runtime.adapter || 'unknown') + ' | autonomy: ' + (runtime.autonomy_mode || 'unknown') + ' | provenance: ' + (runtime.provenance_authority || 'unknown') + ' | adapter source: ' + (runtime.adapter_source || 'unknown') + ' | model source: ' + (runtime.model_source || 'unknown') + ' | provider source: ' + (runtime.provider_source || 'unknown');
    }

    function normalizeRenderedText(content) {
      const newline = String.fromCharCode(10);
      let text = String(content || '')
        .split(String.fromCharCode(13) + newline).join(newline)
        .split(String.fromCharCode(13)).join(newline);
      if (text.indexOf(newline) === -1 && (text.match(/ - /g) || []).length >= 3) {
        text = text
          .replace(/\s+-\s+(?=(?:[A-Z][A-Za-z ]{1,36}|[0-9]+|ADR|API|LLM|MCP|Avg\.|No |Top |Summary:))/g, newline + '- ')
          .replace(/\s+Summary:/g, newline + newline + 'Summary:');
      }
      return text;
    }

    function renderAdrPreviewCard(container, adrId, state, payload) {
      resetNode(container);
      container.className = 'adr-preview-card';
      if (state === 'loading') {
        container.textContent = 'Loading ' + adrId + ' from daemon ADR surface...';
        return;
      }
      if (state === 'error') {
        container.textContent = payload || ('No daemon ADR preview found for ' + adrId + '.');
        return;
      }
      const adr = payload.adr || payload;
      const title = document.createElement('strong');
      title.textContent = adr.id + ' - ' + (adr.title || 'Untitled ADR');
      container.appendChild(title);
      const status = document.createElement('div');
      status.className = 'adr-preview-status';
      for (const value of [adr.status || 'unknown', adr.date || 'undated', adr.superseded_by ? 'superseded by ' + adr.superseded_by : null]) {
        if (!value) continue;
        const chip = document.createElement('span');
        chip.textContent = value;
        status.appendChild(chip);
      }
      container.appendChild(status);
      appendParagraph(container, adr.decision_summary || 'No decision summary recorded.');
      if (adr.guard_rails && adr.guard_rails.length) {
        appendParagraph(container, 'Guard rails: ' + adr.guard_rails.slice(0, 3).join(' | '));
      }
      const advisory = adr.advisory_metadata || {};
      appendParagraph(container, 'Read-only daemon preview | guard rails advisory: ' + String(advisory.guard_rails_advisory !== false));
      const actions = document.createElement('div');
      actions.className = 'inline-actions';
      const editButton = document.createElement('button');
      editButton.type = 'button';
      editButton.className = 'mini-button';
      editButton.textContent = 'Edit proposal';
      editButton.addEventListener('click', function() {
        openAdrEditor(adr.id || adrId, payload).catch(function(error) {
          adrEditorStatusEl.textContent = String(error instanceof Error ? error.message : error);
        });
      });
      actions.appendChild(editButton);
      container.appendChild(actions);
    }

    async function loadAdrPreview(adrId, container) {
      const key = String(adrId || '').toUpperCase();
      if (!key) return;
      if (adrPreviewCache.has(key)) {
        renderAdrPreviewCard(container, key, 'ready', adrPreviewCache.get(key));
        return;
      }
      renderAdrPreviewCard(container, key, 'loading');
      try {
        const response = await fetch('/api/architect/v1/adrs/' + encodeURIComponent(key), { cache: 'no-store' });
        const payload = await response.json().catch(function() { return {}; });
        if (!response.ok) {
          throw new Error(payload.message || ('ADR preview failed with HTTP ' + response.status));
        }
        adrPreviewCache.set(key, payload);
        renderAdrPreviewCard(container, key, 'ready', payload);
      } catch (error) {
        renderAdrPreviewCard(container, key, 'error', String(error instanceof Error ? error.message : error));
      }
    }

    function appendTextWithAdrPreviews(parent, text) {
      const pattern = /ADR-\d{3,}/gi;
      const source = String(text || '');
      let cursor = 0;
      let match = pattern.exec(source);
      while (match) {
        if (match.index > cursor) {
          parent.appendChild(document.createTextNode(source.slice(cursor, match.index)));
        }
        const adrId = match[0].toUpperCase();
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'adr-preview-trigger';
        trigger.textContent = adrId;
        trigger.title = 'Load daemon ADR preview';
        const preview = document.createElement('div');
        preview.hidden = true;
        const showPreview = function() {
          preview.hidden = false;
          loadAdrPreview(adrId, preview);
        };
        trigger.addEventListener('mouseenter', showPreview);
        trigger.addEventListener('focus', showPreview);
        trigger.addEventListener('click', function() {
          showPreview();
          openAdrEditor(adrId).catch(function(error) {
            adrEditorStatusEl.textContent = String(error instanceof Error ? error.message : error);
          });
        });
        parent.appendChild(trigger);
        parent.appendChild(preview);
        cursor = match.index + match[0].length;
        match = pattern.exec(source);
      }
      if (cursor < source.length) {
        parent.appendChild(document.createTextNode(source.slice(cursor)));
      }
    }

    function appendParagraph(parent, text) {
      const paragraph = document.createElement('p');
      appendTextWithAdrPreviews(paragraph, text);
      parent.appendChild(paragraph);
    }

    function appendAdrListItem(node, adrId) {
      const item = document.createElement('li');
      const title = document.createElement('strong');
      appendTextWithAdrPreviews(title, adrId);
      item.appendChild(title);
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = 'daemon-governed ADR preview on hover or focus';
      item.appendChild(meta);
      const actions = document.createElement('div');
      actions.className = 'inline-actions';
      const editButton = document.createElement('button');
      editButton.type = 'button';
      editButton.className = 'mini-button';
      editButton.textContent = 'Edit proposal';
      editButton.addEventListener('click', function() {
        openAdrEditor(adrId).catch(function(error) {
          adrEditorStatusEl.textContent = String(error instanceof Error ? error.message : error);
        });
      });
      actions.appendChild(editButton);
      item.appendChild(actions);
      node.appendChild(item);
    }

    function appendJsonCard(parent, title, value, extraClass) {
      const details = document.createElement('details');
      details.className = 'chat-card' + (extraClass ? ' ' + extraClass : '');
      const summary = document.createElement('summary');
      summary.className = 'chat-card-title';
      summary.textContent = title;
      details.appendChild(summary);
      const preNode = document.createElement('pre');
      preNode.textContent = JSON.stringify(value, null, 2);
      details.appendChild(preNode);
      parent.appendChild(details);
    }

    function renderChatContent(parent, content, role) {
      const text = normalizeRenderedText(content).trim();
      if (!text) {
        appendParagraph(parent, 'No content.');
        return;
      }
      const parsed = tryParseJsonPayload(text);
      if (parsed && !parsed.prefix) {
        appendJsonCard(parent, role === 'tool' ? 'Tool result' : 'Structured payload', parsed.value);
        return;
      }

      let list = null;
      let orderedList = null;
      let codeBlock = null;
      const newline = String.fromCharCode(10);
      const fence = String.fromCharCode(96).repeat(3);
      for (const rawLine of text.split(newline)) {
        const line = rawLine.trim();
        if (line.startsWith(fence)) {
          if (codeBlock) {
            codeBlock = null;
          } else {
            list = null;
            orderedList = null;
            codeBlock = document.createElement('pre');
            parent.appendChild(codeBlock);
          }
          continue;
        }
        if (codeBlock) {
          codeBlock.textContent += (codeBlock.textContent ? newline : '') + rawLine;
          continue;
        }
        if (!line) {
          list = null;
          orderedList = null;
          continue;
        }
        const bullet = line.match(/^[-*]\s+(.+)$/);
        if (bullet) {
          orderedList = null;
          if (!list) {
            list = document.createElement('ul');
            parent.appendChild(list);
          }
          const item = document.createElement('li');
          item.textContent = bullet[1];
          list.appendChild(item);
          continue;
        }
        const ordered = line.match(/^\d+[.)]\s+(.+)$/);
        if (ordered) {
          list = null;
          if (!orderedList) {
            orderedList = document.createElement('ol');
            parent.appendChild(orderedList);
          }
          const item = document.createElement('li');
          item.textContent = ordered[1];
          orderedList.appendChild(item);
          continue;
        }
        list = null;
        orderedList = null;
        const inlineJson = tryParseJsonPayload(line);
        if (inlineJson) {
          if (inlineJson.prefix) appendParagraph(parent, inlineJson.prefix);
          appendJsonCard(parent, role === 'tool' ? 'Tool result' : 'Structured payload', inlineJson.value);
          continue;
        }
        const titledLine = line.match(/^(Executive Summary|Findings|Graph Updates|Evidence|Uncertainty|Recommended Next Step|Raw Trace|Tool Trace|Provenance|Summary|Graph Health Overview):\s*(.*)$/i);
        if (line.startsWith('#')) {
          const title = document.createElement('strong');
          title.className = 'chat-heading';
          title.textContent = line.replace(/^#+\s*/, '');
          parent.appendChild(title);
        } else if (/^[A-Z][A-Za-z ]{2,40}:$/.test(line)) {
          const title = document.createElement('strong');
          title.className = 'chat-heading';
          title.textContent = line.slice(0, -1);
          parent.appendChild(title);
        } else if (titledLine) {
          const paragraph = document.createElement('p');
          const title = document.createElement('strong');
          title.className = 'chat-inline-heading';
          title.textContent = titledLine[1] + ':';
          paragraph.appendChild(title);
          if (titledLine[2]) {
            paragraph.appendChild(document.createTextNode(' ' + titledLine[2]));
          }
          parent.appendChild(paragraph);
        } else {
          appendParagraph(parent, line);
        }
      }
    }

    function appendChatMessage(role, content) {
      const node = document.createElement('div');
      node.className = 'chat-message ' + role;
      const label = document.createElement('strong');
      label.textContent = role === 'user' ? 'You' : (role === 'tool' ? 'Tool Trace' : 'Architect');
      const body = document.createElement('div');
      body.className = 'chat-message-body';
      renderChatContent(body, content, role);
      node.appendChild(label);
      node.appendChild(body);
      chatLogEl.appendChild(node);
      chatLogEl.scrollTop = chatLogEl.scrollHeight;
    }

    function appendListItem(node, primary, secondary) {
      const item = document.createElement('li');
      const title = document.createElement('strong');
      title.textContent = primary;
      item.appendChild(title);
      if (secondary) {
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = secondary;
        item.appendChild(meta);
      }
      node.appendChild(item);
    }

    function renderList(node, items, emptyText, renderer) {
      resetNode(node);
      if (!items || items.length === 0) {
        const item = document.createElement('li');
        item.className = 'empty';
        item.textContent = emptyText;
        node.appendChild(item);
        return;
      }
      for (const item of items) {
        renderer(node, item);
      }
    }

    function renderFutureReview(payload) {
      const review = payload.future_review || {};
      futureDecisionTemplates = review.review_decisions || [];
      resetNode(futureSummaryEl);
      const provenance = review.model_provenance || {};
      appendChip(futureSummaryEl, 'Route', provenance.route || 'unknown', provenance.route !== 'llm');
      appendChip(futureSummaryEl, 'Provider', provenance.provider || 'unknown', !provenance.provider_available);
      appendChip(futureSummaryEl, 'Model', provenance.model || 'n/a', !provenance.model);
      appendChip(futureSummaryEl, 'Fallback', provenance.fallback || 'unknown', provenance.fallback && provenance.fallback !== 'none');
      if (provenance.fallback && provenance.fallback !== 'none') {
        appendChip(futureSummaryEl, 'Reason', provenance.fallback_reason || 'unspecified', true);
      }
      appendChip(futureSummaryEl, 'Selected', review.selected_candidate_id || 'none', !review.selected_candidate_id);
      appendChip(futureSummaryEl, 'Decision', (review.review_status && review.review_status.current_decision) || 'pending', false);

      renderList(futureCandidateListEl, review.candidates || [], 'No candidate futures projected yet.', function(node, candidate) {
        const score = Math.round(Number(candidate.future_fit_score || 0) * 100);
        const objections = (candidate.objections || []).join(' | ') || 'no objections projected';
        const label = String(candidate.label || candidate.id || 'candidate');
        appendListItem(node, label + ' - ' + score + '%', candidate.review_status + ' - ' + objections);
      });

      resetNode(futureDecisionButtonsEl);
      for (const decision of futureDecisionTemplates) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'mini-button';
        button.textContent = decision.label || decision.id;
        button.addEventListener('click', function() {
          postFutureDecision(decision).catch(function(error) {
            futureStatusEl.textContent = String(error instanceof Error ? error.message : error);
          });
        });
        futureDecisionButtonsEl.appendChild(button);
      }
      futureStatusEl.textContent = 'Advisory future review ready for ' + review.planId;
    }

    async function loadFutureReview(planId, loadToken) {
      futureStatusEl.textContent = 'Loading advisory future review for ' + planId + '...';
      resetNode(futureSummaryEl);
      resetNode(futureCandidateListEl);
      resetNode(futureDecisionButtonsEl);
      const response = await fetch('/api/architect/v1/plans/' + encodeURIComponent(planId) + '/future-review', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('Future review failed with HTTP ' + response.status);
      }
      const payload = await response.json();
      if (loadToken !== activePlanLoadToken || activePlanId !== planId) return;
      renderFutureReview(payload);
    }

    async function postFutureDecision(decision) {
      futureStatusEl.textContent = 'Recording future review decision...';
      const response = await fetch(decision.endpoint, {
        method: decision.method || 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(decision.body || {}),
      });
      const payload = await response.json().catch(function() { return {}; });
      if (!response.ok) {
        throw new Error(payload.message || ('Future review decision failed with HTTP ' + response.status));
      }
      const result = payload.result || {};
      futureStatusEl.textContent = result.status + ': ' + result.action;
      appendEventLine('[future-review] ' + result.audit_id);
      if (activePlanButton) {
        await loadPlan(activePlanId, activePlanButton);
      }
    }

    function renderSchedules(payload) {
      const scheduler = payload.scheduler || {};
      resetNode(scheduleSummaryEl);
      appendChip(scheduleSummaryEl, 'Total', String(scheduler.total || 0), false);
      appendChip(scheduleSummaryEl, 'Enabled', String(scheduler.enabled || 0), false);
      appendChip(scheduleSummaryEl, 'Paused', String(scheduler.paused || 0), Boolean(scheduler.paused));
      appendChip(scheduleSummaryEl, 'History', String(scheduler.recent_execution_count || 0), false);

      resetNode(scheduleListEl);
      const schedules = payload.schedules || [];
      if (schedules.length === 0) {
        const item = document.createElement('li');
        item.className = 'empty';
        item.textContent = 'No schedules configured.';
        scheduleListEl.appendChild(item);
      } else {
        for (const schedule of schedules) {
          const item = document.createElement('li');
          const title = document.createElement('strong');
          title.textContent = schedule.name + ' - ' + schedule.action;
          item.appendChild(title);
          const meta = document.createElement('div');
          meta.className = 'meta';
          const linked = schedule.linked_context || {};
          meta.textContent = (schedule.status || 'unknown') + ' - next ' + (schedule.next_run_at || 'not scheduled') + ' - plan ' + (linked.plan_id || 'unlinked');
          item.appendChild(meta);
          const actions = document.createElement('div');
          actions.className = 'inline-actions';
          for (const action of schedule.actions || []) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'mini-button';
            button.textContent = action.label || action.id;
            button.addEventListener('click', function() {
              postScheduleAction(action).catch(function(error) {
                scheduleStatusEl.textContent = String(error instanceof Error ? error.message : error);
              });
            });
            actions.appendChild(button);
          }
          item.appendChild(actions);
          scheduleListEl.appendChild(item);
        }
      }
      scheduleStatusEl.textContent = 'Scheduler projection ready.';
    }

    function adrEditorTextArray(value) {
      return Array.isArray(value) ? value.join(String.fromCharCode(10)) : '';
    }

    function adrEditorArrayFromTextarea(value) {
      return String(value || '').replace(new RegExp(String.fromCharCode(13), 'g'), '').split(String.fromCharCode(10)).map(function(line) { return line.trim(); }).filter(Boolean);
    }

    function renderAdrEditor(payload) {
      const adr = (payload && payload.full_content) || {};
      const preview = (payload && payload.adr) || {};
      activeAdrEditorId = adr.id || preview.id || activeAdrEditorId;
      activeAdrEditorPayload = payload;
      resetNode(adrEditorEl);
      const status = document.createElement('p');
      status.id = 'adr-editor-status';
      status.className = 'status';
      status.textContent = activeAdrEditorId ? 'Editing proposal for ' + activeAdrEditorId + ' through daemon-governed plan audit.' : 'Open an ADR from bindings, preview, or chat reference.';
      adrEditorEl.appendChild(status);
      window.adrEditorStatusEl = status;

      const warning = document.createElement('div');
      warning.className = 'adr-editor-warning';
      warning.textContent = 'Proposal mode: proposal_only. Submitting records an ADR edit proposal against the selected plan. It does not silently overwrite adr_log.json.';
      adrEditorEl.appendChild(warning);

      const grid = document.createElement('div');
      grid.className = 'adr-editor-grid';
      const titleLabel = document.createElement('label');
      titleLabel.textContent = 'Title';
      const titleInput = document.createElement('input');
      titleInput.id = 'adr-editor-title';
      titleInput.value = adr.title || preview.title || '';
      titleLabel.appendChild(titleInput);
      const statusLabel = document.createElement('label');
      statusLabel.textContent = 'Status';
      const statusSelect = document.createElement('select');
      statusSelect.id = 'adr-editor-status-select';
      for (const optionValue of ['accepted', 'deprecated', 'superseded']) {
        const option = document.createElement('option');
        option.value = optionValue;
        option.textContent = optionValue;
        statusSelect.appendChild(option);
      }
      statusSelect.value = adr.status || preview.status || 'accepted';
      statusLabel.appendChild(statusSelect);
      grid.appendChild(titleLabel);
      grid.appendChild(statusLabel);
      adrEditorEl.appendChild(grid);

      const decisionLabel = document.createElement('label');
      decisionLabel.textContent = 'Decision summary';
      const decisionInput = document.createElement('textarea');
      decisionInput.id = 'adr-editor-decision';
      decisionInput.value = (adr.decision && adr.decision.chosen) || preview.decision_summary || '';
      decisionLabel.appendChild(decisionInput);
      adrEditorEl.appendChild(decisionLabel);

      const problemLabel = document.createElement('label');
      problemLabel.textContent = 'Problem summary';
      const problemInput = document.createElement('textarea');
      problemInput.id = 'adr-editor-problem';
      problemInput.value = (adr.context && adr.context.problem) || preview.problem_summary || '';
      problemLabel.appendChild(problemInput);
      adrEditorEl.appendChild(problemLabel);

      const guardLabel = document.createElement('label');
      guardLabel.textContent = 'Guard rails';
      const guardInput = document.createElement('textarea');
      guardInput.id = 'adr-editor-guard-rails';
      guardInput.value = adrEditorTextArray(adr.guard_rails || preview.guard_rails || []);
      guardLabel.appendChild(guardInput);
      adrEditorEl.appendChild(guardLabel);

      const tagLabel = document.createElement('label');
      tagLabel.textContent = 'Tags';
      const tagInput = document.createElement('input');
      tagInput.id = 'adr-editor-tags';
      tagInput.value = Array.isArray(adr.tags || preview.tags) ? (adr.tags || preview.tags).join(', ') : '';
      tagLabel.appendChild(tagInput);
      adrEditorEl.appendChild(tagLabel);

      const actions = document.createElement('div');
      actions.className = 'inline-actions';
      const submit = document.createElement('button');
      submit.type = 'button';
      submit.className = 'mini-button';
      submit.textContent = 'Record proposal';
      submit.addEventListener('click', function() {
        submitAdrEditProposal({ titleInput: titleInput, statusSelect: statusSelect, decisionInput: decisionInput, problemInput: problemInput, guardInput: guardInput, tagInput: tagInput }).catch(function(error) {
          status.textContent = String(error instanceof Error ? error.message : error);
        });
      });
      actions.appendChild(submit);
      adrEditorEl.appendChild(actions);
    }

    async function openAdrEditor(adrId, existingPayload) {
      const key = String(adrId || '').toUpperCase();
      if (!key) return;
      activeAdrEditorId = key;
      const payload = existingPayload || adrPreviewCache.get(key) || await loadAdrPayload(key);
      renderAdrEditor(payload);
    }

    async function loadAdrPayload(adrId) {
      const response = await fetch('/api/architect/v1/adrs/' + encodeURIComponent(adrId), { cache: 'no-store' });
      const payload = await response.json().catch(function() { return {}; });
      if (!response.ok) {
        throw new Error(payload.message || ('ADR load failed with HTTP ' + response.status));
      }
      adrPreviewCache.set(adrId, payload);
      return payload;
    }

    async function submitAdrEditProposal(fields) {
      if (!activePlanId) {
        window.adrEditorStatusEl.textContent = 'Select a plan before recording an ADR edit proposal.';
        return;
      }
      if (!activeAdrEditorId) {
        window.adrEditorStatusEl.textContent = 'Open an ADR before recording a proposal.';
        return;
      }
      window.adrEditorStatusEl.textContent = 'Recording ADR edit proposal...';
      const response = await fetch('/api/architect/v1/adrs/' + encodeURIComponent(activeAdrEditorId) + '/edits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plan_id: activePlanId,
          title: fields.titleInput.value,
          status: fields.statusSelect.value,
          decision_summary: fields.decisionInput.value,
          problem_summary: fields.problemInput.value,
          guard_rails: adrEditorArrayFromTextarea(fields.guardInput.value),
          tags: String(fields.tagInput.value || '').split(',').map(function(tag) { return tag.trim(); }).filter(Boolean),
          audit_reason: 'Operator recorded an inline/dedicated ADR edit proposal from standalone Architect.',
        }),
      });
      const payload = await response.json().catch(function() { return {}; });
      if (!response.ok) {
        throw new Error(payload.message || ('ADR edit proposal failed with HTTP ' + response.status));
      }
      const result = payload.result || {};
      window.adrEditorStatusEl.textContent = 'Proposal recorded: ' + (result.audit_id || activeAdrEditorId);
      appendEventLine('[adr-edit] ' + activeAdrEditorId + ' proposal recorded');
      if (activePlanButton) {
        await loadPlan(activePlanId, activePlanButton);
      }
    }

    async function loadSchedules(planId, loadToken) {
      scheduleStatusEl.textContent = 'Loading scheduler projection...';
      const response = await fetch('/api/architect/v1/schedules', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('Schedule projection failed with HTTP ' + response.status);
      }
      const payload = await response.json();
      if (loadToken !== activePlanLoadToken || activePlanId !== planId) return;
      for (const schedule of payload.schedules || []) {
        for (const action of schedule.actions || []) {
          action.body = Object.assign({}, action.body || {}, { plan_id: planId });
        }
      }
      renderSchedules(payload);
    }

    async function postScheduleAction(action) {
      scheduleStatusEl.textContent = 'Recording scheduler action...';
      const response = await fetch(action.endpoint, {
        method: action.method || 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action.body || {}),
      });
      const payload = await response.json().catch(function() { return {}; });
      if (!response.ok) {
        throw new Error(payload.message || ('Scheduler action failed with HTTP ' + response.status));
      }
      const result = payload.result || {};
      scheduleStatusEl.textContent = result.status + ': ' + result.action;
      appendEventLine('[schedule-action] ' + result.action);
      if (activePlanButton) {
        await loadPlan(activePlanId, activePlanButton);
      }
    }

    function renderPlan(plan) {
      const registry = plan.registry || {
        summary: {},
        adr_bindings: [],
        graph_bindings: [],
        slices: [],
        checkpoints: [],
        operational_state: null,
        evidence_links: [],
      };
      const operationalState = plan.operational_state || registry.operational_state || {
        phase: null,
        active_phase: null,
        current_slice_id: null,
        current_slice_title: null,
        current_status: null,
        plan_lifecycle: null,
        execution_state: null,
        active_slice: null,
        last_completed_slice: null,
        next_slice: null,
        last_checkpoint_at: null,
        checkpoint_count: 0,
        verified_checkpoint_count: 0,
        completed_checkpoint_count: 0,
        resume_hint: null,
        task_memory_binding: {
          binding_status: null,
          plan_state_owner: null,
        },
      };

      planTitleEl.textContent = plan.title;
      centerPlanTitleEl.textContent = plan.title;
      planBodyEl.textContent = plan.markdown;
      centerPlanBodyEl.textContent = plan.markdown;

      resetNode(planChipsEl);
      appendChip(planChipsEl, 'Lifecycle', operationalState.plan_lifecycle || 'planning', false);
      appendChip(planChipsEl, 'Execution', operationalState.execution_state || 'idle', false);
      appendChip(planChipsEl, 'Active phase', operationalState.active_phase || operationalState.phase || plan.active_phase || 'not declared', !(operationalState.active_phase || operationalState.phase || plan.active_phase));
      appendChip(planChipsEl, 'Last completed', (operationalState.last_completed_slice && (operationalState.last_completed_slice.title || operationalState.last_completed_slice.id)) || 'none', !operationalState.last_completed_slice);
      appendChip(planChipsEl, 'Next slice', (operationalState.next_slice && (operationalState.next_slice.title || operationalState.next_slice.id)) || 'none', !operationalState.next_slice);
      appendChip(planChipsEl, 'Active slice', (operationalState.active_slice && (operationalState.active_slice.title || operationalState.active_slice.id)) || operationalState.current_slice_title || operationalState.current_slice_id || 'not projected', !operationalState.active_slice && !operationalState.current_slice_id && !operationalState.current_slice_title);
      appendChip(planChipsEl, 'Task memory', operationalState.task_memory_binding.binding_status || 'not bound', !operationalState.task_memory_binding.binding_status);
      appendChip(planChipsEl, 'Resume', operationalState.resume_hint || plan.resume_state.last_resume_note || 'no resume note yet', !operationalState.resume_hint && !plan.resume_state.last_resume_note);
      appendChip(planChipsEl, 'Log', plan.log_path || 'none', !plan.log_path);
      cloneChips(planChipsEl, centerPlanChipsEl);

      resetNode(registrySummaryEl);
      appendChip(registrySummaryEl, 'Headings', String(registry.summary.heading_count || 0), false);
      appendChip(registrySummaryEl, 'ADR', String(registry.summary.adr_binding_count || 0), false);
      appendChip(registrySummaryEl, 'Bindings', String(registry.summary.graph_binding_count || 0), false);
      appendChip(registrySummaryEl, 'Slices', String(registry.summary.slice_count || 0), false);
      appendChip(registrySummaryEl, 'Checkpoints', String(registry.summary.checkpoint_count || 0), false);
      appendChip(registrySummaryEl, 'Verified', String(operationalState.verified_checkpoint_count || 0), false);

      renderList(adrListEl, registry.adr_bindings, 'No ADR bindings projected yet.', function(node, adr) {
        appendAdrListItem(node, adr);
      });

      renderList(graphBindingListEl, (registry.graph_bindings || []).slice(0, 18), 'No graph bindings projected yet.', function(node, binding) {
        const secondary = (binding.href || binding.id) + ' • ' + binding.source;
        appendListItem(node, binding.kind + ': ' + binding.label, secondary);
      });

      renderList(sliceListEl, registry.slices, 'No structured slices projected yet.', function(node, slice) {
        const meta = (slice.status || 'unknown') + ' • ' + slice.category + ' • ' + slice.heading_path;
        appendListItem(node, slice.title, meta);
      });

      renderList(checkpointListEl, (registry.checkpoints || []).slice(-10).reverse(), 'No checkpoints found in implementation log.', function(node, checkpoint) {
        appendListItem(node, checkpoint.label, checkpoint.timestamp + (checkpoint.resume_note ? ' • ' + checkpoint.resume_note : ''));
      });

      renderList(evidenceLinkListEl, registry.evidence_links, 'No evidence links projected yet.', function(node, link) {
        appendListItem(node, link.kind + ': ' + link.label, link.target + (link.hint ? ' • ' + link.hint : ''));
      });

      const vscodeLinks = Object.entries(plan.vscode_links || {}).map(function(entry) {
        return { label: entry[0].replace(/_/g, ' '), href: entry[1] };
      });
      renderList(vscodeLinkListEl, vscodeLinks, 'No VS Code escape hatch links projected yet.', function(node, link) {
        const item = document.createElement('li');
        const anchor = document.createElement('a');
        anchor.href = link.href;
        anchor.textContent = 'Open ' + link.label + ' in VS Code';
        item.appendChild(anchor);
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = 'Companion editing escape hatch; orchestration remains daemon-owned.';
        item.appendChild(meta);
        node.appendChild(item);
      });
    }

    async function persistSelectedPlan(planId) {
      const selectedPlanId = planId || null;
      if (selectedPlanId === lastPersistedPlanId) return;
      try {
        const response = await fetch('/api/architect/v1/selection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ selected_plan_id: selectedPlanId }),
        });
        const payload = await response.json().catch(function() { return {}; });
        if (!response.ok) {
          throw new Error(payload.message || ('Selected plan save failed with HTTP ' + response.status));
        }
        lastPersistedPlanId = selectedPlanId;
        renderRuntime(payload);
        const result = payload.result || {};
        appendEventLine(selectedPlanId ? '[selection] selected ' + selectedPlanId + (result.persisted ? ' saved to engine.env' : ' stored in process state') : '[selection] cleared selected plan' + (result.persisted ? ' in engine.env' : ' in process state'));
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error);
        railStatusEl.textContent = 'Selected plan save failed: ' + message;
        appendEventLine('[selection] save failed: ' + message);
      }
    }

    function renderNoPlanSelected(message) {
      activePlanLoadToken += 1;
      activePlanId = null;
      activePlanButton = null;
      archivePlanButtonEl.disabled = true;
      for (const node of document.querySelectorAll('button.plan-item')) {
        node.classList.remove('active');
      }
      planTitleEl.textContent = 'No plan selected';
      centerPlanTitleEl.textContent = 'No plan selected';
      resetNode(planChipsEl);
      resetNode(centerPlanChipsEl);
      resetNode(registrySummaryEl);
      renderList(adrListEl, [], 'No plan selected.', function(node, item) { appendListItem(node, item, ''); });
      renderList(graphBindingListEl, [], 'No plan selected.', function(node, item) { appendListItem(node, item, ''); });
      renderList(sliceListEl, [], 'No plan selected.', function(node, item) { appendListItem(node, item, ''); });
      renderList(checkpointListEl, [], 'No plan selected.', function(node, item) { appendListItem(node, item, ''); });
      renderList(evidenceLinkListEl, [], 'No plan selected.', function(node, item) { appendListItem(node, item, ''); });
      renderList(vscodeLinkListEl, [], 'No plan selected.', function(node, item) { appendListItem(node, item, ''); });
      resetNode(futureSummaryEl);
      resetNode(futureCandidateListEl);
      resetNode(futureDecisionButtonsEl);
      resetNode(scheduleSummaryEl);
      resetNode(scheduleListEl);
      futureStatusEl.textContent = 'Select a plan to load advisory future review.';
      scheduleStatusEl.textContent = 'Select a plan to load scheduler projection.';
      actionStatusEl.textContent = 'Select a plan to record governed actions.';
      planBodyEl.textContent = message || 'No plan selected. Project-scope chat remains available.';
      centerPlanBodyEl.textContent = planBodyEl.textContent;
      setChatScope('project');
    }

    async function clearSelectedPlan() {
      renderNoPlanSelected('No plan selected. Project-scope chat remains available.');
      await persistSelectedPlan(null);
    }

    async function loadPlan(planId, button, options) {
      const loadToken = ++activePlanLoadToken;
      futureStatusEl.textContent = 'Loading advisory future review for ' + planId + '...';
      const response = await fetch('/api/architect/v1/plans/' + encodeURIComponent(planId), { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('Plan detail failed with HTTP ' + response.status);
      }
      const payload = await response.json();
      if (loadToken !== activePlanLoadToken) return;
      renderRuntime(payload);
      activePlanId = planId;
      activePlanButton = button;
      if (!options || options.activatePlanScope !== false) {
        setChatScope('plan');
      } else {
        renderChatScopePill();
      }
      archivePlanButtonEl.disabled = false;
      for (const node of document.querySelectorAll('button.plan-item')) {
        node.classList.toggle('active', node === button);
      }
      actionStatusEl.textContent = 'Governed actions ready for ' + planId;
      renderPlan(payload.plan);
      await persistSelectedPlan(planId);
      await loadFutureReview(planId, loadToken);
      await loadSchedules(planId, loadToken);
    }

    async function postGovernedAction(endpoint, body) {
      if (!activePlanId) {
        actionStatusEl.textContent = 'No plan selected.';
        return;
      }
      actionStatusEl.textContent = 'Recording...';
      const response = await fetch('/api/architect/v1/plans/' + encodeURIComponent(activePlanId) + '/' + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(function() { return {}; });
      if (!response.ok) {
        throw new Error(payload.message || ('Action failed with HTTP ' + response.status));
      }
      const result = payload.result || {};
      actionStatusEl.textContent = result.status + ': ' + result.action;
      appendEventLine('[action] ' + result.audit_id);
      if (activePlanButton) {
        await loadPlan(activePlanId, activePlanButton);
      }
    }

    async function readArchitectChatPayload(response) {
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/event-stream')) {
        return await response.json().catch(function() { return {}; });
      }
      const text = await response.text();
      const newline = String.fromCharCode(10);
      let resultPayload = {};
      for (const block of text.split(newline + newline)) {
        const lines = block.split(newline);
        const eventLine = lines.find(function(line) { return line.indexOf('event: ') === 0; });
        const dataLines = lines.filter(function(line) { return line.indexOf('data: ') === 0; });
        if (!eventLine || dataLines.length === 0) continue;
        const eventName = eventLine.slice('event: '.length);
        const rawData = dataLines.map(function(line) { return line.slice('data: '.length); }).join(newline);
        const data = JSON.parse(rawData);
        appendEventLine('[chat-stream] ' + eventName);
        if (eventName === 'architect.chat.result') {
          resultPayload = data;
        }
      }
      return resultPayload;
    }

    async function sendChatMessage(message) {
      const controls = selectedArchitectControls();
      const slash = parseChatSlashOverride(message);
      const dispatchScope = setChatScope(slash.scope || activeChatScope);
      const dispatchMessage = String(slash.message || '').trim();
      if (!dispatchMessage) {
        chatStatusEl.textContent = 'Enter a message after the slash scope command.';
        return;
      }
      if (dispatchScope === 'plan' && !activePlanId) {
        setChatScope('project');
        chatStatusEl.textContent = 'Select a plan before sending in Plan scope.';
        return;
      }
      liveToolTraceSeen = false;
      activeToolTracePanel = null;
      activeToolTraceRows = new Map();
      const persistedPayload = await persistArchitectControls();
      const requestRuntime = updateActiveArchitectRuntime(persistedPayload);
      appendChatMessage('user', dispatchMessage);
      autonomyPassCount += 1;
      updateAutonomyPassView('running', 0);
      setChatProcessing(true);
      chatStatusEl.textContent = 'Architect is responding with ' + architectRuntimeLabel(requestRuntime) + ' in ' + dispatchScope + ' scope...';
      try {
        const response = await fetch('/api/architect/v1/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
          body: JSON.stringify({
            message: dispatchMessage,
            scope: dispatchScope,
            chat_scope: dispatchScope,
            planId: dispatchScope === 'plan' ? activePlanId : null,
            selected_plan_id: activePlanId,
            continuationToken: null,
            mode: requestRuntime.autonomy_mode || controls.mode,
            autonomy_mode: requestRuntime.autonomy_mode || controls.mode,
            adapter: requestRuntime.adapter || controls.adapter,
            provider: requestRuntime.provider || controls.provider,
            model: requestRuntime.model || controls.model,
            session_id: requestRuntime.session_id,
            responseTransport: 'sse'
          }),
        });
        const payload = await readArchitectChatPayload(response);
        if (!response.ok) {
          throw new Error(payload.message || ('Architect chat failed with HTTP ' + response.status));
        }
        renderRuntime(payload);
        const runtime = updateActiveArchitectRuntime(payload);
        const result = payload.result || {};
        appendChatMessage('assistant', result.content || 'Architect returned an empty response.');
        const route = result.route || {};
        const toolLoop = route.tool_loop || {};
        const trace = Array.isArray(result.tool_trace) ? result.tool_trace : [];
        updateAutonomyPassView(route.fallback_reason ? 'partial' : 'complete', trace.length);
        if (trace.length > 0) {
          appendToolTraceMessage(trace, result.provenance);
        }
        if (result.provenance) {
          appendEventLine('[provenance] ' + summarizeProvenance(result.provenance));
        }
        if (activePlanId) {
          appendEventLine(result.plan_update && result.plan_update.changed ? '[plan-action] updated ' + activePlanId + ' via chat' : '[plan-action] refreshed ' + activePlanId + ' projection');
          await loadPlans(activePlanId, { activatePlanScope: dispatchScope === 'plan' });
        }
        chatStatusEl.textContent = 'Using ' + architectRuntimeLabel(runtime) + ' | scope ' + (result.chat_scope || dispatchScope) + ' | model source ' + (runtime.model_source || route.model_source || 'unknown') + ' | session ' + (runtime.session_id || 'unknown') + ' | tools ' + (toolLoop.advertised_tool_count || 0) + '/' + (toolLoop.available_tool_count || 0) + ' | trace ' + trace.length + (route.fallback_reason ? ' | ' + route.fallback_reason : '');
      } finally {
        setChatProcessing(false);
      }
    }

    function compactText(value, limit) {
      const text = String(value || '').replace(/[_-]+/g, ' ').trim();
      if (!limit || text.length <= limit) return text;
      return text.slice(0, Math.max(0, limit - 3)).trim() + '...';
    }

    function appendPlanMeta(button, value) {
      const meta = document.createElement('div');
      meta.className = 'plan-meta';
      meta.textContent = value;
      button.appendChild(meta);
    }

    function appendSelectOptions(select, values) {
      const current = select.value;
      resetNode(select);
      const allOption = document.createElement('option');
      allOption.value = '';
      allOption.textContent = 'All';
      select.appendChild(allOption);
      for (const value of values || []) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = compactText(value, 28);
        select.appendChild(option);
      }
      select.value = Array.from(select.options).some(function(option) { return option.value === current; }) ? current : '';
    }

    function planMatchesFilters(plan) {
      const textFilter = (planSearchInputEl.value || '').trim().toLowerCase();
      const statusFilter = planStatusFilterEl.value;
      const phaseFilter = planPhaseFilterEl.value;
      const operational = plan.operational_state || {};
      const haystack = [
        plan.id,
        plan.title,
        plan.status,
        plan.active_phase,
        operational.plan_lifecycle,
        operational.execution_state,
        operational.current_slice_id,
        operational.current_slice_title,
        operational.current_status,
        operational.last_completed_slice && operational.last_completed_slice.title,
        operational.next_slice && operational.next_slice.title,
      ].filter(Boolean).join(' ').toLowerCase();
      if (textFilter && haystack.indexOf(textFilter) < 0) return false;
      if (statusFilter && plan.status !== statusFilter && operational.plan_lifecycle !== statusFilter) return false;
      if (phaseFilter && plan.active_phase !== phaseFilter && operational.phase !== phaseFilter && operational.active_phase !== phaseFilter) return false;
      return true;
    }

    function buildPlanListButton(plan) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'plan-item';
      button.dataset.planId = plan.id;
      const operational = plan.operational_state || {};
      const activePhase = operational.active_phase || operational.phase || plan.active_phase || 'No active phase';
      const activeSlice = (operational.active_slice && (operational.active_slice.title || operational.active_slice.id)) || operational.current_slice_title || operational.current_slice_id || 'not projected';
      const lastCompleted = (operational.last_completed_slice && (operational.last_completed_slice.title || operational.last_completed_slice.id)) || 'none';
      const nextSlice = (operational.next_slice && (operational.next_slice.title || operational.next_slice.id)) || 'none';
      if (activeSlice !== 'not projected' || lastCompleted !== 'none' || nextSlice !== 'none') {
        button.classList.add('has-current-slice');
      }
      const taskMemory = (operational.task_memory_binding && operational.task_memory_binding.binding_status) || 'not bound';
      button.title = [plan.title || plan.id, plan.id, activePhase, 'Lifecycle: ' + (operational.plan_lifecycle || 'planning'), 'Execution: ' + (operational.execution_state || 'idle'), 'Last completed: ' + lastCompleted, 'Next slice: ' + nextSlice, 'Task memory: ' + taskMemory].join(String.fromCharCode(10));
      const title = document.createElement('strong');
      title.className = 'plan-title';
      title.textContent = plan.title || plan.id;
      button.appendChild(title);
      appendPlanMeta(button, plan.id);
      appendPlanMeta(button, activePhase);
      appendPlanMeta(button, (operational.plan_lifecycle || 'planning') + ' | ' + (operational.execution_state || 'idle'));
      appendPlanMeta(button, 'ADR ' + String((plan.adr_bindings || []).length) + ' | slices ' + String(plan.slice_count || 0) + ' | checkpoints ' + String(plan.checkpoint_count || 0));
      appendPlanMeta(button, 'Last ' + lastCompleted + ' | next ' + nextSlice + ' | memory ' + taskMemory);
      if (activeSlice !== 'not projected') {
        const sliceNode = document.createElement('div');
        sliceNode.className = 'plan-slice-child';
        sliceNode.textContent = 'Active: ' + activeSlice + (operational.current_status ? ' | ' + operational.current_status : '');
        button.appendChild(sliceNode);
      }
      button.addEventListener('click', function() {
        if (activePlanId === plan.id) {
          clearSelectedPlan().catch(function(error) {
            planBodyEl.textContent = String(error instanceof Error ? error.message : error);
          });
          return;
        }
        loadPlan(plan.id, button, { activatePlanScope: true }).catch(function(error) {
          planBodyEl.textContent = String(error instanceof Error ? error.message : error);
        });
      });
      return button;
    }

    function renderPlanTree(preferredPlanId) {
      resetNode(planListEl);
      const visiblePlans = planIndexCache.filter(planMatchesFilters);
      const visibleIds = new Set(visiblePlans.map(function(plan) { return plan.id; }));
      let firstButton = null;
      let firstPlanId = null;
      let requestedButton = null;
      let requestedResolvedPlanId = null;
      for (const group of planTreeCache) {
        const groupPlans = (group.children || [])
          .map(function(node) { return planIndexCache.find(function(plan) { return plan.id === node.id; }); })
          .filter(function(plan) { return plan && visibleIds.has(plan.id); });
        if (groupPlans.length === 0) continue;
        const groupNode = document.createElement('section');
        groupNode.className = 'plan-tree-group';
        const heading = document.createElement('div');
        heading.className = 'plan-tree-heading';
        const label = document.createElement('span');
        label.textContent = group.title || group.id || 'Plans';
        const count = document.createElement('span');
        count.textContent = String(groupPlans.length);
        heading.appendChild(label);
        heading.appendChild(count);
        groupNode.appendChild(heading);
        const children = document.createElement('div');
        children.className = 'plan-tree-children';
        for (const plan of groupPlans) {
          const button = buildPlanListButton(plan);
          children.appendChild(button);
          if (!firstButton) {
            firstButton = button;
            firstPlanId = plan.id;
          }
          if (preferredPlanId && plan.id === preferredPlanId) {
            requestedButton = button;
            requestedResolvedPlanId = plan.id;
          }
          if (activePlanId && plan.id === activePlanId) {
            activePlanButton = button;
            button.classList.add('active');
          }
        }
        groupNode.appendChild(children);
        planListEl.appendChild(groupNode);
      }
      railStatusEl.textContent = String(visiblePlans.length) + ' of ' + String(planIndexCache.length) + ' daemon-projected plans visible';
      return { firstButton: firstButton, firstPlanId: firstPlanId, requestedButton: requestedButton, requestedResolvedPlanId: requestedResolvedPlanId };
    }

    async function loadPlans(preferredPlanId, options) {
      const response = await fetch('/api/architect/v1/plans');
      if (!response.ok) {
        throw new Error('Plan list failed with HTTP ' + response.status);
      }
      const payload = await response.json();
      renderRuntime(payload);
      const plans = payload.plans || [];
      planIndexCache = plans;
      planTreeCache = payload.plan_tree || [];
      planFilterProjection = payload.plan_filters || { status_options: [], phase_options: [] };
      appendSelectOptions(planStatusFilterEl, planFilterProjection.status_options);
      appendSelectOptions(planPhaseFilterEl, planFilterProjection.phase_options);
      activePlanId = null;
      activePlanButton = null;
      archivePlanButtonEl.disabled = true;
      const project = payload.project_scope || {};
      railStatusEl.textContent = String(plans.length) + ' markdown plan files from ' + (project.plans_root || 'project plans/');
      if (plans.length === 0) {
        renderNoPlanSelected('No plan markdown files found under the active project plans/ folder.');
        return;
      }
      const selection = payload.architect_selection || {};
      lastPersistedPlanId = payload.selected_plan_id || selection.selected_plan_id || null;
      const requestedPlanId = preferredPlanId || new URLSearchParams(window.location.search).get('plan') || payload.selected_plan_id || selection.selected_plan_id;
      const treeSelection = renderPlanTree(requestedPlanId);
      const firstButton = treeSelection.firstButton;
      const firstPlanId = treeSelection.firstPlanId;
      const requestedButton = treeSelection.requestedButton;
      const requestedResolvedPlanId = treeSelection.requestedResolvedPlanId;
      if (requestedButton && requestedResolvedPlanId) {
        await loadPlan(requestedResolvedPlanId, requestedButton, options);
      } else {
        renderNoPlanSelected('No plan selected. Project-scope chat remains available.');
      }
    }

    async function createPlanFromPanel() {
      const title = window.prompt('Plan title', 'New Architect Plan');
      if (title === null) return;
      const compactTitle = title.trim();
      if (!compactTitle) {
        railStatusEl.textContent = 'Enter a plan title first.';
        return;
      }
      createPlanButtonEl.disabled = true;
      railStatusEl.textContent = 'Creating plan...';
      try {
        const response = await fetch('/api/architect/v1/plans', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: compactTitle }),
        });
        const payload = await response.json().catch(function() { return {}; });
        if (!response.ok) {
          throw new Error(payload.message || ('Plan create failed with HTTP ' + response.status));
        }
        const plan = payload.plan || {};
        appendEventLine('[plan-action] created ' + (plan.id || compactTitle));
        await loadPlans(plan.id);
      } finally {
        createPlanButtonEl.disabled = false;
      }
    }

    async function archiveActivePlanFromPanel() {
      if (!activePlanId) {
        railStatusEl.textContent = 'Select a plan to archive.';
        return;
      }
      const planId = activePlanId;
      const planTitle = planTitleEl.textContent || planId;
      if (!window.confirm('Archive "' + planTitle + '"?')) return;
      archivePlanButtonEl.disabled = true;
      railStatusEl.textContent = 'Archiving plan...';
      try {
        const response = await fetch('/api/architect/v1/plans/' + encodeURIComponent(planId) + '/archive', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            audit_reason: 'Operator archived the selected plan from the standalone Architect plan rail.',
            slice_id: 'standalone-architect-plan-panel',
          }),
        });
        const payload = await response.json().catch(function() { return {}; });
        if (!response.ok) {
          throw new Error(payload.message || ('Plan archive failed with HTTP ' + response.status));
        }
        appendEventLine('[plan-action] archived ' + planId);
        await loadPlans();
      } finally {
        archivePlanButtonEl.disabled = !activePlanId;
      }
    }

    function connectEvents() {
      const stream = new EventSource('/api/architect/v1/events');
      stream.addEventListener('architect.status', function(event) {
        appendTypedEventLine('status', event);
      });
      stream.addEventListener('architect.noop', function(event) {
        const envelope = parseArchitectEvent(event);
        if (envelope.payload && (envelope.payload.project_scope || envelope.payload.architect_llm)) {
          renderRuntime(envelope.payload);
        }
        renderLiveEventStatus(envelope, 'idle');
      });
      stream.addEventListener('architect.tool_result', appendToolTraceEvent);
      stream.addEventListener('architect.plan_action', function(event) {
        appendTypedEventLine('plan-action', event);
      });
      stream.addEventListener('architect.review_gate', function(event) {
        appendTypedEventLine('review-gate', event);
      });
      stream.addEventListener('architect.adr_edit_proposal', function(event) {
        appendTypedEventLine('adr-edit', event);
      });
      stream.addEventListener('architect.schedule_action', function(event) {
        appendTypedEventLine('schedule-action', event);
      });
      stream.addEventListener('architect.chat', function(event) {
        appendTypedEventLine('chat', event);
      });
      stream.addEventListener('architect.config', function(event) {
        appendTypedEventLine('config', event);
      });
      stream.onerror = function() {
        liveEventStatusEl.textContent = 'Events: reconnecting';
        liveEventStatusEl.title = 'The Architect event stream will retry automatically.';
        appendEventLine('[stream] reconnecting');
      };
    }

    renderRuntime(initialRuntimePayload);
    hydrateArchitectCenterTabs();
    hydrateArchitectControls(initialRuntimePayload);
    renderChatScopePill();
    updateAutonomyPassView('idle', 0);
    appendChatMessage('assistant', 'Architect chat is ready. Select a plan on the left or ask about the active project.');
    chatInputEl.addEventListener('keydown', function(event) {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      if (typeof chatFormEl.requestSubmit === 'function') {
        chatFormEl.requestSubmit();
      } else {
        chatFormEl.dispatchEvent(new Event('submit', { cancelable: true }));
      }
    });
    chatFormEl.addEventListener('submit', function(event) {
      event.preventDefault();
      if (chatProcessing) {
        chatStatusEl.textContent = 'Architect is still processing.';
        return;
      }
      const message = chatInputEl.value.trim();
      if (!message) {
        chatStatusEl.textContent = 'Enter a message first.';
        return;
      }
      chatInputEl.value = '';
      sendChatMessage(message).catch(function(error) {
        updateAutonomyPassView('failed', 0);
        chatStatusEl.textContent = String(error instanceof Error ? error.message : error);
      });
    });

    createPlanButtonEl.addEventListener('click', function() {
      createPlanFromPanel().catch(function(error) {
        railStatusEl.textContent = String(error instanceof Error ? error.message : error);
      });
    });
    archivePlanButtonEl.addEventListener('click', function() {
      archiveActivePlanFromPanel().catch(function(error) {
        railStatusEl.textContent = String(error instanceof Error ? error.message : error);
      });
    });
    planSearchInputEl.addEventListener('input', function() { renderPlanTree(activePlanId); });
    planStatusFilterEl.addEventListener('change', function() { renderPlanTree(activePlanId); });
    planPhaseFilterEl.addEventListener('change', function() { renderPlanTree(activePlanId); });
    chatScopePillEl.addEventListener('click', toggleChatScope);

    recordActionButtonEl.addEventListener('click', function() {
      postGovernedAction('actions', {
        action: 'project_bound_architect_checkpoint_requested',
        audit_reason: 'Operator requested a governed project-bound Architect checkpoint from the standalone browser chat surface.',
        slice_id: 'standalone-architect-project-bound-chat-shell',
      }).catch(function(error) {
        actionStatusEl.textContent = String(error instanceof Error ? error.message : error);
      });
    });
    reviewGateButtonEl.addEventListener('click', function() {
      postGovernedAction('review-gates', {
        action: 'create',
        gate_id: 'project-bound-architect-review-gate',
        audit_reason: 'Operator requested a visible review gate before browser-initiated Architect workflow actions are recorded.',
        slice_id: 'standalone-architect-project-bound-chat-shell',
      }).catch(function(error) {
        actionStatusEl.textContent = String(error instanceof Error ? error.message : error);
      });
    });

    loadPlans().catch(function(error) {
      railStatusEl.textContent = 'Plan index failed';
      planBodyEl.textContent = String(error instanceof Error ? error.message : error);
      centerPlanBodyEl.textContent = planBodyEl.textContent;
    });
    connectEvents();
  </script>
    <style id="architect-sidebar-resize-style">
      :root {
        --architect-left-sidebar-width: 280px;
        --architect-right-sidebar-width: 360px;
      }

      [data-architect-resizable-sidebars="true"] [data-architect-sidebar="left"] {
        width: var(--architect-left-sidebar-width) !important;
        min-width: 220px;
        max-width: min(520px, 42vw);
      }

      [data-architect-resizable-sidebars="true"] [data-architect-sidebar="right"] {
        width: var(--architect-right-sidebar-width) !important;
        min-width: 260px;
        max-width: min(640px, 46vw);
      }

      body.architect-left-collapsed [data-architect-sidebar="left"],
      body.architect-right-collapsed [data-architect-sidebar="right"] {
        width: 42px !important;
        min-width: 42px !important;
        overflow: hidden;
      }

      body.architect-left-collapsed [data-architect-sidebar="left"] > :not(.architect-sidebar-collapse):not(.architect-sidebar-handle),
      body.architect-right-collapsed [data-architect-sidebar="right"] > :not(.architect-sidebar-collapse):not(.architect-sidebar-handle) {
        visibility: hidden;
        pointer-events: none;
      }

      .architect-sidebar-collapse {
        position: absolute;
        top: 6px;
        z-index: 25;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        margin: 0;
        border: 1px solid rgba(148, 163, 184, 0.3);
        border-radius: 5px;
        background: rgba(15, 23, 42, 0.86);
        color: #e2e8f0;
        cursor: pointer;
        font: 800 10px/1 var(--sans);
      }

      [data-architect-sidebar="left"] > .architect-sidebar-collapse { right: 6px; }
      [data-architect-sidebar="right"] > .architect-sidebar-collapse { left: 6px; }

      .architect-sidebar-collapse:hover,
      .architect-sidebar-collapse:focus-visible {
        border-color: rgba(56, 189, 248, 0.82);
        color: #f8fafc;
        outline: none;
      }

      .architect-sidebar-handle {
        position: absolute;
        top: 0;
        bottom: 0;
        z-index: 24;
        width: 7px;
        cursor: col-resize;
        touch-action: none;
      }

      [data-architect-sidebar="left"] .architect-sidebar-handle {
        right: -4px;
      }

      [data-architect-sidebar="right"] .architect-sidebar-handle {
        left: -4px;
      }

      .architect-sidebar-handle::after {
        content: "";
        position: absolute;
        top: 12px;
        bottom: 12px;
        left: 3px;
        width: 1px;
        border-radius: 999px;
        background: rgba(148, 163, 184, 0.24);
      }

      .architect-sidebar-handle:hover::after,
      .architect-sidebar-handle:focus-visible::after,
      .architect-sidebar-handle.is-resizing::after {
        background: rgba(56, 189, 248, 0.9);
      }

      .architect-right-accordion {
        display: block;
        border-top: 1px solid rgba(148, 163, 184, 0.16);
      }

      .architect-right-accordion > summary {
        display: flex;
        align-items: center;
        min-height: 28px;
        padding: 5px 8px;
        color: #cbd5e1;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0;
        cursor: pointer;
        list-style: none;
      }

      .architect-right-accordion > summary::-webkit-details-marker {
        display: none;
      }

      .architect-right-accordion > summary::before {
        content: ">";
        width: 16px;
        color: #38bdf8;
        font-size: 11px;
      }

      .architect-right-accordion[open] > summary::before {
        content: "v";
      }

      .architect-right-accordion > :not(summary) {
        padding-inline: 8px;
      }

      #right-sidebar-stack {
        gap: 4px;
      }

      [data-architect-sidebar="right"] {
        padding: 8px;
      }

      [data-architect-sidebar="right"] h2 {
        margin: 0 24px 4px 0;
        font-size: 0.95rem;
        line-height: 1.18;
      }

      [data-architect-sidebar="right"] .status {
        margin-top: 6px;
        font-size: 0.72rem;
        line-height: 1.25;
      }

      [data-architect-sidebar="right"] .event-log {
        max-height: 170px;
      }
    </style>
    <script id="architect-sidebar-resize-script">
      (function () {
        const STORAGE_KEY = 'architect.sidebar.state.v1';
        const leftSelectors = ['[data-architect-sidebar="left"]', '.rail', '[data-panel="plans"]', '[data-panel="plan-rail"]', '.plan-rail', '.plans-rail', '.architect-plan-rail', '.left-sidebar'];
        const rightSelectors = ['[data-architect-sidebar="right"]', '.content', '[data-panel="context"]', '[data-panel="details"]', '[data-panel="right-sidebar"]', '.right-sidebar', '.details-sidebar', '.context-sidebar', '.architect-right-sidebar'];
        const clamp = function (value, min, max) { return Math.max(min, Math.min(max, value)); };
        const readState = function () {
          try { return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch (_) { return {}; }
        };
        const writeState = function (state) {
          try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) { /* storage may be unavailable */ }
        };
        const firstMatch = function (selectors) {
          for (const selector of selectors) {
            const match = document.querySelector(selector);
            if (match) { return match; }
          }
          return null;
        };
        const left = firstMatch(leftSelectors);
        const right = firstMatch(rightSelectors);
        const layoutRoot = document.querySelector('.architect-shell, .architect-layout, .architect-browser-shell, .architect-browser, main') || document.body;
        if (!left && !right) { return; }
        const state = readState();
        layoutRoot.setAttribute('data-architect-resizable-sidebars', 'true');
        document.body.classList.toggle('architect-left-collapsed', state.leftCollapsed === true);
        document.body.classList.toggle('architect-right-collapsed', state.rightCollapsed === true);
        if (Number.isFinite(state.leftWidth)) { document.documentElement.style.setProperty('--architect-left-sidebar-width', String(clamp(state.leftWidth, 220, 520)) + 'px'); }
        if (Number.isFinite(state.rightWidth)) { document.documentElement.style.setProperty('--architect-right-sidebar-width', String(clamp(state.rightWidth, 260, 640)) + 'px'); }

        const installSidebar = function (panel, side) {
          if (!panel || panel.dataset.architectSidebarReady === 'true') { return; }
          panel.dataset.architectSidebar = side;
          panel.dataset.architectSidebarReady = 'true';
          if (getComputedStyle(panel).position === 'static') { panel.style.position = 'relative'; }

          const existingButton = panel.querySelector(':scope > .architect-sidebar-collapse');
          const button = existingButton || document.createElement('button');
          button.type = 'button';
          button.className = 'architect-sidebar-collapse';
          button.title = side === 'left' ? 'Collapse plans sidebar' : 'Collapse context sidebar';
          button.setAttribute('aria-label', button.title);
          button.textContent = side === 'left' ? '<' : '>';
          const collapsedClass = side === 'left' ? 'architect-left-collapsed' : 'architect-right-collapsed';
          const collapsedKey = side === 'left' ? 'leftCollapsed' : 'rightCollapsed';
          const syncButton = function () {
            const collapsed = document.body.classList.contains(collapsedClass);
            button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
            button.textContent = side === 'left' ? (collapsed ? '>' : '<') : (collapsed ? '<' : '>');
          };
          button.addEventListener('click', function () {
            const next = !document.body.classList.contains(collapsedClass);
            document.body.classList.toggle(collapsedClass, next);
            const nextState = readState();
            nextState[collapsedKey] = next;
            writeState(nextState);
            syncButton();
          });
          if (!existingButton) {
            panel.insertBefore(button, panel.firstChild);
          }
          syncButton();

          const existingHandle = panel.querySelector(':scope > .architect-sidebar-handle');
          const handle = existingHandle || document.createElement('div');
          handle.className = 'architect-sidebar-handle';
          handle.tabIndex = 0;
          handle.setAttribute('role', 'separator');
          handle.setAttribute('aria-orientation', 'vertical');
          handle.setAttribute('aria-label', side === 'left' ? 'Resize plans sidebar' : 'Resize context sidebar');
          if (!existingHandle) {
            panel.appendChild(handle);
          }

          const widthKey = side === 'left' ? 'leftWidth' : 'rightWidth';
          const variableName = side === 'left' ? '--architect-left-sidebar-width' : '--architect-right-sidebar-width';
          const minimum = side === 'left' ? 220 : 260;
          const maximum = side === 'left' ? 520 : 640;
          const setWidth = function (value) {
            const width = clamp(value, minimum, maximum);
            document.documentElement.style.setProperty(variableName, String(width) + 'px');
            const nextState = readState();
            nextState[widthKey] = width;
            nextState[collapsedKey] = false;
            writeState(nextState);
            document.body.classList.remove(collapsedClass);
            syncButton();
          };
          handle.addEventListener('pointerdown', function (event) {
            event.preventDefault();
            document.body.classList.add('architect-resizing');
            handle.classList.add('is-resizing');
            handle.setPointerCapture(event.pointerId);
            const onMove = function (moveEvent) {
              const rect = panel.getBoundingClientRect();
              setWidth(side === 'left' ? moveEvent.clientX - rect.left : rect.right - moveEvent.clientX);
            };
            const onUp = function () {
              document.body.classList.remove('architect-resizing');
              handle.classList.remove('is-resizing');
              handle.removeEventListener('pointermove', onMove);
              handle.removeEventListener('pointerup', onUp);
              handle.removeEventListener('pointercancel', onUp);
            };
            handle.addEventListener('pointermove', onMove);
            handle.addEventListener('pointerup', onUp);
            handle.addEventListener('pointercancel', onUp);
          });
          handle.addEventListener('keydown', function (event) {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') { return; }
            event.preventDefault();
            const current = panel.getBoundingClientRect().width;
            const delta = event.key === 'ArrowRight' ? 16 : -16;
            setWidth(side === 'left' ? current + delta : current - delta);
          });
        };

        const titleFrom = function (element, index) {
          const heading = element.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > header, :scope > .section-title, :scope > .panel-title');
          const title = (heading && heading.textContent ? heading.textContent : '').trim();
          if (title) { return title; }
          if (element.dataset && element.dataset.title) { return element.dataset.title; }
          return 'Section ' + String(index + 1);
        };
        const shouldOpen = function (element, index) {
          if (element.matches('[open], [data-active="true"], [aria-current="true"], .active, .is-active, .error, .has-error, [data-state="error"]')) { return true; }
          if (element.querySelector('[data-active="true"], [aria-current="true"], .active, .is-active, .error, .has-error, [data-state="error"]')) { return true; }
          return index === 0;
        };
        const installRightAccordions = function (panel) {
          if (!panel || panel.dataset.architectAccordionsReady === 'true') { return; }
          panel.dataset.architectAccordionsReady = 'true';
          const accordionRoot = panel.querySelector(':scope > .stack') || panel;
          const children = Array.from(accordionRoot.children).filter(function (child) {
            return child.id !== 'plan-chips' && child.id !== 'plan-title' && !child.classList.contains('architect-sidebar-collapse') && !child.classList.contains('architect-sidebar-handle') && child.tagName !== 'STYLE' && child.tagName !== 'SCRIPT';
          });
          children.forEach(function (child, index) {
            if (child.tagName === 'DETAILS') {
              child.classList.add('architect-right-accordion');
              if (!shouldOpen(child, index)) { child.removeAttribute('open'); }
              return;
            }
            if (child.dataset && child.dataset.architectAccordionWrapped === 'true') { return; }
            const details = document.createElement('details');
            details.className = 'architect-right-accordion';
            if (shouldOpen(child, index)) { details.open = true; }
            const summary = document.createElement('summary');
            summary.textContent = titleFrom(child, index);
            details.appendChild(summary);
            child.dataset.architectAccordionWrapped = 'true';
            accordionRoot.insertBefore(details, child);
            details.appendChild(child);
          });
        };

        installSidebar(left, 'left');
        installSidebar(right, 'right');
        installRightAccordions(right);
      })();
    </script>
</body>
</html>`;
}

function handleArchitectContract(req: IncomingMessage, res: ServerResponse): void {
  sendJsonWithEtag(req, res, {
    ok: true,
    contract: "architect",
    version: "v1",
    ...buildMeta(),
    routes: {
      shell: "/architect",
      contract: "/api/architect",
      chat: "/api/architect/v1/chat",
      chat_method: "POST",
      chat_request_content_type: "application/json",
      chat_response_transports: ["application/json", "text/event-stream"],
      config: "POST /api/architect/v1/config",
      selection: "POST /api/architect/v1/selection",
      plans: "/api/architect/v1/plans",
      plan_detail: "/api/architect/v1/plans/{planId}",
      plan_create: "POST /api/architect/v1/plans",
      plan_archive: "POST /api/architect/v1/plans/{planId}/archive",
      events: "/api/architect/v1/events",
      plan_actions: "/api/architect/v1/plans/{planId}/actions",
      review_gates: "/api/architect/v1/plans/{planId}/review-gates",
      pending_diffs: "/api/architect/v1/plans/{planId}/pending-diffs",
      future_review: "/api/architect/v1/plans/{planId}/future-review",
      schedules: "/api/architect/v1/schedules",
      schedule_actions: "/api/architect/v1/schedules/{scheduleId}/actions",
      adrs: "/api/architect/v1/adrs",
      adr_preview: "/api/architect/v1/adrs/{adrId}",
      adr_edit_proposal: "POST /api/architect/v1/adrs/{adrId}/edits",
    },
    plan_projection: {
      source: "markdown_projection",
      operational_state_source: "implementation_log_projection",
      evidence_model: "semantic-anchor-first",
      fields: [
        "adr_bindings",
        "graph_bindings",
        "slices",
        "checkpoints",
        "operational_state",
        "task_memory_binding",
        "evidence_links",
        "resume_state",
      ],
      mutation_endpoints_enabled: true,
      governed_action_model: "append-only implementation-log audit; no direct browser filesystem or arbitrary graph mutation authority",
    },
    adaptive_future_projection: {
      advisory: true,
      provenance_required: true,
      fallback_visible: true,
      supersession_aware: true,
      review_gate_endpoint: "/api/architect/v1/plans/{planId}/review-gates",
    },
    scheduler_projection: {
      source: "dream_scheduler",
      actions: ["run_now", "pause", "resume"],
      action_model: "daemon-governed schedule action with optional plan implementation-log audit binding",
    },
    vscode_interop: {
      companion_surface: true,
      cutover_requires_superseding_adr: true,
      standalone_open_command: "dreamgraph.openStandaloneArchitect",
      deep_link_model: "vscode://file escape hatches for editing; orchestration remains daemon-owned",
    },
  });
}

export async function handleArchitectRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  try {
    await ensureArchitectInstanceBinding();
    if (req.method === "GET" && (pathname === "/architect" || pathname === "/architect/")) {
      html(res, 200, renderArchitectShell());
      return true;
    }

    if (req.method === "GET" && (pathname === "/api/architect" || pathname === "/api/architect/" || pathname === "/api/architect/v1" || pathname === "/api/architect/v1/")) {
      handleArchitectContract(req, res);
      return true;
    }

    if (pathname === "/api/architect/v1/chat" && req.method !== "POST") {
      res.writeHead(405, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        Allow: "POST",
      });
      res.end(JSON.stringify({
        ok: false,
        error: "method_not_allowed",
        message: "Architect chat prompts must use POST application/json. GET is intentionally rejected so prompt text never travels in URLs, browser history, referrers, proxy logs, or tunnel metadata.",
      }));
      return true;
    }

    if (req.method === "POST" && pathname === "/api/architect/v1/chat") {
      await handleArchitectChatRequest(req, res);
      return true;
    }

    if (req.method === "POST" && pathname === "/api/architect/v1/config") {
      await handleArchitectConfigRequest(req, res);
      return true;
    }

    if (req.method === "POST" && pathname === "/api/architect/v1/selection") {
      await handleArchitectSelectionRequest(req, res);
      return true;
    }

    if (req.method === "GET" && pathname === "/api/architect/v1/plans") {
      await handlePlansIndex(req, res);
      return true;
    }

    if (req.method === "GET" && pathname === "/api/architect/v1/adrs") {
      await handleAdrIndex(req, res);
      return true;
    }

    const adrSubroute = parseArchitectAdrSubroute(pathname);
    if (adrSubroute && !adrSubroute.adrId) {
      jsonError(res, 400, "bad_request", "Missing ADR id");
      return true;
    }

    if (req.method === "GET" && adrSubroute && adrSubroute.suffix == null) {
      await handleAdrPreview(req, res, adrSubroute.adrId);
      return true;
    }

    if (req.method === "POST" && adrSubroute?.suffix === "edits") {
      await handleAdrEditProposal(req, res, adrSubroute.adrId);
      return true;
    }

    if (req.method === "POST" && pathname === "/api/architect/v1/plans") {
      await handlePlanCreateRequest(req, res);
      return true;
    }

    if (req.method === "GET" && (pathname === "/api/architect/v1/schedules" || pathname === "/api/architect/v1/schedules/")) {
      await handleArchitectSchedulesIndex(req, res);
      return true;
    }

    const scheduleSubroute = parseArchitectScheduleSubroute(pathname);
    if (scheduleSubroute && !scheduleSubroute.scheduleId) {
      jsonError(res, 400, "bad_request", "Missing schedule id");
      return true;
    }

    if (req.method === "POST" && scheduleSubroute?.suffix === "actions") {
      await handleArchitectScheduleActionRequest(req, res, scheduleSubroute.scheduleId);
      return true;
    }

    const planSubroute = parseArchitectPlanSubroute(pathname);
    if (planSubroute && !planSubroute.planId) {
      jsonError(res, 400, "bad_request", "Missing plan id");
      return true;
    }

    if (req.method === "POST" && planSubroute?.suffix === "archive") {
      await handlePlanArchiveRequest(req, res, planSubroute.planId);
      return true;
    }

    if (req.method === "POST" && planSubroute?.suffix === "actions") {
      await handlePlanActionRequest(req, res, planSubroute.planId, "plan_action");
      return true;
    }

    if (req.method === "POST" && planSubroute?.suffix === "review-gates") {
      await handlePlanActionRequest(req, res, planSubroute.planId, "review_gate");
      return true;
    }

    if (req.method === "GET" && planSubroute?.suffix === "future-review") {
      await handlePlanFutureReview(req, res, planSubroute.planId);
      return true;
    }

    if (req.method === "GET" && planSubroute?.suffix === "pending-diffs") {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      const runGit = async (args: string[]): Promise<string> => {
        try {
          const { stdout } = await execFileAsync("git", args, {
            cwd: getArchitectProjectRoot(),
            maxBuffer: 2 * 1024 * 1024,
            windowsHide: true,
          });
          return stdout.toString();
        } catch (error) {
          const output = error as { message?: string; stderr?: Buffer | string; stdout?: Buffer | string };
          const detail = output.stderr?.toString() || output.stdout?.toString() || output.message || "git command failed";
          throw new Error(detail.trim());
        }
      };
      const statusText = await runGit(["status", "--porcelain=v1"]);
      const allChangedFiles = statusText
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const rawStatus = line.slice(0, 2);
          const rawPath = line.slice(3).trim();
          const filePath = rawPath.includes(" -> ") ? rawPath.split(" -> ").pop() ?? rawPath : rawPath;
          return {
            filePath,
            status: rawStatus.trim() || "modified",
          };
        });
      const changedFiles = allChangedFiles.slice(0, 50);
      const diffs = await Promise.all(changedFiles.map(async (entry) => {
        const [stagedDiff, worktreeDiff] = await Promise.all([
          runGit(["diff", "--cached", "--", entry.filePath]),
          runGit(["diff", "--", entry.filePath]),
        ]);
        const diff = [stagedDiff.trim(), worktreeDiff.trim()].filter(Boolean).join("\n");
        return {
          ...entry,
          diff: diff.slice(0, 60000),
          reviewable: diff.length > 0,
          truncated: diff.length > 60000,
        };
      }));
      const reviewGateEndpoint = `/api/architect/v1/plans/${encodeURIComponent(planSubroute.planId)}/review-gates`;
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({
        planId: planSubroute.planId,
        generatedAt: new Date().toISOString(),
        model: "daemon-governed-pending-diff-projection",
        guardRails: [
          "Browser clients receive a daemon-produced diff projection, not direct filesystem authority.",
          "Keep and Undo are explicit review decisions recorded through governed review gates.",
          "ADR guard-check warnings remain visible before mutation review decisions are recorded.",
        ],
        decisions: [
          {
            id: "keep",
            label: "Keep",
            method: "POST",
            endpoint: reviewGateEndpoint,
            body: {
              gate: "pending_diff_review",
              decision: "keep",
              status: "accepted",
              summary: "Keep the daemon-produced pending diff outcome.",
            },
          },
          {
            id: "undo",
            label: "Undo",
            method: "POST",
            endpoint: reviewGateEndpoint,
            body: {
              gate: "pending_diff_review",
              decision: "undo",
              status: "rejected",
              summary: "Undo the daemon-produced pending diff outcome through governed reversal semantics.",
            },
          },
        ],
        diffs,
        omittedCount: Math.max(0, allChangedFiles.length - changedFiles.length),
      }));
      return true;
    }

    if (req.method === "GET" && planSubroute && planSubroute.suffix == null) {
      await handlePlanDetail(req, res, planSubroute.planId);
      return true;
    }

    if (req.method === "GET" && pathname === "/api/architect/v1/events") {
      handleArchitectEvents(req, res);
      return true;
    }

    if (pathname.startsWith("/api/architect/")) {
      jsonError(res, 404, "not_found", `No Architect endpoint: ${pathname}`);
      return true;
    }

    return false;
  } catch (error) {
    logger.error(`/architect route error (${pathname}):`, error);
    jsonError(res, 500, "internal_error", (error as Error).message);
    return true;
  }
}
