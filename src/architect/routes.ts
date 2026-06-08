import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import * as pty from "node-pty";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
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
import { compileTaskPreamble } from "../cognitive/graph-rag.js";
import type { CompiledTaskPreamble } from "../cognitive/types.js";
import { estimateTokensFromString, type BudgetCoordinator } from "@dreamgraph/token-economy/budget-coordinator";
import {
  buildArchitectBudgetStatus,
  createStandaloneBudgetCoordinator,
  finalizeStandaloneBudgetTurn,
  type ArchitectBudgetStatus,
} from "./token-economy/standalone-store.js";
import {
  createLlmProviderForConfig,
  getArchitectLlmConfig,
  updateArchitectLlmConfig,
  type ArchitectLlmConfig,
  type LlmMessage,
  type LlmProviderType,
} from "../cognitive/llm.js";
import { getScheduleHistory, getSchedules, runScheduleNow, updateSchedule } from "../cognitive/scheduler.js";
import { cmdPlugin } from "../cli/commands/plugin.js";
import { cmdRestart } from "../cli/commands/restart.js";
import { cmdStatus } from "../cli/commands/status.js";
import type { ParsedArgs } from "../cli/dg.js";
import { getActiveScope, isInstanceMode, resolveInstanceAtStartup } from "../instance/lifecycle.js";
import { config } from "../config/config.js";
import { executeExtractApiSurface } from "../tools/api-surface.js";
import { updateEngineEnvValues } from "../utils/engine-env.js";
import { loadJsonData } from "../utils/cache.js";
import { logger } from "../utils/logger.js";
import type { ADRLogFile, ArchitectureDecisionRecord } from "../types/index.js";
import { engine } from "../cognitive/engine.js";
import {
  buildArchitectPulseSnapshot,
  formatArchitectPulseLine,
  type ArchitectPulseSnapshot,
} from "./pulse.js";
import { buildArchitectDesireLedger } from "./desire-ledger.js";
import { buildOnboardingReadinessProjection } from "./onboarding-readiness.js";
import { ArchitectRepoSetupError, buildArchitectRepoSetupProjection, persistArchitectRepoSetup } from "./repo-setup.js";
import { readOnboardingTelemetryEvents, recordOnboardingTelemetryEvent } from "./onboarding-telemetry.js";
import { buildCalibrationEvaluation } from "../cognitive/calibration-evaluation.js";
import { buildDreamPlayback } from "../cognitive/playback.js";
import { buildCognitiveLifecycleProjection } from "../cognitive/lifecycle-visibility.js";
import { buildTensionClusters } from "../cognitive/tension-clustering.js";
import {
  ArchitectContributionError,
  dispatchArchitectTabAction,
  listArchitectTabs,
  loadArchitectTabSnapshot,
} from "../plugins/architect-contributions.js";
import { ArchitectPlanStateError } from "../plugins/architect-plan-state.js";

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
    resume_hint?: string | null;
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
const MAX_ATTACHMENT_UPLOAD_BODY_BYTES = 8 * 1024 * 1024;
const MAX_ARCHITECT_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const ARCHITECT_ATTACHMENT_GC_AGE_MS = 24 * 60 * 60 * 1000;
const ARCHITECT_DOOM_SPIKE_BUNDLE_SOURCE_URL = "https://v8.js-dos.com/bundles/doom.jsdos";
const ARCHITECT_DOOM_SPIKE_BUNDLE_SHA256 = "40d74b90f3527480d2256c75ef443777bd5bebde95133cfe3ba01b2390516712";
const ARCHITECT_DOOM_SPIKE_BUNDLE_MAX_BYTES = 8 * 1024 * 1024;
let architectDoomSpikeBundleAcquisition: Promise<Record<string, unknown>> | null = null;
let architectDoomSpikeBundleDownload: Record<string, unknown> | null = null;

function isArchitectDoomEnabled(): boolean {
  return process.env.DREAMGRAPH_ENABLE_DOOM?.trim().toLowerCase() === "true";
}

const ARCHITECT_PROVIDER_OPTIONS: LlmProviderType[] = ["openai", "anthropic", "ollama", "lmstudio", "sampling", "none"];
const ARCHITECT_ADAPTER_OPTIONS = ["native_api_tool_loop", "codex-cli", "copilot-cli", "deterministic_fallback"] as const;
const ARCHITECT_AUTONOMY_MODE_OPTIONS = ["autonomous", "supervised", "manual"] as const;

export function buildArchitectProviderReadiness(input: { adapter?: unknown; provider?: unknown; model?: unknown }): Record<string, unknown> {
  const adapter = ARCHITECT_ADAPTER_OPTIONS.includes(input.adapter as typeof ARCHITECT_ADAPTER_OPTIONS[number])
    ? input.adapter as typeof ARCHITECT_ADAPTER_OPTIONS[number]
    : "native_api_tool_loop";
  const provider = ARCHITECT_PROVIDER_OPTIONS.includes(input.provider as LlmProviderType) ? input.provider as LlmProviderType : "none";
  const model = typeof input.model === "string" ? input.model.trim() : "";
  const authority = "dreamgraph_mcp";
  if (adapter === "codex-cli" || adapter === "copilot-cli") {
    return { ready: true, adapter, provider: "none", model, authority, kind: "cli_subscription", detail: `${adapter} subscription route is ready. Repository authority remains DreamGraph MCP.` };
  }
  if (adapter === "deterministic_fallback") {
    return { ready: true, adapter, provider: "none", model: "", authority, kind: "deterministic", detail: "Deterministic fallback is ready without AI configuration." };
  }
  if (provider === "none") return { ready: false, adapter, provider, model, authority, kind: "api_or_local", detail: "Choose an API or local provider." };
  if (!model) return { ready: false, adapter, provider, model, authority, kind: "api_or_local", detail: "Choose a model before testing this route." };
  if ((provider === "openai" || provider === "anthropic") && !process.env.DREAMGRAPH_LLM_API_KEY?.trim()) {
    return { ready: false, adapter, provider, model, authority, kind: "api", detail: `Set DREAMGRAPH_LLM_API_KEY for ${provider}.` };
  }
  const kind = provider === "ollama" || provider === "lmstudio" ? "local" : "api";
  return { ready: true, adapter, provider, model, authority, kind, detail: kind === "local" ? `${provider} configuration is complete. Send a prompt to confirm the local service is running.` : `${provider} API configuration is complete.` };
}
const ARCHITECT_SELECTED_PLAN_ENV_KEY = "DREAMGRAPH_ARCHITECT_SELECTED_PLAN_ID";
const ARCHITECT_XTERM_ASSETS: Record<string, { path: string; contentType: string }> = {
  "/api/architect/v1/assets/xterm/xterm.css": {
    path: resolve(fileURLToPath(import.meta.url), "..", "..", "..", "node_modules", "@xterm", "xterm", "css", "xterm.css"),
    contentType: "text/css; charset=utf-8",
  },
  "/api/architect/v1/assets/xterm/xterm.js": {
    path: resolve(fileURLToPath(import.meta.url), "..", "..", "..", "node_modules", "@xterm", "xterm", "lib", "xterm.js"),
    contentType: "application/javascript; charset=utf-8",
  },
  "/api/architect/v1/assets/xterm/addon-fit.js": {
    path: resolve(fileURLToPath(import.meta.url), "..", "..", "..", "node_modules", "@xterm", "addon-fit", "lib", "addon-fit.js"),
    contentType: "application/javascript; charset=utf-8",
  },
  "/api/architect/v1/assets/lucide/lucide.js": {
    path: resolve(fileURLToPath(import.meta.url), "..", "..", "..", "node_modules", "lucide", "dist", "umd", "lucide.js"),
    contentType: "application/javascript; charset=utf-8",
  },
};
const ARCHITECT_MONACO_ASSET_BASE = "/api/architect/v1/assets/monaco/vs/";
const ARCHITECT_MONACO_ASSET_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "node_modules", "monaco-editor", "min", "vs");
const ARCHITECT_JS_DOS_ASSET_BASE = "/api/architect/v1/assets/js-dos/";
const ARCHITECT_JS_DOS_ASSET_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "node_modules", "js-dos", "dist");
type ArchitectAdapterType = typeof ARCHITECT_ADAPTER_OPTIONS[number];
type ArchitectAutonomyMode = typeof ARCHITECT_AUTONOMY_MODE_OPTIONS[number];
type ArchitectExecutionRoute = ArchitectAdapterType;
type ArchitectPassStatus = "idle" | "running" | "paused" | "partial" | "timed_out" | "cancelled" | "complete" | "failed";
type ArchitectChatScope = "plan" | "project";
type ArchitectExecutionControlAction = "stop" | "pause" | "resume" | "steer";

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
  execution_controls: ArchitectExecutionControlCapabilities;
  token_economy: ArchitectTokenEconomyConfig;
}

interface ArchitectExecutionControlCapabilities {
  stop: boolean;
  pause: boolean;
  resume: boolean;
  steering: boolean;
}

interface ActiveArchitectExecutionControl {
  id: string;
  adapter: ArchitectAdapterType;
  controller: AbortController;
  state: Extract<ArchitectPassStatus, "running" | "paused" | "cancelled">;
  started_at: string;
  last_action_at: string;
  steering_prompts: Array<{ prompt: string; received_at: string }>;
}

interface ArchitectTerminalSession {
  id: string;
  title: string;
  process: pty.IPty;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  connection_state: "detached" | "connected";
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  exit_code: number | null;
  output: string[];
  sockets: Set<WebSocket>;
  subscribers: Set<(eventName: string, payload: unknown) => void>;
  cleanup_started: boolean;
}

type ArchitectTerminalSocketMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

type ArchitectRuntimeRouteContext = ActiveArchitectSessionRuntime;

interface ArchitectTokenEconomyConfig {
  preamble_compiler: boolean;
  token_economy: boolean;
  soft_target_tokens: number;
  transport_ceiling_tokens: number;
  debt_carry_fraction: number;
  source: "architect" | "default";
  env_keys: {
    preamble_compiler: typeof ARCHITECT_PREAMBLE_COMPILER_ENV_KEY;
    token_economy: typeof ARCHITECT_TOKEN_ECONOMY_ENV_KEY;
    soft_target_tokens: typeof ARCHITECT_TOKEN_ECONOMY_SOFT_TARGET_ENV_KEY;
    transport_ceiling_tokens: typeof ARCHITECT_TOKEN_ECONOMY_TRANSPORT_CEILING_ENV_KEY;
    debt_carry_fraction: typeof ARCHITECT_TOKEN_ECONOMY_DEBT_CARRY_ENV_KEY;
  };
}

interface ArchitectChatPromptBundle {
  systemPrompt: string;
  tokenEconomy: Record<string, unknown>;
}

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

const ARCHITECT_PREAMBLE_COMPILER_ENV_KEY = "DREAMGRAPH_ARCHITECT_PREAMBLE_COMPILER";
const ARCHITECT_TOKEN_ECONOMY_ENV_KEY = "DREAMGRAPH_ARCHITECT_TOKEN_ECONOMY";
const ARCHITECT_TOKEN_ECONOMY_SOFT_TARGET_ENV_KEY = "DREAMGRAPH_ARCHITECT_TOKEN_ECONOMY_SOFT_TARGET";
const ARCHITECT_TOKEN_ECONOMY_TRANSPORT_CEILING_ENV_KEY = "DREAMGRAPH_ARCHITECT_TOKEN_ECONOMY_TRANSPORT_CEILING";
const ARCHITECT_TOKEN_ECONOMY_DEBT_CARRY_ENV_KEY = "DREAMGRAPH_ARCHITECT_TOKEN_ECONOMY_DEBT_CARRY_FRACTION";
const ARCHITECT_TOKEN_ECONOMY_DEFAULT_SOFT_TARGET = 16_000;
const ARCHITECT_TOKEN_ECONOMY_DEFAULT_TRANSPORT_CEILING = 180_000;
const ARCHITECT_TOKEN_ECONOMY_DEFAULT_DEBT_CARRY = 1;
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
let activeArchitectExecutionControl: ActiveArchitectExecutionControl | null = null;
let latestArchitectPulse: ArchitectPulseSnapshot | null = null;
let lastPublishedArchitectPulseHash: string | null = null;
let architectTerminalSequence = 0;
const architectTerminalSessions = new Map<string, ArchitectTerminalSession>();
const architectTerminalWebSocketServer = new WebSocketServer({ noServer: true });

process.once("exit", () => closeAllArchitectTerminalSessions());

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

function architectBooleanFromEnv(value: string | undefined, defaultValue: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  return defaultValue;
}

function architectPositiveIntFromEnv(value: string | undefined, defaultValue: number): number {
  const parsed = Number.parseInt(value?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function architectFractionFromEnv(value: string | undefined, defaultValue: number): number {
  const parsed = Number.parseFloat(value?.trim() ?? "");
  if (!Number.isFinite(parsed)) return defaultValue;
  if (parsed < 0) return 0;
  if (parsed > 1) return 1;
  return parsed;
}

function architectBooleanField(body: Record<string, unknown>, field: string): boolean | null {
  const value = body[field];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
    if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  }
  return null;
}

function getArchitectTokenEconomyConfig(): ArchitectTokenEconomyConfig {
  const preambleRaw = process.env[ARCHITECT_PREAMBLE_COMPILER_ENV_KEY];
  const economyRaw = process.env[ARCHITECT_TOKEN_ECONOMY_ENV_KEY];
  const targetRaw = process.env[ARCHITECT_TOKEN_ECONOMY_SOFT_TARGET_ENV_KEY];
  const ceilingRaw = process.env[ARCHITECT_TOKEN_ECONOMY_TRANSPORT_CEILING_ENV_KEY];
  const carryRaw = process.env[ARCHITECT_TOKEN_ECONOMY_DEBT_CARRY_ENV_KEY];
  return {
    preamble_compiler: architectBooleanFromEnv(preambleRaw, true),
    token_economy: architectBooleanFromEnv(economyRaw, true),
    soft_target_tokens: architectPositiveIntFromEnv(targetRaw, ARCHITECT_TOKEN_ECONOMY_DEFAULT_SOFT_TARGET),
    transport_ceiling_tokens: architectPositiveIntFromEnv(ceilingRaw, ARCHITECT_TOKEN_ECONOMY_DEFAULT_TRANSPORT_CEILING),
    debt_carry_fraction: architectFractionFromEnv(carryRaw, ARCHITECT_TOKEN_ECONOMY_DEFAULT_DEBT_CARRY),
    source: preambleRaw != null || economyRaw != null || targetRaw != null || ceilingRaw != null || carryRaw != null ? "architect" : "default",
    env_keys: {
      preamble_compiler: ARCHITECT_PREAMBLE_COMPILER_ENV_KEY,
      token_economy: ARCHITECT_TOKEN_ECONOMY_ENV_KEY,
      soft_target_tokens: ARCHITECT_TOKEN_ECONOMY_SOFT_TARGET_ENV_KEY,
      transport_ceiling_tokens: ARCHITECT_TOKEN_ECONOMY_TRANSPORT_CEILING_ENV_KEY,
      debt_carry_fraction: ARCHITECT_TOKEN_ECONOMY_DEBT_CARRY_ENV_KEY,
    },
  };
}

function selectedPlanIdFromText(value: string | null): string | null {
  const planId = value?.trim();
  return planId && isSafePlanId(planId) ? planId : null;
}

function getArchitectSelectedPlanConfig(): { planId: string | null; source: "architect" | "default" } {
  const planId = selectedPlanIdFromText(process.env[ARCHITECT_SELECTED_PLAN_ENV_KEY]?.trim() ?? null);
  return planId ? { planId, source: "architect" } : { planId: null, source: "default" };
}

function persistArchitectSelectedPlanId(planId: string | null): { persisted: boolean; engineEnvPath: string | null } {
  const scope = getActiveScope();
  const value = planId ?? "";
  if (scope?.engineEnvPath) {
    updateEngineEnvValues(scope.engineEnvPath, { [ARCHITECT_SELECTED_PLAN_ENV_KEY]: value });
  }
  process.env[ARCHITECT_SELECTED_PLAN_ENV_KEY] = value;
  return { persisted: Boolean(scope?.engineEnvPath), engineEnvPath: scope?.engineEnvPath ?? null };
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

function buildArchitectExecutionControlCapabilities(adapter: ArchitectAdapterType): ArchitectExecutionControlCapabilities {
  const isCli = adapter === "codex-cli" || adapter === "copilot-cli";
  return {
    stop: isCli,
    pause: false,
    resume: false,
    steering: false,
  };
}

function buildArchitectExecutionControlSnapshot(runtime: ActiveArchitectSessionRuntime): Record<string, unknown> {
  return {
    state: activeArchitectExecutionControl?.state ?? runtime.pass_state.status,
    active_execution_id: activeArchitectExecutionControl?.id ?? null,
    started_at: activeArchitectExecutionControl?.started_at ?? null,
    last_action_at: activeArchitectExecutionControl?.last_action_at ?? null,
    capabilities: runtime.execution_controls,
    steering_queue_length: activeArchitectExecutionControl?.steering_prompts.length ?? 0,
    adapter: runtime.adapter,
    session_id: runtime.session_id,
  };
}

function buildArchitectExecutionControlPayload(runtime: ActiveArchitectSessionRuntime): Record<string, unknown> {
  return {
    runtime,
    execution_control: buildArchitectExecutionControlSnapshot(runtime),
  };
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
    execution_controls: buildArchitectExecutionControlCapabilities(runtimeAdapter),
    token_economy: getArchitectTokenEconomyConfig(),
  } as ActiveArchitectSessionRuntime;
}

function buildArchitectRuntimeLabel(runtime: Pick<ActiveArchitectSessionRuntime, "adapter" | "provider" | "model">): string {
  if (runtime.adapter && runtime.adapter !== "native_api_tool_loop") {
    return `${runtime.adapter}/${runtime.model || "none"}`;
  }
  return `${runtime.provider || "none"}/${runtime.model || "none"}`;
}

async function buildArchitectPulseProjection(): Promise<ArchitectPulseSnapshot> {
  const runtime = buildActiveArchitectSessionRuntime();
  const selected = getArchitectSelectedPlanConfig();
  const plan = selected.planId ? await loadArchitectPlanDetail(selected.planId) : null;
  return buildArchitectPulseSnapshot({
    cognitive: await engine.getStatus(),
    runtime,
    plan: plan ? { id: plan.id, title: plan.title, operational_state: plan.operational_state } : null,
  });
}

async function publishArchitectPulseIfChanged(force = false): Promise<ArchitectPulseSnapshot | null> {
  try {
    const pulse = await buildArchitectPulseProjection();
    latestArchitectPulse = pulse;
    if (force || pulse.pulse_hash !== lastPublishedArchitectPulseHash) {
      lastPublishedArchitectPulseHash = pulse.pulse_hash;
      publishEvent("architect.pulse", pulse);
    }
    return pulse;
  } catch (error) {
    logger.warn(`architect pulse projection failed: ${(error as Error).message}`);
    return latestArchitectPulse;
  }
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

function buildArchitectAttachmentCapabilities(runtime: ActiveArchitectSessionRuntime): { textAttachments: boolean; imageAttachments: boolean } {
  const adapter = String(runtime.adapter || "native_api_tool_loop").toLowerCase();
  const provider = String(runtime.provider || "none").toLowerCase();
  const model = String(runtime.model || "").toLowerCase();
  if (adapter === "codex-cli" || adapter === "copilot-cli") {
    return { textAttachments: true, imageAttachments: true };
  }
  if (adapter === "deterministic_fallback") {
    return { textAttachments: false, imageAttachments: false };
  }
  switch (provider) {
    case "anthropic":
      return { textAttachments: true, imageAttachments: model.startsWith("claude") };
    case "openai":
      return {
        textAttachments: true,
        imageAttachments:
          model.startsWith("gpt-5") ||
          model.startsWith("gpt-4.1") ||
          model.startsWith("gpt-4o") ||
          model.startsWith("o4") ||
          model.startsWith("o3"),
      };
    case "ollama":
    case "lmstudio":
      return { textAttachments: true, imageAttachments: false };
    default:
      return { textAttachments: false, imageAttachments: false };
  }
}

function buildArchitectLlmPayload(runtime: ActiveArchitectSessionRuntime = buildActiveArchitectSessionRuntime()): Record<string, unknown> {
  const tokenEconomy = getArchitectTokenEconomyConfig();
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
    capabilities: {
      ...buildArchitectAttachmentCapabilities(runtime),
      executionControls: runtime.execution_controls,
    },
    token_economy: tokenEconomy,
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
    onboarding_readiness: buildOnboardingReadinessProjection(runtime),
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
      provider_readiness: "POST /api/architect/v1/provider-readiness",
      repo_setup: "GET|POST /api/architect/v1/repo-setup",
      onboarding_events: "GET|POST /api/architect/v1/onboarding-events",
      plans: "/api/architect/v1/plans",
      plan_create: "POST /api/architect/v1/plans",
      plan_archive: "POST /api/architect/v1/plans/{planId}/archive",
      plan_detail: "/api/architect/v1/plans/{planId}",
      plan_actions: "POST /api/architect/v1/plans/{planId}/actions",
      plugin_tabs: "GET /api/architect/v1/plugin-tabs",
      plugin_tab_snapshot: "GET /api/architect/v1/plugin-tabs/{tabTypeId}/snapshot?planId={planId}",
      plugin_tab_actions: "POST /api/architect/v1/plugin-tabs/{tabTypeId}/actions",
      future_review: "/api/architect/v1/plans/{planId}/future-review",
      review_gates: "POST /api/architect/v1/plans/{planId}/review-gates",
      schedules: "/api/architect/v1/schedules",
      schedule_actions: "POST /api/architect/v1/schedules/{scheduleId}/actions",
      adrs: "/api/architect/v1/adrs",
      adr_preview: "/api/architect/v1/adrs/{adrId}",
      adr_edit_proposal: "POST /api/architect/v1/adrs/{adrId}/edits",
      events: "/api/architect/v1/events",
      event_transport: "text/event-stream",
      commands: "POST /api/architect/v1/commands",
      execution_controls: "POST /api/architect/v1/commands stop|pause|resume",
    },
    execution_control: buildArchitectExecutionControlSnapshot(runtime),
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
void publishArchitectPulseIfChanged(true);
const heartbeat = setInterval(() => {
  publishEvent("architect.noop", {
    ...buildArchitectStatusPayload(),
    status: "idle",
    note: "Project-bound Architect chat and plan controls are live; browser requests stay daemon-scoped to the active instance and attached project root.",
  });
  void publishArchitectPulseIfChanged(false);
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

function resolveArchitectJsDosAssetRoot(): string {
  const projectRoot = getActiveScope()?.projectRoot;
  if (projectRoot) {
    const projectAssetRoot = resolve(projectRoot, "node_modules", "js-dos", "dist");
    if (existsSync(projectAssetRoot)) return projectAssetRoot;
  }
  return ARCHITECT_JS_DOS_ASSET_ROOT;
}

function getArchitectBrowserAsset(pathname: string): { path: string; contentType: string } | null {
  const xtermAsset = ARCHITECT_XTERM_ASSETS[pathname];
  if (xtermAsset) return xtermAsset;
  const assetBase = pathname.startsWith(ARCHITECT_MONACO_ASSET_BASE)
    ? ARCHITECT_MONACO_ASSET_BASE
    : isArchitectDoomEnabled() && pathname.startsWith(ARCHITECT_JS_DOS_ASSET_BASE)
      ? ARCHITECT_JS_DOS_ASSET_BASE
      : null;
  if (!assetBase) return null;
  const assetRoot = assetBase === ARCHITECT_MONACO_ASSET_BASE ? ARCHITECT_MONACO_ASSET_ROOT : resolveArchitectJsDosAssetRoot();
  const assetRelativePath = normalizeArchitectEditorFilePath(pathname.slice(assetBase.length));
  if (!assetRelativePath) return null;
  const assetPath = resolve(assetRoot, assetRelativePath);
  const assetRepoRelative = relative(assetRoot, assetPath);
  if (assetRepoRelative.startsWith("..") || isAbsolute(assetRepoRelative)) return null;
  const extension = extname(assetPath).toLowerCase();
  const contentType = extension === ".css"
    ? "text/css; charset=utf-8"
    : extension === ".json"
      ? "application/json; charset=utf-8"
      : extension === ".wasm"
        ? "application/wasm"
        : extension === ".ttf" || extension === ".woff" || extension === ".woff2"
          ? "font/woff2"
          : "application/javascript; charset=utf-8";
  return { path: assetPath, contentType };
}

async function handleArchitectAssetRequest(res: ServerResponse, pathname: string): Promise<void> {
  const asset = getArchitectBrowserAsset(pathname);
  if (!asset) {
    jsonError(res, 404, "not_found", "Architect asset not found");
    return;
  }
  try {
    const body = await readFile(asset.path);
    res.writeHead(200, {
      "Content-Type": asset.contentType,
      "Cache-Control": "public, max-age=3600",
    });
    res.end(body);
  } catch (error) {
    logger.warn(`architect asset load failed (${pathname}): ${(error as Error).message}`);
    jsonError(res, 404, "asset_unavailable", "Architect browser asset is unavailable");
  }
}

function architectDoomSpikeBundlePath(): string {
  const scope = getActiveScope();
  if (!scope) throw new Error("Architect Doom spike bundle acquisition requires a bound DreamGraph instance.");
  return resolve(scope.runtimeDir, "cache", "architect-doom", "doom-shareware.jsdos");
}

async function inspectArchitectDoomSpikeBundle(): Promise<Record<string, unknown>> {
  const filePath = architectDoomSpikeBundlePath();
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) {
    return {
      acquired: false,
      source_url: ARCHITECT_DOOM_SPIKE_BUNDLE_SOURCE_URL,
      source_kind: "js_dos_hosted_doom_shareware_bundle",
      approval_required: true,
      local_bundle_url: null,
      download: architectDoomSpikeBundleDownload,
    };
  }
  const body = await readFile(filePath);
  const sha256 = createHash("sha256").update(body).digest("hex");
  if (body.length > ARCHITECT_DOOM_SPIKE_BUNDLE_MAX_BYTES || sha256 !== ARCHITECT_DOOM_SPIKE_BUNDLE_SHA256) {
    await rm(filePath, { force: true });
    throw new Error("Cached Architect Doom spike bundle failed integrity verification.");
  }
  return {
    acquired: true,
    source_url: ARCHITECT_DOOM_SPIKE_BUNDLE_SOURCE_URL,
    source_kind: "js_dos_hosted_doom_shareware_bundle",
    approval_required: true,
    local_bundle_url: `/api/architect/v1/doom/spike-bundle?sha256=${sha256}`,
    size: body.length,
    sha256,
    acquired_at: info.mtime.toISOString(),
  };
}

async function acquireArchitectDoomSpikeBundle(): Promise<Record<string, unknown>> {
  const current = await inspectArchitectDoomSpikeBundle();
  if (current.acquired === true) return current;
  if (architectDoomSpikeBundleAcquisition) return await architectDoomSpikeBundleAcquisition;
  architectDoomSpikeBundleAcquisition = (async () => {
    const response = await fetch(ARCHITECT_DOOM_SPIKE_BUNDLE_SOURCE_URL);
    if (!response.ok) throw new Error(`Doom shareware bundle download failed (${response.status}).`);
    const totalBytes = Number(response.headers.get("content-length")) || null;
    const chunks: Buffer[] = [];
    let downloadedBytes = 0;
    architectDoomSpikeBundleDownload = { state: "downloading", downloaded_bytes: downloadedBytes, total_bytes: totalBytes };
    if (response.body) {
      for await (const chunk of response.body) {
        const bytes = Buffer.from(chunk);
        chunks.push(bytes);
        downloadedBytes += bytes.length;
        if (downloadedBytes > ARCHITECT_DOOM_SPIKE_BUNDLE_MAX_BYTES) throw new Error("Doom shareware bundle exceeds the pinned size limit.");
        architectDoomSpikeBundleDownload = { state: "downloading", downloaded_bytes: downloadedBytes, total_bytes: totalBytes };
      }
    } else {
      const bytes = Buffer.from(await response.arrayBuffer());
      chunks.push(bytes);
      downloadedBytes = bytes.length;
    }
    const body = Buffer.concat(chunks);
    const sha256 = createHash("sha256").update(body).digest("hex");
    if (body.length > ARCHITECT_DOOM_SPIKE_BUNDLE_MAX_BYTES || sha256 !== ARCHITECT_DOOM_SPIKE_BUNDLE_SHA256) {
      throw new Error("Doom shareware bundle failed pinned integrity verification.");
    }
    const filePath = architectDoomSpikeBundlePath();
    await mkdir(resolve(filePath, ".."), { recursive: true, mode: 0o700 });
    const pendingPath = `${filePath}.${randomUUID()}.pending`;
    await writeFile(pendingPath, body, { mode: 0o600 });
    await rename(pendingPath, filePath);
    architectDoomSpikeBundleDownload = { state: "complete", downloaded_bytes: body.length, total_bytes: body.length };
    return await inspectArchitectDoomSpikeBundle();
  })().catch((error: unknown) => {
    architectDoomSpikeBundleDownload = { state: "failed", message: (error as Error).message };
    throw error;
  }).finally(() => {
    architectDoomSpikeBundleAcquisition = null;
  });
  return await architectDoomSpikeBundleAcquisition;
}

async function handleArchitectDoomSpikeBundleStatus(res: ServerResponse): Promise<void> {
  json(res, 200, { ok: true, bundle: await inspectArchitectDoomSpikeBundle() }, { "Cache-Control": "no-store" });
}

async function handleArchitectDoomSpikeBundleAcquire(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  if (body.approved !== true) {
    jsonError(res, 400, "approval_required", "Explicit user approval is required before downloading the Doom shareware bundle.");
    return;
  }
  json(res, 201, { ok: true, bundle: await acquireArchitectDoomSpikeBundle() }, { "Cache-Control": "no-store" });
}

async function handleArchitectDoomSpikeBundleRead(res: ServerResponse): Promise<void> {
  const bundle = await inspectArchitectDoomSpikeBundle();
  if (bundle.acquired !== true) {
    jsonError(res, 404, "bundle_not_acquired", "Download the Doom shareware bundle with explicit user approval first.");
    return;
  }
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Cache-Control": "no-store",
    "Content-Length": String(bundle.size),
  });
  res.end(await readFile(architectDoomSpikeBundlePath()));
}

function renderArchitectDoomSpikeHarness(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DreamGraph Architect js-dos Spike</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="stylesheet" href="/api/architect/v1/assets/js-dos/js-dos.css" />
  <style>
    html, body { height: 100%; margin: 0; background: #111827; color: #e5e7eb; font: 14px system-ui, sans-serif; }
    body { display: grid; grid-template-rows: auto minmax(0, 1fr); }
    header { display: flex; gap: 8px; align-items: center; padding: 10px; background: #1f2937; }
    button { padding: 6px 10px; }
    #dos { min-height: 0; }
    #status { margin-left: auto; color: #cbd5e1; }
  </style>
</head>
<body>
  <header>
    <button id="approve" type="button">Approve Doom Shareware Download</button>
    <button id="pause" type="button" disabled>Pause</button>
    <button id="resume" type="button" disabled>Resume</button>
    <button id="exit" type="button" disabled>Exit</button>
    <span id="status">Checking local fixture cache...</span>
  </header>
  <div id="dos"></div>
  <script>
    const statusEl = document.getElementById('status');
    const approveButton = document.getElementById('approve');
    const pauseButton = document.getElementById('pause');
    const resumeButton = document.getElementById('resume');
    const exitButton = document.getElementById('exit');
    const dosRoot = document.getElementById('dos');
    let props = null;
    let startedAt = 0;
    let runtimePromise = null;

    function setStatus(message) { statusEl.textContent = message; }
    function loadRuntime() {
      if (runtimePromise) return runtimePromise;
      runtimePromise = new Promise(function(resolve, reject) {
        const script = document.createElement('script');
        script.src = '/api/architect/v1/assets/js-dos/js-dos.js';
        script.onload = function() { window.Dos ? resolve(window.Dos) : reject(new Error('js-dos did not initialize.')); };
        script.onerror = function() { reject(new Error('Local js-dos runtime failed to load.')); };
        document.head.appendChild(script);
      }).catch(function(error) {
        runtimePromise = null;
        throw error;
      });
      return runtimePromise;
    }
    async function stop() {
      if (!props) return;
      const active = props;
      props = null;
      pauseButton.disabled = true;
      resumeButton.disabled = true;
      exitButton.disabled = true;
      await active.stop();
      dosRoot.replaceChildren();
      setStatus('Exited cleanly. Open a new spike session to restart.');
    }
    async function start() {
      if (props) return;
      const Dos = await loadRuntime();
      startedAt = performance.now();
      props = Dos(dosRoot, {
        url: '/api/architect/v1/doom/spike-bundle?sha256=${ARCHITECT_DOOM_SPIKE_BUNDLE_SHA256}',
        pathPrefix: '/api/architect/v1/assets/js-dos/emulators/',
        autoStart: true,
        noNetworking: true,
        noCloud: true,
        onEvent: function(event) {
          if (event === 'ci-ready') setStatus('Running from local daemon assets. First start: ' + Math.round(performance.now() - startedAt) + ' ms.');
        },
      });
      pauseButton.disabled = false;
      resumeButton.disabled = false;
      exitButton.disabled = false;
      setStatus('Starting local js-dos worker...');
    }
    async function refresh() {
      const response = await fetch('/api/architect/v1/doom/spike-bundle/status', { cache: 'no-store' });
      const payload = await response.json();
      const bundle = payload.bundle || {};
      approveButton.disabled = bundle.acquired === true;
      approveButton.textContent = bundle.acquired === true ? 'Doom Shareware Acquired' : 'Approve Doom Shareware Download';
      setStatus(bundle.acquired === true ? 'Fixture cached locally. Starting spike...' : 'Approval required before downloading ' + bundle.source_url);
      if (bundle.acquired === true) await start();
    }
    approveButton.addEventListener('click', async function() {
      approveButton.disabled = true;
      setStatus('Acquiring pinned official fixture...');
      try {
        const response = await fetch('/api/architect/v1/doom/spike-bundle/acquire', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approved: true }) });
        const payload = await response.json().catch(function() { return {}; });
        if (!response.ok) throw new Error(payload.message || 'Fixture acquisition failed.');
        await refresh();
      } catch (error) {
        setStatus(error.message || String(error));
        if (approveButton.textContent !== 'Doom Shareware Acquired') approveButton.disabled = false;
      }
    });
    pauseButton.addEventListener('click', function() { if (props) { props.setPaused(true); setStatus('Paused.'); } });
    resumeButton.addEventListener('click', function() { if (props) { props.setPaused(false); setStatus('Resumed.'); } });
    exitButton.addEventListener('click', function() { void stop(); });
    window.addEventListener('beforeunload', function() { void stop(); });
    refresh().catch(function(error) { setStatus(error.message || String(error)); approveButton.disabled = false; });
  </script>
</body>
</html>`;
}

function buildArchitectEditorRepoProjection(): Array<Record<string, string | boolean>> {
  return Object.entries(config.repos).map(([id]) => ({
    id,
    name: id,
    display_name: id,
    direct_browser_filesystem_access: false,
  }));
}

function normalizeArchitectEditorFilePath(value: string): string {
  return String(value ?? "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function assertArchitectEditorPathInsideRepo(repoRoot: string, safePath: string, inputPath: string, repoId: string): void {
  const repoRelative = relative(repoRoot, safePath);
  if (repoRelative === "" || (!repoRelative.startsWith("..") && !isAbsolute(repoRelative))) {
    return;
  }
  throw new Error(`Path '${inputPath}' escapes repo '${repoId}'.`);
}

function resolveArchitectEditorPath(repoId: string, inputPath: string, options?: { allowRoot?: boolean }): { repoRoot: string; safePath: string; relativePath: string } {
  const repoRootRaw = config.repos[repoId];
  if (!repoRootRaw) {
    throw new Error(`Unknown repo '${repoId}'.`);
  }
  const repoRoot = resolve(repoRootRaw);
  const normalized = normalizeArchitectEditorFilePath(inputPath);
  if (!normalized && !options?.allowRoot) {
    throw new Error("File path is required.");
  }
  const safePath = normalized ? resolve(repoRoot, normalized) : repoRoot;
  assertArchitectEditorPathInsideRepo(repoRoot, safePath, inputPath, repoId);
  return { repoRoot, safePath, relativePath: normalized };
}

function resolveArchitectEditorFile(repoId: string, filePath: string): { repoRoot: string; safePath: string; relativePath: string } {
  return resolveArchitectEditorPath(repoId, filePath);
}

function detectArchitectEditorLanguage(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".py":
      return "python";
    case ".cs":
      return "csharp";
    case ".json":
      return "json";
    case ".md":
      return "markdown";
    case ".css":
      return "css";
    case ".html":
      return "html";
    case ".xml":
      return "xml";
    case ".yaml":
    case ".yml":
      return "yaml";
    default:
      return "plaintext";
  }
}

function isProbablyUnsupportedEditorBuffer(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / sample.length > 0.08;
}

function buildArchitectEditorRevisionToken(repoId: string, relativePath: string, content: string, fileStat: { mtimeMs: number; size: number }): string {
  return createHash("sha256")
    .update(repoId)
    .update("\0")
    .update(relativePath)
    .update("\0")
    .update(String(fileStat.mtimeMs))
    .update("\0")
    .update(String(fileStat.size))
    .update("\0")
    .update(content)
    .digest("hex");
}

function buildArchitectEditorTreeNode(repoId: string, parentPath: string, entryName: string, isDirectory: boolean): Record<string, unknown> {
  const relativePath = normalizeArchitectEditorFilePath(parentPath ? `${parentPath}/${entryName}` : entryName);
  return {
    id: `${repoId}:${relativePath}`,
    repo: repoId,
    name: entryName,
    path: relativePath,
    kind: isDirectory ? "directory" : "file",
    language: isDirectory ? null : detectArchitectEditorLanguage(relativePath),
    lazy: isDirectory,
    hidden: entryName.startsWith("."),
  };
}

async function handleArchitectEditorRepos(req: IncomingMessage, res: ServerResponse): Promise<void> {
  sendJsonWithEtag(req, res, {
    ok: true,
    contract: "architect",
    version: "v1",
    ...buildMeta(),
    editor_surface: {
      source: "daemon_governed_editor_repo_projection",
      direct_browser_filesystem_access: false,
      mutation_authority: "daemon_governed_editor_save",
    },
    repos: buildArchitectEditorRepoProjection(),
  });
}

async function handleArchitectEditorTreeRead(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    jsonError(res, 400, "bad_request", (error as Error).message || "Invalid editor tree payload");
    return;
  }
  const repoId = String(body.repo ?? "").trim();
  const treePath = String(body.path ?? "").trim();
  try {
    const { safePath, relativePath } = resolveArchitectEditorPath(repoId, treePath, { allowRoot: true });
    const directoryStat = await stat(safePath);
    if (!directoryStat.isDirectory()) {
      jsonError(res, 400, "not_directory", "Editor tree path must be a directory");
      return;
    }
    const entries = await readdir(safePath, { withFileTypes: true });
    const nodes = entries
      .filter((entry) => entry.name !== ".git" && entry.name !== "node_modules")
      .slice(0, 500)
      .map((entry) => buildArchitectEditorTreeNode(repoId, relativePath, entry.name, entry.isDirectory()))
      .sort((left, right) => {
        const leftKind = String(left.kind);
        const rightKind = String(right.kind);
        if (leftKind !== rightKind) return leftKind === "directory" ? -1 : 1;
        return String(left.name).localeCompare(String(right.name));
      });
    json(res, 200, {
      ok: true,
      contract: "architect",
      version: "v1",
      ...buildMeta(),
      tree: {
        repo: repoId,
        path: relativePath,
        truncated: entries.length > 500,
        direct_browser_filesystem_access: false,
        children: nodes,
      },
    }, { "Cache-Control": "no-store" });
  } catch (error) {
    jsonError(res, 400, "bad_request", error instanceof Error ? error.message : String(error));
  }
}

async function handleArchitectEditorFileLoad(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    jsonError(res, 400, "bad_request", (error as Error).message || "Invalid editor load payload");
    return;
  }
  const repoId = String(body.repo ?? "").trim();
  const filePath = String(body.file_path ?? "").trim();
  const openAnyway = body.open_anyway === true;
  try {
    const { safePath, relativePath } = resolveArchitectEditorFile(repoId, filePath);
    const fileStat = await stat(safePath);
    if (!fileStat.isFile()) {
      jsonError(res, 400, "not_file", "Editor load path must be a file");
      return;
    }
    const rawContent = await readFile(safePath);
    const unsupported = isProbablyUnsupportedEditorBuffer(rawContent);
    if (unsupported && !openAnyway) {
      json(res, 200, {
        ok: true,
        contract: "architect",
        version: "v1",
        ...buildMeta(),
        file: {
          repo: repoId,
          file_path: relativePath,
          display_name: basename(relativePath),
          language: detectArchitectEditorLanguage(relativePath),
          revision: buildArchitectEditorRevisionToken(repoId, relativePath, "", fileStat),
          size_bytes: fileStat.size,
          mtime_ms: fileStat.mtimeMs,
          content: "",
          unsupported_text_editor: true,
          unsupported_reason: "binary_or_unsupported_text_encoding",
          mutation_authority: "daemon_governed_editor_save",
          direct_browser_filesystem_access: false,
        },
      }, { "Cache-Control": "no-store" });
      return;
    }
    const content = rawContent.toString("utf-8");
    json(res, 200, {
      ok: true,
      contract: "architect",
      version: "v1",
      ...buildMeta(),
      file: {
        repo: repoId,
        file_path: relativePath,
        display_name: basename(relativePath),
        language: detectArchitectEditorLanguage(relativePath),
        revision: buildArchitectEditorRevisionToken(repoId, relativePath, content, fileStat),
        size_bytes: fileStat.size,
        mtime_ms: fileStat.mtimeMs,
        content,
        unsupported_text_editor: unsupported,
        mutation_authority: "daemon_governed_editor_save",
        direct_browser_filesystem_access: false,
      },
    }, { "Cache-Control": "no-store" });
  } catch (error) {
    jsonError(res, 400, "bad_request", error instanceof Error ? error.message : String(error));
  }
}

async function handleArchitectEditorFileSave(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    jsonError(res, 400, "bad_request", (error as Error).message || "Invalid editor save payload");
    return;
  }
  const repoId = String(body.repo ?? "").trim();
  const filePath = String(body.file_path ?? "").trim();
  const content = typeof body.content === "string" ? body.content : null;
  const expectedRevision = typeof body.revision === "string" ? body.revision.trim() : "";
  if (!content && content !== "") {
    jsonError(res, 400, "bad_request", "Editor save payload requires string content");
    return;
  }
  try {
    const { safePath, relativePath } = resolveArchitectEditorFile(repoId, filePath);
    const currentStat = await stat(safePath);
    if (!currentStat.isFile()) {
      jsonError(res, 400, "not_file", "Editor save path must be a file");
      return;
    }
    const currentContent = await readFile(safePath, "utf-8");
    const currentRevision = buildArchitectEditorRevisionToken(repoId, relativePath, currentContent, currentStat);
    if (expectedRevision && expectedRevision !== currentRevision) {
      json(res, 409, {
        ok: false,
        error: "revision_conflict",
        message: "Editor save rejected because the file changed after it was loaded.",
        conflict: {
          repo: repoId,
          file_path: relativePath,
          expected_revision: expectedRevision,
          actual_revision: currentRevision,
          resolution: "reload_required",
          mutation_authority: "daemon_governed_editor_save",
          direct_browser_filesystem_access: false,
        },
      }, { "Cache-Control": "no-store" });
      return;
    }
    await writeFile(safePath, content, "utf-8");
    const savedStat = await stat(safePath);
    const savedRevision = buildArchitectEditorRevisionToken(repoId, relativePath, content, savedStat);
    const scanStartedAt = Date.now();
    let graphSync: Record<string, unknown>;
    try {
      const scanResult = await executeExtractApiSurface({
        path: safePath,
        scope: "all",
        incremental: false,
      });
      const scanData = scanResult.success ? scanResult.data : null;
      const scanEvent = {
        type: "graph.file_scanned",
        repoId,
        filePath: relativePath,
        durationMs: Date.now() - scanStartedAt,
        nodesUpdated: scanData ? Number(scanData.classes_found) + Number(scanData.functions_found) : 0,
        relationshipsUpdated: scanData ? Number(scanData.properties_found) : 0,
        filesScanned: scanData ? Number(scanData.files_scanned) : 0,
        filesUpdated: scanData ? Number(scanData.files_updated) : 0,
        warnings: scanData?.warnings ?? [],
        tool: "executeExtractApiSurface",
        mutation_authority: "daemon_governed_editor_save",
        direct_browser_filesystem_access: false,
      };
      graphSync = {
        mode: "targeted_extract_api_surface",
        tool: "executeExtractApiSurface",
        event: scanEvent,
        result: scanResult,
      };
      publishEvent("graph.file_scanned", scanEvent);
    } catch (error) {
      const scanEvent = {
        type: "graph.file_scan_failed",
        repoId,
        filePath: relativePath,
        durationMs: Date.now() - scanStartedAt,
        nodesUpdated: 0,
        relationshipsUpdated: 0,
        error: error instanceof Error ? error.message : String(error),
        tool: "executeExtractApiSurface",
        mutation_authority: "daemon_governed_editor_save",
        direct_browser_filesystem_access: false,
      };
      graphSync = {
        mode: "targeted_extract_api_surface_failed",
        tool: "executeExtractApiSurface",
        event: scanEvent,
        error: scanEvent.error,
      };
      publishEvent("graph.file_scan_failed", scanEvent);
    }
    const result = {
      repo: repoId,
      file_path: relativePath,
      display_name: basename(relativePath),
      saved: true,
      revision: savedRevision,
      previous_revision: currentRevision,
      graph_sync: graphSync,
      mutation_authority: "daemon_governed_editor_save",
      direct_browser_filesystem_access: false,
    };
    publishEvent("architect.editor_save", result);
    json(res, 200, {
      ok: true,
      contract: "architect",
      version: "v1",
      ...buildMeta(),
      result,
    }, { "Cache-Control": "no-store" });
  } catch (error) {
    jsonError(res, 400, "bad_request", error instanceof Error ? error.message : String(error));
  }
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
    onboarding_readiness: buildOnboardingReadinessProjection(runtime),
    architect_llm: buildArchitectLlmPayload(runtime),
    architect_token_economy: getArchitectTokenEconomyConfig(),
    execution_control: buildArchitectExecutionControlSnapshot(runtime),
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

class ArchitectCliExit extends Error {
  code: number;
  constructor(code: number) {
    super(`Architect CLI exited with code ${code}`);
    this.code = code;
  }
}

async function captureArchitectCliOutput(run: () => Promise<void>): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  console.log = (...args: unknown[]) => {
    stdout.push(args.map((value) => String(value)).join(" "));
  };
  console.error = (...args: unknown[]) => {
    stderr.push(args.map((value) => String(value)).join(" "));
  };
  process.exit = (((code?: number) => {
    throw new ArchitectCliExit(typeof code === "number" ? code : 0);
  }) as unknown) as typeof process.exit;
  try {
    await run();
    return { stdout: stdout.join("\n").trim(), stderr: stderr.join("\n").trim(), exitCode: 0 };
  } catch (error) {
    if (error instanceof ArchitectCliExit) {
      return { stdout: stdout.join("\n").trim(), stderr: stderr.join("\n").trim(), exitCode: error.code };
    }
    throw error;
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  }
}

async function runArchitectGitCommand(args: string[]): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: getArchitectProjectRoot(),
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout.toString().trim();
  } catch (error) {
    const output = error as { message?: string; stderr?: Buffer | string; stdout?: Buffer | string };
    const detail = output.stderr?.toString() || output.stdout?.toString() || output.message || "git command failed";
    throw new Error(detail.trim());
  }
}

function architectStatusString(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function architectStatusNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function formatArchitectStatusPayload(payload: unknown, fallbackInstanceId: string): string {
  const status = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const identity = status.identity && typeof status.identity === "object" ? status.identity as Record<string, unknown> : {};
  const project = status.project && typeof status.project === "object" ? status.project as Record<string, unknown> : {};
  const daemon = status.daemon && typeof status.daemon === "object" ? status.daemon as Record<string, unknown> : {};
  const cognitive = status.cognitive && typeof status.cognitive === "object" ? status.cognitive as Record<string, unknown> : {};
  const uuid = architectStatusString(identity.uuid, fallbackInstanceId);
  const name = architectStatusString(identity.name, "unnamed");
  const running = typeof daemon.running === "boolean" ? daemon.running : null;
  const crashed = daemon.crashed === true;
  const daemonState = crashed ? "crashed" : running === true ? "running" : running === false ? "stopped" : "unknown";
  const pid = architectStatusNumber(daemon.pid);
  const port = architectStatusNumber(daemon.port);
  const uptimeMs = architectStatusNumber(daemon.uptime_ms);
  const uptime = uptimeMs == null ? "unknown" : `${Math.floor(uptimeMs / 1000)}s`;
  const lines = [
    "DreamGraph status",
    `Instance: ${name} (${uuid})`,
    `Instance status: ${architectStatusString(identity.status)}`,
    `Mode: ${architectStatusString(identity.mode)} | Policy: ${architectStatusString(identity.policy)}`,
    `Project: ${architectStatusString(project.root, "not attached")}`,
    `Daemon: ${daemonState}${pid == null ? "" : `, pid ${pid}`}${port == null ? "" : `, port ${port}`}, uptime ${uptime}`,
    `Cognitive: ${architectStatusNumber(cognitive.graph_nodes) ?? 0} nodes, ${architectStatusNumber(cognitive.graph_edges) ?? 0} edges, ${architectStatusNumber(cognitive.candidate_edges) ?? 0} candidate edges, ${architectStatusNumber(cognitive.validated_edges) ?? 0} validated edges, ${architectStatusNumber(cognitive.tensions) ?? 0} tensions, ${architectStatusNumber(cognitive.adr_decisions) ?? 0} ADR decisions, ${architectStatusNumber(cognitive.ui_elements) ?? 0} UI elements`,
    `Activity: ${architectStatusNumber(cognitive.dream_cycles) ?? 0} dream cycles, ${architectStatusNumber(cognitive.tool_calls) ?? 0} tool calls`,
  ];
  return lines.join("\n");
}

function architectStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function pluginSummary(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function formatArchitectPluginListPayload(payload: unknown): string {
  const plugins = Array.isArray(payload) ? payload.map(pluginSummary) : [];
  if (plugins.length === 0) return "No plugins discovered.";
  const lines = [`Discovered ${plugins.length} plugin${plugins.length === 1 ? "" : "s"}`];
  for (const plugin of plugins) {
    const id = architectStatusString(plugin.id, "unknown-plugin");
    const version = architectStatusString(plugin.version, "unknown-version");
    const enabled = plugin.enabled === false ? "disabled" : "enabled";
    const trusted = plugin.trusted === true ? "trusted" : "untrusted";
    const capabilities = architectStringList(plugin.capabilities);
    lines.push(`- ${id}@${version} (${enabled}, ${trusted})`);
    lines.push(`  Capabilities: ${capabilities.length ? capabilities.join(", ") : "none"}`);
  }
  return lines.join("\n");
}

export function formatArchitectPluginInspectPayload(payload: unknown, fallbackPluginId: string): string {
  const plugin = pluginSummary(payload);
  const manifest = plugin.manifest && typeof plugin.manifest === "object" ? plugin.manifest as Record<string, unknown> : {};
  const id = architectStatusString(plugin.id ?? manifest.id, fallbackPluginId);
  const version = architectStatusString(plugin.version ?? manifest.version, "unknown-version");
  const enabled = plugin.enabled === false ? "disabled" : "enabled";
  const trusted = plugin.trusted === true ? "trusted" : "untrusted";
  const capabilities = architectStringList(manifest.capabilities ?? plugin.capabilities);
  const lines = [
    `Plugin ${id}@${version}`,
    `State: ${enabled}, ${trusted}`,
    `Capabilities: ${capabilities.length ? capabilities.join(", ") : "none"}`,
  ];
  const source = architectStatusString(plugin.manifest_source, "");
  if (source) lines.push(`Manifest: ${source}`);
  const description = architectStatusString(manifest.description ?? manifest.intent, "");
  if (description) lines.push(`Description: ${description}`);
  return lines.join("\n");
}

function formatArchitectPluginActionPayload(subcommand: string, pluginId: string, parsed: unknown): string {
  const result = pluginSummary(parsed);
  if (result.success === false || result.ok === false) {
    const detail = architectStatusString(result.error ?? result.message, "Plugin command failed.");
    return `Plugin ${subcommand} failed for ${pluginId}: ${detail}`;
  }
  const verbs: Record<string, string> = {
    enable: "enabled",
    disable: "disabled",
    trust: "trusted",
    untrust: "untrusted",
    reload: "reloaded",
    unload: "unloaded",
  };
  const suffix = subcommand === "enable" || subcommand === "disable" || subcommand === "trust" || subcommand === "untrust"
    ? " Restart the daemon for this configuration change to take effect."
    : "";
  return `Plugin ${pluginId} ${verbs[subcommand] ?? "updated"}.${suffix}`;
}

function currentPlanSelectionLabel(planId: string | null): string {
  return planId ? `selected: ${planId}` : "Project Scope; no plan selected";
}

function planLifecycle(plan: ArchitectPlanSummary | ArchitectPlanDetail): string {
  return architectStatusString(plan.operational_state?.plan_lifecycle ?? plan.status, "unknown");
}

function planActiveSlice(plan: ArchitectPlanSummary | ArchitectPlanDetail): string {
  return architectStatusString(
    plan.operational_state?.active_slice?.title ?? plan.operational_state?.current_slice_title ?? plan.operational_state?.current_slice_id,
    "none",
  );
}

function formatPlanSummaryLine(plan: ArchitectPlanSummary | ArchitectPlanDetail, selectedPlanId: string | null): string {
  const marker = plan.id === selectedPlanId ? "*" : "-";
  const next = architectStatusString(plan.operational_state?.next_slice?.title ?? plan.operational_state?.next_slice?.id, "none");
  return `${marker} ${plan.id} - ${plan.title} (${planLifecycle(plan)}; active ${planActiveSlice(plan)}; next ${next})`;
}

export function formatArchitectPlanListPayload(plans: ArchitectPlanSummary[], selectedPlanId: string | null): string {
  if (plans.length === 0) return `No Architect plans found. ${currentPlanSelectionLabel(selectedPlanId)}.`;
  return [
    `Architect plans (${plans.length}); ${currentPlanSelectionLabel(selectedPlanId)}`,
    ...plans.map((plan) => formatPlanSummaryLine(plan, selectedPlanId)),
  ].join("\n");
}

export function formatArchitectPlanStatusPayload(plan: ArchitectPlanDetail | null, selectedPlanId: string | null): string {
  if (!plan) return "No Architect plan is selected. Use /plan list or /plan new <name>, or stay in Project Scope with /plan clear.";
  const operational = plan.operational_state ?? {};
  const lines = [
    `Plan ${plan.title} (${plan.id})`,
    `Lifecycle: ${planLifecycle(plan)} | execution: ${architectStatusString(operational.execution_state, "idle")}`,
    `Phase: ${architectStatusString(operational.active_phase ?? operational.phase ?? plan.active_phase, "unknown")}`,
    `Active slice: ${planActiveSlice(plan)}`,
    `Last completed: ${architectStatusString(operational.last_completed_slice?.title ?? operational.last_completed_slice?.id, "none")}`,
    `Next slice: ${architectStatusString(operational.next_slice?.title ?? operational.next_slice?.id, "none")}`,
    `Checkpoints: ${plan.checkpoint_count ?? 0}; ADR bindings: ${(plan.adr_bindings ?? []).join(", ") || "none"}`,
    `Resume: ${operational.resume_hint ?? plan.resume_state?.last_resume_note ?? "none"}`,
  ];
  return lines.join("\n");
}

export function formatArchitectPlanNextPayload(plan: ArchitectPlanDetail | null): string {
  if (!plan) return "No Architect plan is selected. Select a plan before using /plan next.";
  const next = plan.operational_state?.next_slice;
  if (!next) return `Plan ${plan.id} has no projected next slice.`;
  return `Next slice for ${plan.id}: ${architectStatusString(next.title ?? next.id, "unknown")} (${architectStatusString(next.status, "pending")})`;
}

function planSearchScore(plan: ArchitectPlanSummary, query: string): number {
  const haystack = [plan.id, plan.title, plan.status, plan.active_phase, plan.operational_state?.current_slice_title, plan.operational_state?.next_slice?.title]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const normalized = query.toLowerCase();
  if (plan.id.toLowerCase() === normalized) return 100;
  if (plan.id.toLowerCase().includes(normalized)) return 80;
  if (plan.title.toLowerCase().includes(normalized)) return 70;
  return haystack.includes(normalized) ? 40 : 0;
}

function parseArchitectJsonOutput(raw: string, failureMessage: string): unknown {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error(failureMessage);
  }
}

async function listArchitectPlanSummaries(): Promise<ArchitectPlanSummary[]> {
  return await Promise.all((await listArchitectPlanFiles()).map((fileName) => buildArchitectPlanSummary(fileName)));
}

async function selectArchitectPlanForCommand(planId: string | null): Promise<Record<string, unknown>> {
  if (planId) {
    const plan = await loadArchitectPlanDetail(planId);
    if (!plan) throw new Error(`No Architect plan with id: ${planId}`);
    const selection = persistArchitectSelectedPlanId(planId);
    return { selected_plan_id: planId, selected_plan_title: plan.title, persisted: selection.persisted, engine_env_path: selection.engineEnvPath };
  }
  const selection = persistArchitectSelectedPlanId(null);
  return { selected_plan_id: null, selected_plan_title: null, persisted: selection.persisted, engine_env_path: selection.engineEnvPath };
}

async function createArchitectPlanForCommand(name: string): Promise<{ plan: ArchitectPlanSummary; result: Record<string, unknown> }> {
  const title = normalizePlanTitle(name);
  const baseId = slugifyPlanId(title);
  const planId = await pickAvailablePlanId(baseId);
  const timestamp = new Date().toISOString();
  const plansRoot = getArchitectPlansRoot();
  await mkdir(plansRoot, { recursive: true });
  await writeFile(resolve(plansRoot, `${planId}.md`), buildCreatedPlanMarkdown(planId, title, timestamp), { encoding: "utf-8", flag: "wx" });
  await writeFile(resolve(plansRoot, `${planId}.implementation-log.md`), buildCreatedPlanLog(planId, title, timestamp), { encoding: "utf-8", flag: "wx" });
  const plan = await buildArchitectPlanSummary(`${planId}.md`);
  const selection = await selectArchitectPlanForCommand(planId);
  const result = {
    plan_id: planId,
    title,
    status: "created",
    changed: true,
    plan_path: `plans/${planId}.md`,
    log_path: `plans/${planId}.implementation-log.md`,
    audit_scope: "daemon_governed_plan_create",
    ...selection,
  };
  publishEvent("architect.plan_action", result);
  return { plan, result };
}

function handleArchitectExecutionControlCommand(action: ArchitectExecutionControlAction, prompt: string | null = null): { content: string; structured: Record<string, unknown> } {
  const runtime = buildActiveArchitectSessionRuntime();
  const capabilities = runtime.execution_controls;
  const current = activeArchitectExecutionControl;
  if (action === "stop") {
    if (!capabilities.stop) throw new Error("/stop is not supported by the current Architect runtime.");
    if (!current || current.state !== "running") {
      return {
        content: "No Architect task is currently running.",
        structured: buildArchitectExecutionControlPayload(runtime),
      };
    }
    current.state = "cancelled";
    current.last_action_at = new Date().toISOString();
    current.controller.abort();
    const passState = updateActiveArchitectPassState({ status: "cancelled" });
    const nextRuntime = buildActiveArchitectSessionRuntime({ pass_state: passState });
    const structured = buildArchitectExecutionControlPayload(nextRuntime);
    publishEvent("architect.execution_control", { action, ...structured });
    return { content: "Stop requested for the running Architect task. The daemon will return to idle after the active bridge exits.", structured };
  }
  if (action === "pause") {
    if (!capabilities.pause) throw new Error("/pause is not supported by the current Architect runtime.");
    if (!current || current.state !== "running") throw new Error("No running Architect task is available to pause.");
    current.state = "paused";
    current.last_action_at = new Date().toISOString();
    const passState = updateActiveArchitectPassState({ status: "paused" });
    const nextRuntime = buildActiveArchitectSessionRuntime({ pass_state: passState });
    const structured = buildArchitectExecutionControlPayload(nextRuntime);
    publishEvent("architect.execution_control", { action, ...structured });
    return { content: "Architect task paused.", structured };
  }
  if (action === "resume") {
    if (!capabilities.resume) throw new Error("/resume is not supported by the current Architect runtime.");
    if (!current || current.state !== "paused") throw new Error("No paused Architect task is available to resume.");
    current.state = "running";
    current.last_action_at = new Date().toISOString();
    const passState = updateActiveArchitectPassState({ status: "running" });
    const nextRuntime = buildActiveArchitectSessionRuntime({ pass_state: passState });
    const structured = buildArchitectExecutionControlPayload(nextRuntime);
    publishEvent("architect.execution_control", { action, ...structured });
    return { content: "Architect task resumed.", structured };
  }
  if (!capabilities.steering) throw new Error("Steering prompts are not supported by the current Architect runtime.");
  if (!current || current.state !== "running") throw new Error("No running Architect task is available for steering.");
  current.steering_prompts.push({ prompt: prompt ?? "", received_at: new Date().toISOString() });
  current.last_action_at = new Date().toISOString();
  const structured = buildArchitectExecutionControlPayload(runtime);
  publishEvent("architect.execution_control", { action, prompt_length: prompt?.length ?? 0, ...structured });
  return { content: "Steering prompt accepted for the running Architect task.", structured };
}

async function archiveArchitectPlanForCommand(planId: string): Promise<Record<string, unknown>> {
  const detail = await loadArchitectPlanDetail(planId);
  if (!detail) throw new Error(`No Architect plan with id: ${planId}`);
  const audit = await recordPlanActionAudit(planId, {
    kind: "plan_action",
    action: "archive_plan",
    audit_reason: `Operator archived Architect plan ${planId} from /plan archive.`,
    actor: "standalone-architect-browser",
    slice_id: "slice-4-plan-management-slash-commands",
    evidence: detail.path,
    content: "architect archived this plan through a daemon-governed slash command.",
  });
  if (!audit) throw new Error(`No Architect plan with id: ${planId}`);
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
  const selection = await selectArchitectPlanForCommand(null);
  const result = {
    plan_id: planId,
    title: detail.title,
    status: "archived",
    changed: true,
    audit_id: audit.audit_id,
    archived_path: `plans/archive/${archivedPlanFileName}`,
    archived_log_path: archivedLogPath,
    audit_scope: "daemon_governed_plan_archive",
    ...selection,
  };
  publishEvent("architect.plan_action", result);
  return result;
}

async function handleArchitectCommandRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const message = (error as Error).message;
    if (message === "body_too_large") {
      jsonError(res, 413, "body_too_large", "Architect command payload is too large");
      return;
    }
    jsonError(res, 400, "bad_json", "Expected a JSON object request body");
    return;
  }

  const command = textField(body, "command")?.trim().toLowerCase();
  const args = Array.isArray(body.args) ? body.args.map((value) => String(value)).filter(Boolean) : [];
  const instanceId = getInstanceId();
  if (!command) {
    jsonError(res, 400, "bad_request", "Missing command");
    return;
  }

  try {
    let title = command;
    let invoked = "";
    let content = "";
    let structured: unknown = null;

    if (command === "status") {
      if (!instanceId) throw new Error("/status requires a bound DreamGraph instance.");
      const captured = await captureArchitectCliOutput(async () => {
        await cmdStatus([instanceId], { json: true });
      });
      if (captured.exitCode !== 0) throw new Error(captured.stderr || captured.stdout || "Unable to read instance status.");
      invoked = `dg status ${instanceId} --json`;
      title = `Status ${instanceId}`;
      try {
        structured = captured.stdout ? JSON.parse(captured.stdout) : {};
      } catch {
        throw new Error("Status response was not valid JSON.");
      }
      content = formatArchitectStatusPayload(structured, instanceId);
    } else if (command === "restart") {
      if (!instanceId) throw new Error("/restart requires a bound DreamGraph instance.");
      const captured = await captureArchitectCliOutput(async () => {
        await cmdRestart([instanceId], {});
      });
      if (captured.exitCode !== 0) throw new Error(captured.stderr || captured.stdout || "dg restart failed");
      invoked = `dg restart ${instanceId}`;
      title = `Restart ${instanceId}`;
      content = captured.stdout || "Restart requested.";
    } else if (command === "plugin") {
      const subcommand = String(args[0] || "").trim().toLowerCase();
      const pluginId = String(args[1] || "").trim();
      const allowed = new Set(["list", "inspect", "enable", "disable", "trust", "untrust", "reload", "unload"]);
      if (!allowed.has(subcommand)) throw new Error("Usage: /plugin <list|inspect|enable|disable|trust|untrust|reload|unload> [plugin-id]");
      if (subcommand !== "list" && !pluginId) throw new Error(`Usage: /plugin ${subcommand} <plugin-id>`);
      if (!instanceId) throw new Error("/plugin requires a bound DreamGraph instance.");
      const positional = [subcommand, instanceId];
      if (pluginId) positional.push(pluginId);
      const flags: ParsedArgs["flags"] =
        subcommand === "list" || subcommand === "inspect" ? { json: true } : {};
      const captured = await captureArchitectCliOutput(async () => {
        await cmdPlugin(positional, flags);
      });
      if (captured.exitCode !== 0) throw new Error(captured.stderr || captured.stdout || `Plugin ${subcommand} failed.`);
      invoked = `dg plugin ${subcommand} ${instanceId}${pluginId ? ` ${pluginId}` : ""}`;
      title = `Plugin ${subcommand}`;
      const raw = captured.stdout || captured.stderr || "";
      if (subcommand === "list") {
        structured = parseArchitectJsonOutput(raw, "Plugin list response was not valid JSON.");
        content = formatArchitectPluginListPayload(structured);
      } else if (subcommand === "inspect") {
        structured = parseArchitectJsonOutput(raw, "Plugin inspect response was not valid JSON.");
        content = formatArchitectPluginInspectPayload(structured, pluginId);
      } else {
        structured = raw.trim().startsWith("{") || raw.trim().startsWith("[") ? parseArchitectJsonOutput(raw, "Plugin action response was not valid JSON.") : null;
        content = formatArchitectPluginActionPayload(subcommand, pluginId, structured);
      }
    } else if (command === "stop" || command === "pause" || command === "resume") {
      invoked = `/${command}`;
      title = `Execution ${command}`;
      const control = handleArchitectExecutionControlCommand(command);
      structured = control.structured;
      content = control.content;
    } else if (command === "steer") {
      invoked = "/steer";
      title = "Execution steering";
      const control = handleArchitectExecutionControlCommand("steer", args.join(" ").trim());
      structured = control.structured;
      content = control.content;
    } else if (command === "plan") {
      const subcommand = String(args[0] || "").trim().toLowerCase();
      const selectedPlanId = getArchitectSelectedPlanConfig().planId;
      const allowed = new Set(["new", "archive", "list", "search", "status", "next", "clear"]);
      if (!allowed.has(subcommand)) throw new Error("Usage: /plan <new|archive|list|search|status|next|clear>");
      invoked = `/plan ${subcommand}`;
      title = `Plan ${subcommand}`;
      if (subcommand === "new") {
        const name = args.slice(1).join(" ").trim();
        if (!name) throw new Error("Usage: /plan new <name>");
        const created = await createArchitectPlanForCommand(name);
        structured = created.result;
        content = `Created and selected plan ${created.plan.title} (${created.plan.id}).`;
      } else if (subcommand === "archive") {
        if (!selectedPlanId) throw new Error("No Architect plan is selected. Select a plan before using /plan archive.");
        structured = await archiveArchitectPlanForCommand(selectedPlanId);
        content = `Archived plan ${selectedPlanId}. Architect is now in Project Scope with no plan selected.`;
      } else if (subcommand === "list") {
        const plans = await listArchitectPlanSummaries();
        structured = { plans, selected_plan_id: selectedPlanId };
        content = formatArchitectPlanListPayload(plans, selectedPlanId);
      } else if (subcommand === "search") {
        const query = args.slice(1).join(" ").trim();
        if (!query) throw new Error("Usage: /plan search <query>");
        const plans = (await listArchitectPlanSummaries())
          .map((plan) => ({ plan, score: planSearchScore(plan, query) }))
          .filter((entry) => entry.score > 0)
          .sort((left, right) => right.score - left.score || left.plan.title.localeCompare(right.plan.title))
          .map((entry) => entry.plan);
        structured = { query, plans, selected_plan_id: selectedPlanId };
        content = plans.length ? formatArchitectPlanListPayload(plans, selectedPlanId) : `No Architect plans matched "${query}".`;
      } else if (subcommand === "status") {
        const plan = selectedPlanId ? await loadArchitectPlanDetail(selectedPlanId) : null;
        structured = { plan, selected_plan_id: selectedPlanId };
        content = formatArchitectPlanStatusPayload(plan, selectedPlanId);
      } else if (subcommand === "next") {
        const plan = selectedPlanId ? await loadArchitectPlanDetail(selectedPlanId) : null;
        structured = { next_slice: plan?.operational_state?.next_slice ?? null, selected_plan_id: selectedPlanId };
        content = formatArchitectPlanNextPayload(plan);
      } else if (subcommand === "clear") {
        structured = await selectArchitectPlanForCommand(null);
        content = "Cleared plan selection. Architect is now in Project Scope.";
      }
    } else if (command === "git") {
      const subcommand = String(args[0] || "").trim().toLowerCase();
      const remainder = args.slice(1);
      if (subcommand === "status") {
        invoked = "git status --short --branch";
        title = "Git status";
        content = await runArchitectGitCommand(["status", "--short", "--branch"]);
      } else if (subcommand === "diff") {
        invoked = "git diff --stat --patch --";
        title = "Git diff";
        content = (await runArchitectGitCommand(["diff", "--stat", "--patch", "--"])) || "No diff.";
      } else if (subcommand === "branch") {
        invoked = "git branch --show-current";
        title = "Git branch";
        content = await runArchitectGitCommand(["branch", "--show-current"]);
      } else if (subcommand === "log") {
        invoked = "git log --oneline -10";
        title = "Git log";
        content = await runArchitectGitCommand(["log", "--oneline", "-10"]);
      } else if (subcommand === "commit") {
        const message = remainder.join(" ").trim();
        if (!message) throw new Error("Usage: /git commit <message>");
        invoked = `git commit -m ${JSON.stringify(message)}`;
        title = "Git commit";
        content = await runArchitectGitCommand(["commit", "-m", message]);
      } else {
        throw new Error("Usage: /git <status|diff|branch|log|commit>");
      }
    } else {
      jsonError(res, 400, "bad_request", `Unsupported command: ${command}`);
      return;
    }

    json(res, 200, {
      ok: true,
      contract: "architect",
      version: "v1",
      ...buildMeta(),
      result: {
        success: true,
        command,
        args,
        title,
        content,
        formatted_payload: content,
        structured,
        diagnostics: {
          active_instance_id: instanceId ?? null,
          invoked,
          raw_detail_available: Boolean(invoked || structured),
        },
        raw_detail: null,
      },
    }, { "Cache-Control": "no-store" });
  } catch (error) {
    jsonError(res, 400, "command_failed", String(error instanceof Error ? error.message : error));
  }
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

function parseArchitectPluginTabSubroute(pathname: string): { tabTypeId: string; suffix: string | null } | null {
  const base = "/api/architect/v1/plugin-tabs/";
  if (!pathname.startsWith(base)) return null;
  const remainder = pathname.slice(base.length);
  if (!remainder) return { tabTypeId: "", suffix: null };
  const [encodedTabTypeId, ...rest] = remainder.split("/");
  return { tabTypeId: decodeURIComponent(encodedTabTypeId), suffix: rest.length > 0 ? rest.join("/") : null };
}

function architectPluginTabError(res: ServerResponse, error: unknown): void {
  if (error instanceof ArchitectContributionError || error instanceof ArchitectPlanStateError) {
    const status = error.code === "architect_plan_required" || error.code === "architect_action_schema_invalid" ? 400
      : error.code === "architect_revision_stale" ? 409
      : 404;
    jsonError(res, status, error.code, error.message);
    return;
  }
  throw error;
}

async function handleArchitectPluginTabsIndex(req: IncomingMessage, res: ServerResponse): Promise<void> {
  sendJsonWithEtag(req, res, { ok: true, tabs: listArchitectTabs(), runtime: { trustedHostExecution: true, browserModulesEmbedded: false } });
}

async function handleArchitectPluginTabSnapshot(req: IncomingMessage, res: ServerResponse, tabTypeId: string): Promise<void> {
  try {
    const planId = new URL(req.url ?? "", "http://127.0.0.1").searchParams.get("planId");
    sendJsonWithEtag(req, res, { ok: true, snapshot: await loadArchitectTabSnapshot(tabTypeId, planId) });
  } catch (error) {
    architectPluginTabError(res, error);
  }
}

async function handleArchitectPluginTabAction(req: IncomingMessage, res: ServerResponse, tabTypeId: string): Promise<void> {
  try {
    const body = await readJsonBody(req);
    const planId = typeof body.planId === "string" ? body.planId : null;
    const revision = typeof body.revision === "string" ? body.revision : null;
    if (!body.action || typeof body.action !== "object" || Array.isArray(body.action)) {
      jsonError(res, 400, "architect_action_schema_invalid", "Action payload must be an object");
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify({ ok: true, snapshot: await dispatchArchitectTabAction(tabTypeId, planId, body.action, revision) }));
  } catch (error) {
    architectPluginTabError(res, error);
  }
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

function parseArchitectTerminalSubroute(pathname: string): { terminalId: string; suffix: string | null } | null {
  const base = "/api/architect/v1/terminals/";
  if (!pathname.startsWith(base)) return null;
  const remainder = pathname.slice(base.length);
  if (!remainder) return { terminalId: "", suffix: null };
  const [encodedTerminalId, ...rest] = remainder.split("/");
  return {
    terminalId: decodeURIComponent(encodedTerminalId),
    suffix: rest.length > 0 ? rest.join("/") : null,
  };
}

function parseArchitectTerminalSocketRoute(pathname: string): { terminalId: string } | null {
  const base = "/api/architect/v1/terminal/";
  if (!pathname.startsWith(base)) return null;
  const remainder = pathname.slice(base.length);
  if (!remainder || remainder.includes("/")) return { terminalId: "" };
  return { terminalId: decodeURIComponent(remainder) };
}

async function readJsonBody(req: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maxBytes) {
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

function optionalRawTextField(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  return typeof value === "string" ? value : null;
}

function boundedTextField(body: Record<string, unknown>, field: string, maxLength: number): string | null {
  const value = optionalTextField(body, field);
  if (!value) return null;
  return value.slice(0, maxLength);
}

function boundedRawTextField(body: Record<string, unknown>, field: string, maxLength: number): string | null {
  const value = optionalRawTextField(body, field);
  if (value == null || value.length === 0) return null;
  return value.slice(0, maxLength);
}

function architectTempAttachmentDir(): string {
  const scope = getActiveScope();
  if (!scope) throw new Error("Architect attachment uploads require a bound DreamGraph instance.");
  return resolve(scope.runtimeDir, "temp");
}

function safeAttachmentFilename(name: string, fallbackExt: string): string {
  const base = basename(name || "attachment").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  const ext = extname(base) || fallbackExt;
  const stem = extname(base) ? base.slice(0, -ext.length) : base;
  return `${Date.now()}-${randomUUID()}-${stem || "attachment"}${ext}`;
}

async function gcArchitectTempAttachments(now = Date.now()): Promise<void> {
  const dir = architectTempAttachmentDir();
  if (!existsSync(dir)) return;
  const entries = await readdir(dir, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile()) return;
    const filePath = resolve(dir, entry.name);
    if (relative(dir, filePath).startsWith("..")) return;
    const info = await stat(filePath).catch(() => null);
    if (info && now - info.mtimeMs > ARCHITECT_ATTACHMENT_GC_AGE_MS) {
      await rm(filePath, { force: true });
    }
  }));
}

function decodeAttachmentBase64(data: string): Buffer {
  const comma = data.indexOf(",");
  const payload = comma >= 0 ? data.slice(comma + 1) : data;
  return Buffer.from(payload, "base64");
}

async function handleArchitectAttachmentUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req, MAX_ATTACHMENT_UPLOAD_BODY_BYTES);
  } catch (error) {
    const message = (error as Error).message;
    jsonError(res, message === "body_too_large" ? 413 : 400, message === "body_too_large" ? "body_too_large" : "bad_json", message === "body_too_large" ? "Attachment payload is too large" : "Expected a JSON object request body");
    return;
  }

  const name = textField(body, "name") ?? "attachment";
  const mimeType = textField(body, "mimeType") ?? textField(body, "mime_type") ?? "application/octet-stream";
  const dataBase64 = optionalRawTextField(body, "dataBase64") ?? optionalRawTextField(body, "data_base64");
  if (!dataBase64) {
    jsonError(res, 400, "bad_request", "Missing attachment data");
    return;
  }
  const buffer = decodeAttachmentBase64(dataBase64);
  if (buffer.length > MAX_ARCHITECT_ATTACHMENT_BYTES) {
    jsonError(res, 413, "attachment_too_large", "Attachment exceeds 5 MB limit");
    return;
  }

  const fallbackExt = mimeType === "image/jpeg" ? ".jpg" : mimeType === "image/webp" ? ".webp" : mimeType === "image/png" ? ".png" : ".bin";
  const dir = architectTempAttachmentDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await gcArchitectTempAttachments();
  const filePath = resolve(dir, safeAttachmentFilename(name, fallbackExt));
  await writeFile(filePath, buffer, { mode: 0o600 });
  json(res, 201, {
    success: true,
    attachment: {
      name,
      mime_type: mimeType,
      size: buffer.length,
      file_path: filePath,
      gc: { ttl_ms: ARCHITECT_ATTACHMENT_GC_AGE_MS },
    },
  }, { "Cache-Control": "no-store" });
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

function normalizeArchitectModelForAdapter(adapter: ArchitectAdapterType, model: string): string {
  const normalized = model.trim();
  if ((adapter === "codex-cli" || adapter === "copilot-cli") && normalized === "qwen3:8b") return "auto";
  return normalized;
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

function buildArchitectTerminalSnapshot(session: ArchitectTerminalSession): Record<string, unknown> {
  return {
    id: session.id,
    title: session.title,
    cwd: session.cwd,
    shell: session.shell,
    cols: session.cols,
    rows: session.rows,
    connection_state: session.connection_state,
    created_at: session.created_at,
    updated_at: session.updated_at,
    closed_at: session.closed_at,
    exit_code: session.exit_code,
    state: session.closed_at ? "closed" : "running",
    authority: {
      surface: "local_terminal_convenience",
      payload_authority: false,
      repository_authority: "dreamgraph_mcp",
      adr_binding: "ADR-222",
    },
  };
}

function sendArchitectTerminalSocketMessage(socket: WebSocket, payload: Record<string, unknown>): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function broadcastArchitectTerminalSocketMessage(session: ArchitectTerminalSession, payload: Record<string, unknown>): void {
  for (const socket of session.sockets) sendArchitectTerminalSocketMessage(socket, payload);
}

function emitArchitectTerminalEvent(session: ArchitectTerminalSession, eventName: string, payload: unknown): void {
  for (const subscriber of session.subscribers) subscriber(eventName, payload);
}

function emitArchitectTerminalData(session: ArchitectTerminalSession, data: string): void {
  emitArchitectTerminalEvent(session, "terminal_output", { id: session.id, stream: "pty", text: data, updated_at: session.updated_at });
  broadcastArchitectTerminalSocketMessage(session, { type: "data", data });
}

function emitArchitectTerminalError(session: ArchitectTerminalSession, message: string): void {
  emitArchitectTerminalEvent(session, "terminal_output", { id: session.id, stream: "error", text: message, updated_at: session.updated_at });
  broadcastArchitectTerminalSocketMessage(session, { type: "error", message });
}

function resolveArchitectTerminalShellCommand(): { command: string; args: string[]; shell: string } {
  if (process.platform === "win32") {
    return { command: "powershell.exe", args: ["-NoLogo"], shell: "PowerShell" };
  }
  const command = process.env.SHELL || "bash";
  return { command, args: ["-i"], shell: command.endsWith("bash") ? "bash" : command };
}

function markArchitectTerminalClosed(session: ArchitectTerminalSession, exitCode: number | null): void {
  if (!session.closed_at) {
    session.closed_at = new Date().toISOString();
    session.updated_at = session.closed_at;
    session.exit_code = exitCode;
  }
  session.connection_state = "detached";
}

function closeArchitectTerminalSockets(session: ArchitectTerminalSession): void {
  const snapshot = buildArchitectTerminalSnapshot(session);
  for (const socket of session.sockets) {
    sendArchitectTerminalSocketMessage(socket, { type: "exit", terminal: snapshot });
    socket.close(1000, "terminal closed");
  }
  session.sockets.clear();
}

function createArchitectTerminalSession(title: string | null): ArchitectTerminalSession {
  architectTerminalSequence += 1;
  const id = `terminal-${architectTerminalSequence}`;
  const cwd = getArchitectProjectRoot();
  const shellPlan = resolveArchitectTerminalShellCommand();
  const cols = 120;
  const rows = 30;
  const now = new Date().toISOString();
  const term = pty.spawn(shellPlan.command, shellPlan.args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: { ...process.env, TERM: process.env.TERM || "xterm-256color" },
  });
  const session: ArchitectTerminalSession = {
    id,
    title: title || `Terminal ${architectTerminalSequence}`,
    process: term,
    cwd,
    shell: shellPlan.shell,
    cols,
    rows,
    connection_state: "detached",
    created_at: now,
    updated_at: now,
    closed_at: null,
    exit_code: null,
    output: [],
    sockets: new Set(),
    subscribers: new Set(),
    cleanup_started: false,
  };
  term.onData((text) => {
    session.output.push(text);
    if (session.output.length > 500) session.output.splice(0, session.output.length - 500);
    session.updated_at = new Date().toISOString();
    emitArchitectTerminalData(session, text);
  });
  term.onExit((event) => {
    markArchitectTerminalClosed(session, event.exitCode);
    emitArchitectTerminalEvent(session, "terminal_exit", buildArchitectTerminalSnapshot(session));
    closeArchitectTerminalSockets(session);
  });
  architectTerminalSessions.set(id, session);
  return session;
}

function closeArchitectTerminalSession(session: ArchitectTerminalSession): void {
  const shouldKillProcess = !session.closed_at;
  if (!session.cleanup_started) {
    session.cleanup_started = true;
    markArchitectTerminalClosed(session, session.exit_code);
  }
  emitArchitectTerminalEvent(session, "terminal_exit", buildArchitectTerminalSnapshot(session));
  closeArchitectTerminalSockets(session);
  architectTerminalSessions.delete(session.id);

  if (shouldKillProcess) {
    const cleanupTimer = setTimeout(() => {
      try {
        session.process.kill();
      } catch (error) {
        const text = `Terminal cleanup failed: ${(error as Error).message}\n`;
        session.output.push(text);
        session.updated_at = new Date().toISOString();
        emitArchitectTerminalError(session, text);
      }
    }, 0);
    cleanupTimer.unref?.();
  }
}

function closeAllArchitectTerminalSessions(): void {
  for (const session of [...architectTerminalSessions.values()]) closeArchitectTerminalSession(session);
}

async function handleArchitectTerminalCreateRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    jsonError(res, 400, "bad_request", (error as Error).message);
    return;
  }
  try {
    const session = createArchitectTerminalSession(boundedTextField(body, "title", 80));
    json(res, 200, { ok: true, contract: "architect", version: "v1", terminal: buildArchitectTerminalSnapshot(session) }, { "Cache-Control": "no-store" });
  } catch (error) {
    jsonError(res, 500, "terminal_spawn_failed", `Terminal failed to start: ${(error as Error).message}`);
  }
}

async function handleArchitectTerminalInputRequest(_req: IncomingMessage, res: ServerResponse, terminalId: string): Promise<void> {
  const session = architectTerminalSessions.get(terminalId);
  if (!session) {
    jsonError(res, 404, "not_found", "Terminal session not found");
    return;
  }
  json(res, 410, {
    ok: false,
    error: "terminal_websocket_required",
    message: "Interactive terminal input is carried by WebSocket /api/architect/v1/terminal/:id.",
    websocket_path: `/api/architect/v1/terminal/${encodeURIComponent(session.id)}`,
    terminal: buildArchitectTerminalSnapshot(session),
  }, { "Cache-Control": "no-store" });
}

async function handleArchitectTerminalRenameRequest(req: IncomingMessage, res: ServerResponse, terminalId: string): Promise<void> {
  const session = architectTerminalSessions.get(terminalId);
  if (!session) {
    jsonError(res, 404, "not_found", "Terminal session not found");
    return;
  }
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    jsonError(res, 400, "bad_request", (error as Error).message);
    return;
  }
  const title = boundedTextField(body, "title", 80);
  if (!title) {
    jsonError(res, 400, "bad_request", "Terminal title is required");
    return;
  }
  session.title = title;
  session.updated_at = new Date().toISOString();
  emitArchitectTerminalEvent(session, "terminal_rename", buildArchitectTerminalSnapshot(session));
  json(res, 200, { ok: true, terminal: buildArchitectTerminalSnapshot(session) }, { "Cache-Control": "no-store" });
}

function handleArchitectTerminalEvents(req: IncomingMessage, res: ServerResponse, terminalId: string): void {
  const session = architectTerminalSessions.get(terminalId);
  if (!session) {
    jsonError(res, 404, "not_found", "Terminal session not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  const writeTerminalEvent = (eventName: string, payload: unknown): void => {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  writeTerminalEvent("terminal_snapshot", { terminal: buildArchitectTerminalSnapshot(session), output: session.output.join("") });
  const subscriber = (eventName: string, payload: unknown): void => writeTerminalEvent(eventName, payload);
  session.subscribers.add(subscriber);
  req.on("close", () => session.subscribers.delete(subscriber));
}

function handleArchitectTerminalCloseRequest(res: ServerResponse, terminalId: string): void {
  const session = architectTerminalSessions.get(terminalId);
  if (!session) {
    json(res, 200, { ok: true, terminal: null, already_closed: true }, { "Cache-Control": "no-store" });
    return;
  }
  closeArchitectTerminalSession(session);
  json(res, 200, { ok: true, terminal: buildArchitectTerminalSnapshot(session) }, { "Cache-Control": "no-store" });
}

function parseArchitectTerminalSocketMessage(raw: RawData): ArchitectTerminalSocketMessage | null {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf-8") : Array.isArray(raw) ? Buffer.concat(raw).toString("utf-8") : raw.toString();
  if (text.length > 8192) return null;
  const parsed = JSON.parse(text) as unknown;
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const message = parsed as Record<string, unknown>;
  if (message.type === "input" && typeof message.data === "string") {
    return { type: "input", data: message.data.slice(0, 4096) };
  }
  if (message.type === "resize" && Number.isInteger(message.cols) && Number.isInteger(message.rows)) {
    const cols = Number(message.cols);
    const rows = Number(message.rows);
    if (cols >= 2 && cols <= 500 && rows >= 1 && rows <= 200) return { type: "resize", cols, rows };
  }
  return null;
}

function attachArchitectTerminalSocket(session: ArchitectTerminalSession, socket: WebSocket): void {
  if (session.closed_at) {
    sendArchitectTerminalSocketMessage(socket, { type: "exit", terminal: buildArchitectTerminalSnapshot(session) });
    socket.close(1008, "terminal closed");
    return;
  }
  session.sockets.add(socket);
  session.connection_state = "connected";
  session.updated_at = new Date().toISOString();
  sendArchitectTerminalSocketMessage(socket, {
    type: "snapshot",
    terminal: buildArchitectTerminalSnapshot(session),
    output: session.output.join(""),
  });

  socket.on("message", (raw) => {
    let message: ArchitectTerminalSocketMessage | null = null;
    try {
      message = parseArchitectTerminalSocketMessage(raw);
    } catch {
      message = null;
    }
    if (!message) {
      sendArchitectTerminalSocketMessage(socket, { type: "error", error: "bad_message", message: "Malformed terminal WebSocket message" });
      socket.close(1003, "bad terminal message");
      return;
    }
    if (session.closed_at) {
      sendArchitectTerminalSocketMessage(socket, { type: "exit", terminal: buildArchitectTerminalSnapshot(session) });
      socket.close(1008, "terminal closed");
      return;
    }
    if (message.type === "input") {
      session.process.write(message.data);
      session.updated_at = new Date().toISOString();
      return;
    }
    session.cols = message.cols;
    session.rows = message.rows;
    session.updated_at = new Date().toISOString();
    session.process.resize(message.cols, message.rows);
    emitArchitectTerminalEvent(session, "terminal_resize", buildArchitectTerminalSnapshot(session));
    sendArchitectTerminalSocketMessage(socket, { type: "snapshot", terminal: buildArchitectTerminalSnapshot(session) });
  });

  socket.on("close", () => {
    session.sockets.delete(socket);
    if (session.sockets.size === 0 && !session.closed_at) {
      closeArchitectTerminalSession(session);
    }
  });

  socket.on("error", (error) => {
    session.sockets.delete(socket);
    const message = `Terminal WebSocket error: ${(error as Error).message}\n`;
    session.output.push(message);
    session.updated_at = new Date().toISOString();
    emitArchitectTerminalError(session, message);
  });
}

function rejectArchitectTerminalUpgrade(socket: Socket, statusCode: number, message: string): void {
  socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export async function handleArchitectTerminalUpgrade(req: IncomingMessage, socket: Socket, head: Buffer, pathname: string): Promise<boolean> {
  await ensureArchitectInstanceBinding();
  const route = parseArchitectTerminalSocketRoute(pathname);
  if (!route) return false;
  if (!route.terminalId) {
    rejectArchitectTerminalUpgrade(socket, 400, "Bad Request");
    return true;
  }
  const session = architectTerminalSessions.get(route.terminalId);
  if (!session) {
    rejectArchitectTerminalUpgrade(socket, 404, "Not Found");
    return true;
  }
  architectTerminalWebSocketServer.handleUpgrade(req, socket, head, (ws) => {
    attachArchitectTerminalSocket(session, ws);
  });
  return true;
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
    content: "architect archived this plan through a daemon-governed plan-panel action.",
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

async function handleArchitectPulseRequest(res: ServerResponse): Promise<void> {
  const pulse = await publishArchitectPulseIfChanged(false) ?? await buildArchitectPulseProjection();
  json(res, 200, {
    ok: true,
    contract: "architect",
    version: "v1",
    ...buildMeta(),
    pulse,
  }, { "Cache-Control": "no-store" });
}

async function buildArchitectTensionClustersProjection() {
  return buildTensionClusters((await engine.loadTensions()).signals);
}

async function handleArchitectTensionClustersRequest(res: ServerResponse): Promise<void> {
  json(res, 200, { ok: true, contract: "architect", version: "v1", clusters: await buildArchitectTensionClustersProjection() });
}

async function handleArchitectDesiresRequest(res: ServerResponse): Promise<void> {
  const selected = getArchitectSelectedPlanConfig();
  const plan = selected.planId ? await loadArchitectPlanDetail(selected.planId) : null;
  json(res, 200, {
    ok: true,
    contract: "architect",
    version: "v1",
    ledger: buildArchitectDesireLedger({
      cognitive: await engine.getStatus(),
      clusters: await buildArchitectTensionClustersProjection(),
      plan: plan ? { id: plan.id, living_state: plan.living_state } : null,
    }),
  });
}

async function handleArchitectDreamPlaybackRequest(res: ServerResponse): Promise<void> {
  const [history, dreamGraph, candidates, validated, tensions] = await Promise.all([
    engine.loadDreamHistory(),
    engine.loadDreamGraph(),
    engine.loadCandidateEdges(),
    engine.loadValidatedEdges(),
    engine.loadTensions(),
  ]);
  json(res, 200, { ok: true, contract: "architect", version: "v1", playback: buildDreamPlayback({ history, dreamGraph, candidates, validated, tensions }) });
}

async function handleArchitectLifecycleRequest(res: ServerResponse): Promise<void> {
  const [history, tensions] = await Promise.all([
    engine.loadDreamHistory(),
    engine.loadTensions(),
  ]);
  json(res, 200, {
    ok: true,
    contract: "architect",
    version: "v1",
    lifecycle: buildCognitiveLifecycleProjection({
      resolvedTensions: tensions.resolved_tensions,
      dreamHistory: history.sessions,
    }),
  });
}

async function handleArchitectCalibrationEvaluationRequest(res: ServerResponse): Promise<void> {
  const [history, dreamGraph, candidates, validated, tensions] = await Promise.all([
    engine.loadDreamHistory(),
    engine.loadDreamGraph(),
    engine.loadCandidateEdges(),
    engine.loadValidatedEdges(),
    engine.loadTensions(),
  ]);
  json(res, 200, {
    ok: true,
    contract: "architect",
    version: "v1",
    evaluation: buildCalibrationEvaluation({ history, dreamGraph, candidates, validated, tensions }),
  });
}

async function handleArchitectRepoSetupRead(res: ServerResponse): Promise<void> {
  json(res, 200, { ok: true, contract: "architect", version: "v1", repo_setup: await buildArchitectRepoSetupProjection() });
}

async function handleArchitectRepoSetupWrite(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readJsonBody(req);
    const repoSetup = await persistArchitectRepoSetup(body.repositories);
    await recordOnboardingTelemetryEvent({ event: "repo_setup_completed", category: repoSetup.mode });
    publishEvent("architect.repo_setup", { status: "configured", repo_setup: repoSetup });
    json(res, 200, { ok: true, contract: "architect", version: "v1", repo_setup: repoSetup, onboarding_readiness: buildOnboardingReadinessProjection() });
  } catch (error) {
    if (error instanceof ArchitectRepoSetupError) {
      jsonError(res, error.status, error.code, error.message);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    jsonError(res, message === "body_too_large" ? 413 : 400, message === "body_too_large" ? "body_too_large" : "bad_request", message);
  }
}

async function handleArchitectProviderReadinessRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readJsonBody(req);
    const readiness = buildArchitectProviderReadiness(body);
    await recordOnboardingTelemetryEvent({ event: "provider_tested", category: `${String(readiness.kind || "unknown")}_${readiness.ready ? "success" : "failure"}` });
    json(res, 200, { ok: true, contract: "architect", version: "v1", readiness });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    jsonError(res, message === "body_too_large" ? 413 : 400, message === "body_too_large" ? "body_too_large" : "bad_request", message);
  }
}

async function handleArchitectOnboardingEventRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const event = await recordOnboardingTelemetryEvent(await readJsonBody(req));
    json(res, 201, { ok: true, contract: "architect", version: "v1", event });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    jsonError(res, message === "body_too_large" ? 413 : 400, message === "body_too_large" ? "body_too_large" : "bad_request", message);
  }
}

async function handleArchitectOnboardingEventsRead(res: ServerResponse): Promise<void> {
  json(res, 200, { ok: true, contract: "architect", version: "v1", events: await readOnboardingTelemetryEvents() });
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
  const model = normalizeArchitectModelForAdapter(adapter, optionalTextField(body, "model") ?? current.model);
  const autonomyMode =
    architectAutonomyModeField(body, "autonomy_mode") ?? architectAutonomyModeField(body, "mode") ?? getArchitectAutonomyMode().mode;
  const requestedTokenEconomy = architectBooleanField(body, "token_economy");
  const tokenEconomy = requestedTokenEconomy ?? getArchitectTokenEconomyConfig().token_economy;

  if (adapter === "native_api_tool_loop" && provider !== "none" && model.length === 0) {
    jsonError(res, 400, "bad_request", "Native API Architect routing requires a model name");
    return;
  }

  const updates = {
    DREAMGRAPH_LLM_ARCHITECT_ADAPTER: adapter,
    DREAMGRAPH_LLM_ARCHITECT_PROVIDER: provider,
    DREAMGRAPH_LLM_ARCHITECT_MODEL: model,
    DREAMGRAPH_ARCHITECT_AUTONOMY_MODE: autonomyMode,
    [ARCHITECT_TOKEN_ECONOMY_ENV_KEY]: tokenEconomy ? "true" : "false",
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
    token_economy: runtime.token_economy,
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
    void publishArchitectPulseIfChanged(false);
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
  void publishArchitectPulseIfChanged(false);
  json(res, 200, {
    ok: true,
    contract: "architect",
    version: "v1",
    ...meta,
    result,
  }, { "Cache-Control": "no-store" });
}

function formatCompiledTaskPreambleForPrompt(compiled: CompiledTaskPreamble | null): string | null {
  if (!compiled?.preamble_text.trim()) return null;
  return [
    "Architect token economy task preamble:",
    compiled.preamble_text.trim(),
  ].join("\n");
}

async function buildArchitectChatPromptBundle(message: string, plan: ArchitectPlanProjection | null, runtime: ArchitectRuntimeRouteContext, chatScope: ArchitectChatScope): Promise<ArchitectChatPromptBundle> {
  const config = getArchitectTokenEconomyConfig();
  let compiled: CompiledTaskPreamble | null = null;
  if (config.preamble_compiler && config.token_economy) {
    compiled = await compileTaskPreamble({
      task: message,
      max_tokens: Math.min(512, Math.max(120, Math.floor(config.soft_target_tokens * 0.02))),
    }).catch((error) => ({
      preamble_text: "",
      evidence_anchors: [],
      token_count: 0,
      budget_decision: "omit_not_economical" as const,
      omitted_context_reasons: [`compiler_failed:${(error as Error).message.slice(0, 160)}`],
      validation_failures: [],
      selected_model_layer: "deterministic_fallback" as const,
      selected_model_provider: null,
      selected_model: null,
      fallback_reason: "task_preamble_compiler_failed",
    }));
  }
  const preambleBlock = formatCompiledTaskPreambleForPrompt(compiled);
  return {
    systemPrompt: buildArchitectChatSystemPrompt(plan, runtime, chatScope, preambleBlock),
    tokenEconomy: {
      ...config,
      status: config.token_economy ? "enabled" : "full_context",
      preamble_status: config.preamble_compiler ? (compiled?.budget_decision ?? "not_attempted") : "disabled",
      preamble_token_count: compiled?.token_count ?? 0,
      evidence_anchors: compiled?.evidence_anchors ?? [],
      omitted_context_reasons: compiled?.omitted_context_reasons ?? [],
      validation_failures: compiled?.validation_failures ?? [],
      selected_model_layer: compiled?.selected_model_layer ?? null,
      selected_model_provider: compiled?.selected_model_provider ?? null,
      selected_model: compiled?.selected_model ?? null,
      fallback_reason: compiled?.fallback_reason ?? null,
    },
  };
}

function architectBudgetSessionKey(runtime: ArchitectRuntimeRouteContext): string {
  return runtime.session_id;
}

function createChatBudgetCoordinator(runtime: ArchitectRuntimeRouteContext, config: ArchitectTokenEconomyConfig): BudgetCoordinator | null {
  if (!config.token_economy) return null;
  return createStandaloneBudgetCoordinator(architectBudgetSessionKey(runtime), {
    expectedTokensPerTurn: config.soft_target_tokens,
    transportCeilingTokens: config.transport_ceiling_tokens,
    debtCarryFraction: config.debt_carry_fraction,
    modelId: runtime.model || "none",
  });
}

function finalizeChatBudgetStatus(
  runtime: ArchitectRuntimeRouteContext,
  coordinator: BudgetCoordinator | null,
  promptBundle: ArchitectChatPromptBundle,
  message: string,
  assistantContent: string,
): ArchitectBudgetStatus | null {
  if (!coordinator) return null;
  const pressureLabel = coordinator.getContextPressureLabel();
  const systemTokens = estimateTokensFromString(promptBundle.systemPrompt);
  const userTokens = estimateTokensFromString(message);
  const assistantTokens = estimateTokensFromString(assistantContent);
  coordinator.recordComponentActual("system", systemTokens);
  coordinator.recordComponentActual("user", userTokens);
  coordinator.recordComponentActual("assistant", assistantTokens);
  const snapshot = finalizeStandaloneBudgetTurn(architectBudgetSessionKey(runtime), coordinator);
  return buildArchitectBudgetStatus(architectBudgetSessionKey(runtime), snapshot, pressureLabel);
}

function buildArchitectChatSystemPrompt(plan: ArchitectPlanProjection | null, runtime: ArchitectRuntimeRouteContext, chatScope: ArchitectChatScope, preambleBlock: string | null = null): string {
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
    `- Token economy: ${getArchitectTokenEconomyConfig().token_economy ? "enabled" : "full_context"}; preamble compiler=${getArchitectTokenEconomyConfig().preamble_compiler ? "enabled" : "disabled"}; soft target=${getArchitectTokenEconomyConfig().soft_target_tokens}`,
  ].join("\n");
  return [
    "You are DreamGraph Architect inside the daemon-served standalone browser surface.",
    "Use the provided DreamGraph MCP tools for project facts, graph health, ADRs, workflows, data model, source inspection, and verification before answering repository-specific questions.",
    "Keep answers concise, project-bound, and grounded in daemon authority. Do not claim direct browser filesystem authority.",
    "Project scope is not unsafe mode: source, graph, ADR, and file mutations still require the normal governed DreamGraph MCP/tool authority.",
    "If asked which model, provider, adapter, route, autonomy state, or session you are running, answer from the Current execution runtime block. Never say this runtime identity is unknown inside DreamGraph.",
    `Project root: ${String(project.project_root ?? "unbound")}. Plans root: ${String(project.plans_root ?? "unbound")}.`,
    runtimeBlock,
    latestArchitectPulse ? formatArchitectPulseLine(latestArchitectPulse) : null,
    preambleBlock,
    planContext,
  ].filter(Boolean).join("\n");
}

function isEmptyCompletionFallback(fallbackReason: string | null): boolean {
  return fallbackReason === "empty_llm_response" || fallbackReason === "empty_cli_bridge_response";
}

export function formatUserVisibleFallbackReason(fallbackReason: string | null): string {
  if (!fallbackReason || isEmptyCompletionFallback(fallbackReason)) return "";
  return ` Runtime diagnostic: ${fallbackReason}.`;
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
  const reason = formatUserVisibleFallbackReason(fallbackReason);
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

function startChatSseResponse(res: ServerResponse, status: Record<string, unknown>): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform, no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  writeComment(res, "architect-chat");
  writeSsePayload(res, "architect.chat.status", {
    ok: true,
    phase: "running",
    ...status,
  });
}

function finishChatSseResponse(res: ServerResponse, payload: Record<string, unknown>): void {
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

function writeChatSseResponse(res: ServerResponse, payload: Record<string, unknown>): void {
  startChatSseResponse(res, {
    generated_at: payload.generated_at,
    project_scope: payload.project_scope,
    architect_llm: payload.architect_llm,
  });
  finishChatSseResponse(res, payload);
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

export function architectPassStatusFromFallback(fallbackReason: string | null): ArchitectPassStatus {
  if (!fallbackReason || isEmptyCompletionFallback(fallbackReason)) return "complete";
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
  const streamResponse = wantsChatSseResponse(req, body);
  const plan = planId ? await loadArchitectPlanDetail(planId) : null;
  if (planId && !plan) {
    jsonError(res, 404, "not_found", `No Architect plan with id: ${planId}`);
    return;
  }

  const architectConfig = buildArchitectLlmRequestConfig(body);
  architectConfig.model = normalizeArchitectModelForAdapter(adapter, architectConfig.model);
  const provider = createLlmProviderForConfig(architectConfig);
  let providerAvailable = false;
  let fallbackReason: string | null = null;
  let assistantText: string | null = null;
  let completionModel = architectConfig.model;
  let toolTrace: ArchitectToolTraceEntry[] = [];
  let provenance: unknown = null;
  let toolLoopRoute: unknown = null;
  let planUpdate: ArchitectPlanChatUpdateResult | null = null;
  let tokenEconomy: unknown = getArchitectTokenEconomyConfig();
  let runtime = buildActiveArchitectSessionRuntime({
    adapter,
    provider: architectConfig.provider,
    model: architectConfig.model,
    autonomy_mode: mode,
    pass_state: updateActiveArchitectPassState({ status: "running", tools: 0 }),
  });
  const executionController = new AbortController();
  activeArchitectExecutionControl = {
    id: `${runtime.session_id}:${Date.now()}`,
    adapter,
    controller: executionController,
    state: "running",
    started_at: new Date().toISOString(),
    last_action_at: new Date().toISOString(),
    steering_prompts: [],
  };
  const abortExecution = () => {
    if (!executionController.signal.aborted) executionController.abort();
  };
  req.on("aborted", abortExecution);
  res.on("close", () => {
    if (!res.writableEnded) abortExecution();
  });
  if (streamResponse) {
    startChatSseResponse(res, {
      chat_scope: chatScope,
      selected_plan_id: selectedPlanId ?? null,
      plan_id: plan?.id ?? null,
      continuation_token_present: continuationToken != null,
      mode,
      runtime,
      architect_runtime: runtime,
    });
  }
  publishEvent("architect.execution_control", {
    action: "started",
    ...buildArchitectExecutionControlPayload(runtime),
  });
  void publishArchitectPulseIfChanged(false);

  const promptBundle = await buildArchitectChatPromptBundle(message, plan, runtime, chatScope);
  tokenEconomy = promptBundle.tokenEconomy;
  const budgetCoordinator = createChatBudgetCoordinator(runtime, getArchitectTokenEconomyConfig());
  let budgetStatus: ArchitectBudgetStatus | null = null;

  if (adapter === "deterministic_fallback") {
    fallbackReason = "operator_selected_deterministic_fallback";
  } else if (adapter === "codex-cli" || adapter === "copilot-cli") {
    const messages: LlmMessage[] = [
      { role: "system", content: promptBundle.systemPrompt },
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
        signal: executionController.signal,
        onToolTrace: (entry) => {
          toolTrace = mergeArchitectToolTraceEntries(toolTrace, entry);
          runtime = buildActiveArchitectSessionRuntime({
            adapter,
            provider: architectConfig.provider,
            model: architectConfig.model,
            autonomy_mode: mode,
            pass_state: updateActiveArchitectPassState({ status: "running", tools: toolTrace.length }),
          });
          const toolEvent = {
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
          };
          publishEvent("architect.tool_result", toolEvent);
          if (streamResponse && !res.writableEnded) {
            writeSsePayload(res, "architect.chat.status", { ok: true, phase: "tool", ...toolEvent });
          }
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
      fallbackReason = executionController.signal.aborted
        ? "architect_execution_cancelled"
        : `architect_provider_failed: ${(error as Error).message.slice(0, 240)}`;
    }
  } else if (architectConfig.provider === "none" || architectConfig.model.length === 0) {
    fallbackReason = "architect_llm_not_configured";
  } else {
    const messages: LlmMessage[] = [
      { role: "system", content: promptBundle.systemPrompt },
      { role: "user", content: message },
    ];
    try {
      const completion = await runArchitectNativeToolLoop({
        req,
        config: architectConfig,
        provider,
        messages,
        userMessage: message,
        budgetCoordinator,
        onToolTrace: (entry) => {
          toolTrace = mergeArchitectToolTraceEntries(toolTrace, entry);
          runtime = buildActiveArchitectSessionRuntime({
            adapter,
            provider: architectConfig.provider,
            model: architectConfig.model,
            autonomy_mode: mode,
            pass_state: updateActiveArchitectPassState({ status: "running", tools: toolTrace.length }),
          });
          const toolEvent = {
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
          };
          publishEvent("architect.tool_result", toolEvent);
          if (streamResponse && !res.writableEnded) {
            writeSsePayload(res, "architect.chat.status", { ok: true, phase: "tool", ...toolEvent });
          }
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
        fallbackReason = fallbackReason ?? "empty_llm_response";
      }
    } catch (error) {
      fallbackReason = executionController.signal.aborted
        ? "architect_execution_cancelled"
        : `architect_provider_failed: ${(error as Error).message.slice(0, 240)}`;
    }
  }

  if (executionController.signal.aborted && !fallbackReason) {
    fallbackReason = "architect_execution_cancelled";
  }

  if (!assistantText && chatScope === "plan" && !executionController.signal.aborted && shouldApplyPlanChatUpdate(message, plan)) {
    planUpdate = await applyPlanChatUpdate(plan!, message, runtime);
  }

  const finalPassState = updateActiveArchitectPassState({
    completed: activeArchitectPassState.completed + 1,
    tools: toolTrace.length,
    status: executionController.signal.aborted ? "cancelled" : architectPassStatusFromFallback(fallbackReason),
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

  const normalizedAssistantText = typeof assistantText === "string" ? assistantText.trim() : "";
  const finalAssistantContent = normalizedAssistantText.length > 0
    ? normalizedAssistantText
    : deterministicArchitectChatReply(message, fallbackReason, plan, runtime, chatScope, planUpdate);
  budgetStatus = finalizeChatBudgetStatus(runtime, budgetCoordinator, promptBundle, message, finalAssistantContent);
  if (budgetStatus) {
    const tokenEconomyRecord = asRecord(tokenEconomy) ?? {};
    tokenEconomy = { ...tokenEconomyRecord, budget_status: budgetStatus };
  }

  const result = {
    role: "assistant",
    content: finalAssistantContent,
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
      token_economy: tokenEconomy,
    },
    token_economy: tokenEconomy,
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
    token_economy: tokenEconomy,
    budget_status: budgetStatus,
  });
  void publishArchitectPulseIfChanged(false);

  if (activeArchitectExecutionControl?.controller === executionController) {
    activeArchitectExecutionControl = null;
  }

  const meta = buildMeta();
  const payload = {
    ok: true,
    contract: "architect",
    version: "v1",
    transport: streamResponse ? "sse" : "json",
    ...meta,
    runtime,
    architect_runtime: runtime,
    result,
  };

  if (streamResponse) {
    finishChatSseResponse(res, payload);
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
    { kind: "source" as const, id: "src/architect/routes.ts", label: "architect route layer" },
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
        content: "architect scheduler action executed through daemon-governed Phase 6 endpoint.",
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
  let shell = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DreamGraph Architect</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="stylesheet" href="/api/architect/v1/assets/xterm/xterm.css" />
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
      display: flex;
      align-items: baseline;
      gap: 6px;
      margin: 0 0 6px;
      padding-right: 30px;
      font-size: 0.68rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .section-title a {
      color: inherit;
      text-decoration: none;
    }
    .section-title a:hover,
    .section-title a:focus-visible {
      color: var(--ink);
      outline: none;
    }
    .section-title .version {
      font-size: 0.78em;
      font-weight: 500;
      letter-spacing: 0.04em;
      opacity: 0.72;
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
      background: #111815;
      color: var(--ink);
      padding: 5px 6px;
      font: 0.66rem/1.2 var(--sans);
    }
    .plan-filter-field select option {
      background: #111815;
      color: var(--ink);
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
      border-radius: 6px;
      padding: 3px 6px;
      background: rgba(255, 255, 255, 0.045);
      color: var(--muted);
      font-size: 0.64rem;
      line-height: 1.18;
      overflow-wrap: anywhere;
    }
    .architect-pulse-strip {
      display: flex;
      flex: 1 1 100%;
      flex-wrap: wrap;
      gap: 5px;
      min-width: 0;
      align-items: center;
    }
    .architect-pulse-strip .runtime-pill {
      border-color: rgba(104, 216, 182, 0.22);
    }
    .architect-pulse-strip[data-weather="blocked"] .runtime-pill,
    .architect-pulse-strip[data-weather="strained"] .runtime-pill {
      border-color: rgba(255, 188, 107, 0.42);
      color: #ffd7a3;
    }
    .chat-panel {
      display: grid;
      grid-template-rows: auto auto auto auto minmax(0, 1fr);
      gap: 8px;
      overflow: hidden;
    }
    .architect-center-tab-strip {
      display: flex;
      gap: 4px;
      align-items: center;
      border-bottom: 1px solid var(--line);
      padding-bottom: 3px;
      min-width: 0;
      position: relative;
      z-index: 5;
    }
    .architect-center-tabs {
      display: flex;
      flex: 1 1 auto;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      min-width: 0;
    }
    .architect-tab-item {
      display: inline-flex;
      align-items: center;
      max-width: 210px;
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.045);
      color: var(--muted);
      overflow: hidden;
    }
    .architect-tab-item.is-active {
      border-color: rgba(104, 216, 182, 0.54);
      background: var(--accent-soft);
      color: var(--accent);
    }
    .architect-tab-button {
      min-height: 22px;
      max-width: 180px;
      border: 0;
      border-radius: 0;
      background: transparent;
      color: inherit;
      cursor: pointer;
      padding: 2px 7px;
      font: 700 0.66rem/1.15 var(--sans);
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .architect-tab-label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .architect-tab-close {
      flex: 0 0 auto;
      width: 20px;
      height: 28px;
      border: 0;
      border-left: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 0;
      background: transparent;
      color: inherit;
      cursor: pointer;
      padding: 0;
      font: 700 0.72rem/1 var(--sans);
    }
    .architect-tab-close:hover {
      background: rgba(255, 255, 255, 0.10);
    }
    .architect-tab-add {
      flex: 0 0 auto;
      width: 24px;
      height: 22px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.045);
      color: var(--muted);
      cursor: pointer;
      font: 800 0.9rem/1 var(--sans);
    }
    .architect-tab-menu {
      position: absolute;
      right: 0;
      top: calc(100% + 4px);
      z-index: 20;
      min-width: 160px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: #111815;
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.34);
      padding: 4px;
    }
    .architect-tab-menu button {
      width: 100%;
      border: 0;
      border-radius: 5px;
      background: transparent;
      color: var(--ink);
      cursor: pointer;
      padding: 7px 8px;
      text-align: left;
      font: 700 0.72rem/1.2 var(--sans);
    }
    .architect-tab-menu button:hover {
      background: rgba(255, 255, 255, 0.08);
    }
    .architect-tab-panels {
      position: relative;
      z-index: 1;
      grid-row: -2 / -1;
      min-height: 0;
      height: 100%;
      overflow: hidden;
      display: grid;
      grid-template-rows: minmax(0, 1fr);
    }
    .architect-tab-panel {
      min-height: 0;
      height: 100%;
      overflow: hidden;
    }
    .architect-tab-panel.chat-workspace {
      display: grid;
      grid-template-rows: minmax(0, 1fr) minmax(0, auto) auto;
      gap: 8px;
      overflow: hidden;
    }
    .architect-tab-panel[hidden] {
      display: none !important;
      pointer-events: none;
    }
    .architect-tab-panel.plan-workspace,
    .architect-tab-panel.adr-workspace {
      overflow: auto;
      padding-right: 4px;
    }
    .architect-tab-panel.terminal-workspace {
      display: grid;
      grid-template-rows: minmax(0, 1fr);
      gap: 0;
      overflow: hidden;
    }
    .architect-tab-panel.terminal-workspace > h2 {
      display: none;
    }
    /* architect-doom-css:start */
    .architect-tab-panel.doom-workspace > h2 {
      display: none;
    }
    .architect-tab-panel.doom-workspace {
      display: grid;
      grid-template-rows: minmax(0, 1fr);
      overflow: hidden;
    }
    .doom-surface {
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr);
      gap: 8px;
      min-height: 0;
      height: 100%;
      overflow: hidden;
    }
    .doom-toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      align-items: center;
      color: var(--muted);
      font-size: 0.72rem;
    }
    .doom-first-run-card {
      display: grid;
      gap: 5px;
      padding: 8px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel-soft);
      color: var(--muted);
      font-size: 0.72rem;
    }
    .doom-first-run-card[hidden] {
      display: none;
    }
    .doom-first-run-card progress {
      width: min(360px, 100%);
    }
    .doom-viewport {
      min-height: 0;
      height: 100%;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #000;
    }
    /* architect-doom-css:end */
    .architect-tab-panel h2 {
      margin: 0 0 8px;
      font-size: 1rem;
      line-height: 1.2;
    }
    .terminal-surface {
      display: grid;
      grid-template-rows: minmax(24px, auto) minmax(0, 1fr);
      gap: 8px;
      min-height: 0;
      height: 100%;
      overflow: hidden;
    }
    .terminal-toolbar {
      display: flex;
      flex: 0 0 auto;
      flex-wrap: nowrap;
      gap: 5px;
      align-items: center;
      justify-content: space-between;
      min-width: 0;
      max-height: 28px;
      overflow: hidden;
      color: var(--muted);
      font-size: 0.66rem;
    }
    .terminal-toolbar span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .terminal-console {
      position: relative;
      min-height: 0;
      height: 100%;
      box-sizing: border-box;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #07100d;
      color: var(--ink);
      overflow: hidden;
      font: 0.78rem/1.45 var(--mono);
    }
    .terminal-xterm-mount {
      position: absolute;
      inset: 8px 8px 16px 8px;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
    }
    .terminal-xterm-mount .xterm {
      width: 100%;
      height: 100%;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
    }
    .terminal-xterm-mount .xterm-viewport,
    .terminal-xterm-mount .xterm-screen {
      border-radius: 6px;
    }
    .terminal-fallback {
      position: absolute;
      inset: 8px;
      display: grid;
      place-items: center;
      color: var(--muted);
      text-align: center;
      font: 0.78rem/1.4 var(--mono);
      pointer-events: none;
      white-space: pre-wrap;
    }
    .terminal-fallback[hidden] {
      display: none !important;
    }
    .provider-setup { display: grid; gap: 7px; border: 1px solid var(--line); border-radius: 8px; padding: 8px; background: rgba(104, 216, 182, 0.055); }
    .provider-setup[hidden] { display: none; }
    .provider-setup-header, .provider-choice-row, .provider-setup-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; justify-content: space-between; }
    .provider-setup-actions { justify-content: flex-end; }
    .runtime-advanced summary { cursor: pointer; color: var(--muted); font-size: 0.72rem; }
    .architect-provider-show { margin-left: 8px; }
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
    .tool-trace-row pre {
      margin: 4px 0 0;
      max-height: 180px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 0.68rem;
      line-height: 1.35;
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
    .architect-welcome {
      display: grid;
      gap: 12px;
      min-height: 0;
      max-height: min(58vh, 520px);
      overflow: auto;
      border: 1px solid rgba(104, 216, 182, 0.34);
      border-radius: 12px;
      padding: 14px;
      background: rgba(104, 216, 182, 0.075);
    }
    .architect-welcome[hidden] {
      display: none;
    }
    .architect-welcome-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .architect-welcome h2,
    .architect-welcome p {
      margin: 0;
    }
    .architect-welcome-summary,
    .architect-welcome-warnings {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .architect-welcome-missions,
    .architect-recipe-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      gap: 8px;
    }
    .architect-recipe-library { border: 1px solid var(--line); border-radius: 8px; padding: 9px; background: rgba(255, 255, 255, 0.045); }
    .architect-recipe-library summary { cursor: pointer; font-weight: 800; }
    .architect-recipe-group { margin-top: 9px; }
    .architect-recipe-group h3 { margin: 0 0 6px; color: var(--muted); font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.06em; }
    .architect-mission-card {
      display: grid;
      gap: 6px;
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.055);
      color: var(--ink);
      cursor: pointer;
      padding: 10px;
      text-align: left;
    }
    .architect-mission-card:hover {
      border-color: rgba(104, 216, 182, 0.5);
      background: rgba(104, 216, 182, 0.14);
    }
    .architect-mission-card strong,
    .architect-mission-card span {
      display: block;
    }
    .architect-mission-artifact {
      color: var(--muted);
      font-size: 0.72rem;
      line-height: 1.35;
    }
    .architect-welcome-reopen {
      flex: 0 0 auto;
    }
    .architect-repo-setup {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 9px;
      background: rgba(255, 255, 255, 0.045);
    }
    .architect-repo-setup summary { cursor: pointer; font-weight: 800; }
    .architect-repo-setup-grid { display: grid; gap: 7px; margin-top: 8px; }
    .architect-repo-row { display: grid; grid-template-columns: minmax(90px, 0.65fr) minmax(90px, 0.6fr) minmax(180px, 2fr) auto; gap: 6px; }
    .architect-repo-row input, .architect-repo-row select { min-width: 0; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--ink); padding: 6px; }
    .architect-repo-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .chat-form {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 8px;
    }
    .prompt-surface {
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.055);
      padding: 8px;
    }
    .prompt-surface-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }
    .chat-input {
      width: 100%;
      min-height: 34px;
      max-height: 112px;
      resize: none;
      border: 0;
      background: transparent;
      color: var(--ink);
      padding: 4px 2px;
      font: 0.82rem/1.34 var(--sans);
      overflow: hidden;
    }
    .chat-input:focus {
      outline: none;
    }
    .prompt-surface:focus-within {
      outline: 2px solid rgba(104, 216, 182, 0.32);
      border-color: rgba(104, 216, 182, 0.52);
    }
    .chat-attachment-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 32px;
    }
    .chat-attachment-cluster {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .chat-send-cluster {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      flex: 0 0 auto;
    }
    .chat-attachment-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 0;
      padding: 0;
      list-style: none;
      min-width: 0;
    }
    .token-economy-pill {
      display: inline-flex;
      align-items: center;
      flex: 0 0 auto;
      width: max-content;
      min-height: 22px;
      padding: 2px 7px;
      border: 1px solid rgba(104, 216, 182, 0.25);
      border-radius: 999px;
      background: rgba(104, 216, 182, 0.08);
      color: var(--muted);
      font: inherit;
      font-size: 0.66rem;
      white-space: nowrap;
      cursor: pointer;
    }
    .token-economy-pill:disabled {
      cursor: wait;
      opacity: 0.72;
    }
    .token-economy-pill.full-context {
      border-color: rgba(255, 198, 109, 0.32);
      background: rgba(255, 198, 109, 0.1);
    }
    .chat-attachment-list li {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      min-height: 32px;
      padding: 3px 8px;
      border: 1px solid rgba(104, 216, 182, 0.24);
      border-radius: 999px;
      background: rgba(104, 216, 182, 0.08);
      color: var(--muted);
      font-size: 0.68rem;
    }
    .scope-pill {
      align-self: flex-start;
      max-width: min(280px, 100%);
      height: 22px;
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
    .scope-pill:focus-visible,
    .mini-icon-button:focus-visible,
    .chat-send-button:focus-visible {
      outline: 2px solid rgba(104, 216, 182, 0.55);
      outline-offset: 2px;
    }
    .mini-icon-button,
    .chat-send-button {
      display: inline-grid;
      place-items: center;
      width: 32px;
      height: 32px;
      min-width: 32px;
      border-radius: 999px;
      cursor: pointer;
      line-height: 1;
    }
    .mini-icon-button {
      border: 1px solid rgba(255, 255, 255, 0.14);
      background: rgba(255, 255, 255, 0.065);
      color: var(--ink);
      font-size: 1rem;
    }
    .mini-icon-button:hover {
      border-color: rgba(104, 216, 182, 0.36);
      background: rgba(104, 216, 182, 0.12);
    }
    .chat-send-button {
      border: 1px solid rgba(104, 216, 182, 0.66);
      background: var(--accent);
      color: #07130f;
      padding: 0;
    }
    .chat-send-button:hover {
      border-color: rgba(255, 255, 255, 0.38);
      filter: brightness(1.08);
    }
    .chat-send-button svg {
      width: 17px;
      height: 17px;
      stroke-width: 2.35;
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
      margin-top: 0;
      font-size: 0.68rem;
      line-height: 1.35;
    }
    .action-button:disabled,
    .mini-icon-button:disabled,
    .chat-send-button:disabled,
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
      gap: 4px;
      margin: 3px 0 6px;
    }
    .chip {
      max-width: 100%;
      border-radius: 999px;
      padding: 2px 5px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 0.62rem;
      line-height: 1.12;
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
      gap: 6px;
    }
    .action-button {
      width: 100%;
      min-width: 0;
      min-height: 28px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel-strong);
      color: var(--ink);
      cursor: pointer;
      font-size: 0.78rem;
      font-weight: 600;
      line-height: 1.1;
      padding: 3px 6px;
      overflow-wrap: anywhere;
    }
    .action-button:hover {
      border-color: rgba(104, 216, 182, 0.46);
      background: #24342f;
    }
    .inline-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    .architect-right-accordion .inline-actions {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(68px, 1fr));
      align-items: center;
    }
    .mini-button {
      min-width: 0;
      max-width: 100%;
      min-height: 28px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: rgba(104, 216, 182, 0.1);
      color: var(--ink);
      cursor: pointer;
      padding: 3px 6px;
      font-size: 0.76rem;
      font-weight: 600;
      line-height: 1.1;
      overflow-wrap: anywhere;
    }
    .mini-button:hover {
      border-color: rgba(104, 216, 182, 0.5);
      background: rgba(104, 216, 182, 0.18);
    }
    .adr-icon-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: rgba(104, 216, 182, 0.1);
      color: var(--ink);
      cursor: pointer;
      padding: 0;
      flex: 0 0 auto;
    }
    .adr-icon-button:hover {
      border-color: rgba(104, 216, 182, 0.5);
      background: rgba(104, 216, 182, 0.18);
    }
    .adr-icon-button svg {
      width: 14px;
      height: 14px;
      stroke: currentColor;
      fill: none;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .inline-actions > * {
      flex: 1 1 132px;
    }
    .adr-binding-item {
      display: grid;
      gap: 6px;
    }
    .adr-binding-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
    }
    .adr-binding-header strong {
      margin-bottom: 0;
      min-width: 0;
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
      <h2 class="section-title"><a href="/" title="DreamGraph landing page">DreamGraph</a><span class="version">v${config.server.version}</span></h2>
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
        <div id="architect-pulse-strip" class="architect-pulse-strip" data-weather="unknown" aria-label="Architect pulse">
          <span id="architect-pulse-weather" class="runtime-pill">Pulse loading...</span>
          <span id="architect-pulse-cognitive" class="runtime-pill">Cognitive: unknown</span>
          <span id="architect-pulse-plan" class="runtime-pill">Plan: none</span>
          <span id="architect-pulse-authority" class="runtime-pill">Authority: dreamgraph_mcp</span>
        </div>
      </div>
      <section id="architect-provider-setup" class="provider-setup" aria-label="Architect provider setup">
        <div class="provider-setup-header"><strong>How should Architect answer?</strong><div class="provider-setup-actions"><button id="architect-provider-test" class="mini-button" type="button">Test setup</button><button id="architect-provider-dismiss" class="mini-button" type="button">Hide</button></div></div>
        <label class="meta"><input id="architect-provider-suppress" type="checkbox"> Do not show this setup box again</label>
        <div class="provider-choice-row">
          <button class="mini-button" type="button" data-provider-choice="codex-cli">CLI subscription</button>
          <button class="mini-button" type="button" data-provider-choice="api">API provider</button>
          <button class="mini-button" type="button" data-provider-choice="local">Local model</button>
          <button class="mini-button" type="button" data-provider-choice="deterministic_fallback">No AI fallback</button>
        </div>
        <p id="architect-provider-status" class="meta">Choose a route, then test readiness. Advanced controls remain available below.</p>
      </section>
      <details class="runtime-advanced">
        <summary>Advanced runtime controls <button id="architect-provider-show" class="mini-button architect-provider-show" type="button" hidden>Show setup</button></summary>
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
      </details>
      <div class="architect-center-tab-strip">
        <div id="architect-center-tabs" class="architect-center-tabs" role="tablist" aria-label="Center workspace"></div>
        <button id="architect-tab-add" class="architect-tab-add" type="button" aria-label="Create center tab" title="Create center tab">+</button>
        <div id="architect-tab-menu" class="architect-tab-menu" hidden></div>
      </div>
      <div id="architect-tab-panels" class="architect-tab-panels">
        <div id="architect-panel-chat" class="architect-tab-panel chat-workspace" role="tabpanel" aria-labelledby="architect-tab-chat" data-architect-tab-panel="chat">
          <div id="chat-log" class="chat-log" aria-live="polite"></div>
          <section id="architect-welcome" class="architect-welcome" aria-labelledby="architect-welcome-title" hidden>
            <div class="architect-welcome-header">
              <div>
                <h2 id="architect-welcome-title">What do you want to do with this project?</h2>
                <p class="meta">Pick a mission. Architect will state the first artifact and keep repository work daemon-governed.</p>
              </div>
              <button id="architect-welcome-dismiss" class="mini-button" type="button">Dismiss</button>
            </div>
            <div id="architect-welcome-summary" class="architect-welcome-summary"></div>
            <div id="architect-welcome-warnings" class="architect-welcome-warnings"></div>
            <details id="architect-repo-setup" class="architect-repo-setup">
              <summary>Connect repositories</summary>
              <p id="architect-repo-setup-scope" class="meta">Repositories define the project scope Architect may inspect through DreamGraph MCP.</p>
              <div id="architect-repo-setup-grid" class="architect-repo-setup-grid"></div>
              <div class="architect-repo-actions">
                <button id="architect-repo-add" class="mini-button" type="button">Add related repo</button>
                <button id="architect-repo-save" class="mini-button" type="button">Save repositories</button>
                <button id="architect-repo-map" class="mini-button" type="button">Build first project map</button>
              </div>
              <p id="architect-repo-setup-status" class="meta">Loading daemon repository inventory...</p>
            </details>
            <details class="architect-recipe-library">
              <summary>Start from a recipe</summary>
              <p class="meta">Choose a task by project shape. Each recipe states the first artifact and how to verify it.</p>
              <div id="architect-recipe-groups"></div>
            </details>
            <div id="architect-welcome-missions" class="architect-welcome-missions"></div>
            <a id="architect-guide-link" href="/architect-guide">Learn how Architect works</a>
          </section>
          <form id="chat-form" class="chat-form">
            <div class="prompt-surface">
              <div class="prompt-surface-header">
                <button id="chat-scope-pill" class="scope-pill" type="button" data-scope="project" aria-pressed="false" aria-label="Toggle chat scope">🌍 Project</button>
                <button id="architect-welcome-reopen" class="scope-pill architect-welcome-reopen" type="button" hidden>Choose a mission</button>
              </div>
              <textarea id="chat-input" class="chat-input" name="message" rows="1" placeholder="Ask Architect about this project or the selected plan..."></textarea>
              <div class="chat-attachment-row">
                <div class="chat-attachment-cluster">
                  <button id="chat-attachment-button" class="mini-icon-button" type="button" aria-label="Add attachment" title="Add attachment">+</button>
                  <button id="chat-token-economy-status" class="token-economy-pill" type="button" title="Architect token economy status">Token economy</button>
                  <ul id="chat-attachment-list" class="chat-attachment-list" hidden></ul>
                </div>
                <div class="chat-send-cluster">
                  <span id="chat-processing-light" class="processing-light" aria-hidden="true"></span>
                  <button id="chat-pause" class="mini-icon-button" type="button" aria-label="Pause task" title="Pause task" hidden>II</button>
                  <button id="chat-stop" class="mini-icon-button" type="button" aria-label="Stop task" title="Stop task" hidden>X</button>
                  <button id="chat-submit" class="chat-send-button" type="submit" aria-label="Send prompt" title="Send prompt">
                    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M3.714 3.048a.498.498 0 0 0-.683.627l2.843 7.627a2 2 0 0 1 0 1.396l-2.842 7.627a.498.498 0 0 0 .682.627l18-8.5a.5.5 0 0 0 0-.904z" />
                      <path d="M6 12h16" />
                    </svg>
                  </button>
                </div>
              </div>
              <input id="chat-attachment-input" type="file" multiple hidden />
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
        <details class="architect-right-accordion" open>
          <summary>Plugin Tab Summary</summary>
          <div id="plugin-tab-summary" class="chips"></div>
        </details>
        <details class="architect-right-accordion" open>
          <summary>Living Plan</summary>
          <div id="living-plan-summary" class="chips"></div>
          <p id="living-plan-pulse" class="status">Select a plan to project its living state.</p>
          <details class="living-plan-foldout">
            <summary>Open questions <span id="living-plan-question-count" class="living-plan-count">0</span></summary>
            <p class="meta">Projected from the selected plan's Open Questions section. These are unresolved items that can change the plan's confidence and next review prompt.</p>
            <ul id="living-plan-question-list" class="living-plan-list"></ul>
          </details>
          <details class="living-plan-foldout">
            <summary>Nervous points <span id="living-plan-nervous-point-count" class="living-plan-count">0</span></summary>
            <p class="meta">Projected from risk, risk-register, nervous-point, and design-guardrail sections. They flag areas that deserve review; they are not mutation controls.</p>
            <ul id="living-plan-nervous-point-list" class="living-plan-list"></ul>
          </details>
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
  <script src="/api/architect/v1/assets/xterm/xterm.js"></script>
  <script src="/api/architect/v1/assets/xterm/addon-fit.js"></script>
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
    const pluginTabSummaryEl = document.getElementById('plugin-tab-summary');
    const livingPlanSummaryEl = document.getElementById('living-plan-summary');
    const livingPlanPulseEl = document.getElementById('living-plan-pulse');
    const livingPlanQuestionCountEl = document.getElementById('living-plan-question-count');
    const livingPlanQuestionListEl = document.getElementById('living-plan-question-list');
    const livingPlanNervousPointCountEl = document.getElementById('living-plan-nervous-point-count');
    const livingPlanNervousPointListEl = document.getElementById('living-plan-nervous-point-list');
    const projectScopeEl = document.getElementById('project-scope');
    const architectModelConfigEl = document.getElementById('architect-model-config');
    const architectProviderSetupEl = document.getElementById('architect-provider-setup');
    const architectProviderStatusEl = document.getElementById('architect-provider-status');
    const architectProviderTestEl = document.getElementById('architect-provider-test');
    const architectProviderDismissEl = document.getElementById('architect-provider-dismiss');
    const architectProviderSuppressEl = document.getElementById('architect-provider-suppress');
    const architectProviderShowEl = document.getElementById('architect-provider-show');
    const liveEventStatusEl = document.getElementById('live-event-status');
    const architectPulseStripEl = document.getElementById('architect-pulse-strip');
    const architectPulseWeatherEl = document.getElementById('architect-pulse-weather');
    const architectPulseCognitiveEl = document.getElementById('architect-pulse-cognitive');
    const architectPulsePlanEl = document.getElementById('architect-pulse-plan');
    const architectPulseAuthorityEl = document.getElementById('architect-pulse-authority');
    const chatLogEl = document.getElementById('chat-log');
    const architectWelcomeEl = document.getElementById('architect-welcome');
    const architectWelcomeSummaryEl = document.getElementById('architect-welcome-summary');
    const architectWelcomeWarningsEl = document.getElementById('architect-welcome-warnings');
    const architectWelcomeMissionsEl = document.getElementById('architect-welcome-missions');
    const architectWelcomeDismissEl = document.getElementById('architect-welcome-dismiss');
    const architectWelcomeReopenEl = document.getElementById('architect-welcome-reopen');
    const architectRepoSetupEl = document.getElementById('architect-repo-setup');
    const architectRepoSetupScopeEl = document.getElementById('architect-repo-setup-scope');
    const architectRepoSetupGridEl = document.getElementById('architect-repo-setup-grid');
    const architectRepoSetupStatusEl = document.getElementById('architect-repo-setup-status');
    const architectRepoAddEl = document.getElementById('architect-repo-add');
    const architectRepoSaveEl = document.getElementById('architect-repo-save');
    const architectRepoMapEl = document.getElementById('architect-repo-map');
    const architectRecipeGroupsEl = document.getElementById('architect-recipe-groups');
    const architectGuideLinkEl = document.getElementById('architect-guide-link');
    const chatFormEl = document.getElementById('chat-form');
    const chatInputEl = document.getElementById('chat-input');
    const chatScopePillEl = document.getElementById('chat-scope-pill');
    const chatSubmitEl = document.getElementById('chat-submit');
    const chatPauseEl = document.getElementById('chat-pause');
    const chatStopEl = document.getElementById('chat-stop');
    const chatProcessingLightEl = document.getElementById('chat-processing-light');
    const chatStatusEl = document.getElementById('chat-status');
    const chatAttachmentButtonEl = document.getElementById('chat-attachment-button');
    const chatTokenEconomyStatusEl = document.getElementById('chat-token-economy-status');
    const chatAttachmentInputEl = document.getElementById('chat-attachment-input');
    const chatAttachmentListEl = document.getElementById('chat-attachment-list');
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
    let activePlanSnapshot = null;
    let activeAttachmentCapabilities = { textAttachments: false, imageAttachments: false };
    let activeTokenEconomy = initialRuntimePayload && (initialRuntimePayload.architect_token_economy || (initialRuntimePayload.architect_llm && initialRuntimePayload.architect_llm.token_economy) || (activeArchitectRuntime && activeArchitectRuntime.token_economy)) || {};
    let pendingChatAttachments = [];
    let chatPromptHistory = [];
    let chatPromptHistoryCursor = -1;
    let chatPromptHistoryDraft = '';
    const architectControlStorageKey = 'architect.chat.controls.v1';
    const architectPromptHistoryStorageKey = 'architect.chat.prompt_history.v1';
    const architectPromptHistoryLimit = 100;
    const architectProviderSetupStorageKey = 'architect.provider.setup.suppressed.v1';
    const architectWelcomeStorageKey = 'architect.onboarding.welcome.dismissed.v1';
    const architectOnboardingVisitStorageKey = 'architect.onboarding.visit.v1';
    const architectOnboardingMissions = [
      { id: 'understand-project', title: 'Understand this project', artifact: 'Project overview with key modules, entry points, and suggested next tasks.', prompt: 'Explain what this project is and where to start. Produce a project overview with key modules, entry points, and suggested next tasks.', planBearing: false },
      { id: 'plan-feature', title: 'Plan a feature', artifact: 'Reviewable plan with scope, risks, slices, and verification path.', prompt: 'Help me plan a feature. Start by asking for the feature idea, then maintain a reviewable plan with scope, risks, slices, and verification path.', planBearing: true },
      { id: 'clean-prototype', title: 'Clean up a prototype', artifact: 'Ranked cleanup report with one bounded first slice.', prompt: 'Find the safest cleanup starting point. Produce a ranked cleanup report with one bounded first slice.', planBearing: true },
      { id: 'map-architecture', title: 'Map architecture and risks', artifact: 'Architecture and risk map grounded in graph evidence.', prompt: 'Map the important architecture and risks in this project. Produce an architecture and risk map grounded in graph evidence.', planBearing: true },
      { id: 'cross-repo', title: 'Work across repositories', artifact: 'Cross-repo inventory and dependency questions.', prompt: 'Explain how the connected repositories relate and what a change may touch. Produce a cross-repo inventory and dependency questions.', planBearing: false },
      { id: 'weekly-review', title: 'Set up weekly review', artifact: 'Scheduled review proposal and report preview.', prompt: 'Propose a weekly project review. Produce a scheduled review proposal and report preview before applying any schedule change.', planBearing: true },
    ];
    const architectRecipeGroups = [
      { title: 'Prototype or small app', recipes: [
        ['Explain this app before I change it', 'Project overview', 'Cite modules and entry points', false], ['Find the safest first cleanup', 'Ranked cleanup report', 'Name one bounded verified slice', true], ['Add a small feature with a plan', 'Implementation plan', 'Include build and test checks', true], ['Generate a missing README', 'README draft', 'Check commands against repository evidence', true], ['Prepare release notes', 'Release notes draft', 'Ground changes in repository history', false],
      ] },
      { title: 'Existing service or legacy repo', recipes: [
        ['Find entry points and runtime dependencies', 'Runtime inventory', 'Cite source files and config', false], ['Map API and data-model risks', 'API and data risk map', 'List evidence and open questions', true], ['Find stale docs before a migration', 'Documentation drift report', 'Cross-check docs against source', false], ['Propose the smallest verified repair', 'Bounded repair plan', 'Name the narrow verification command', true], ['Record an architecture decision', 'ADR proposal', 'State alternatives and guard rails', true],
      ] },
      { title: 'Multi-repo system', recipes: [
        ['Inventory repos and their roles', 'Cross-repo inventory', 'Use configured repository scope', false], ['Trace a concept across services', 'Cross-service trace', 'Cite each repository hop', false], ['Identify cross-repo change risks', 'Change-risk report', 'List affected repos and checks', true], ['Create a coordinated implementation plan', 'Multi-repo plan', 'Split verification by repo', true], ['Set up recurring architecture review', 'Review schedule proposal', 'Preview the report before scheduling', true],
      ] },
      { title: 'Plugin or tool integration', recipes: [
        ['Inventory available plugins and MCP tools', 'Capability inventory', 'Use daemon runtime facts', false], ['Inspect plugin trust and availability', 'Plugin trust report', 'Cite manifest and runtime state', false], ['Connect a local workflow', 'Workflow integration plan', 'Name governed actions and checks', true], ['Review tool traces and governed actions', 'Trace review', 'Separate evidence from convenience output', false],
      ] },
    ];
    const architectCenterTabContainer = document.getElementById('architect-center-tabs');
    const architectCenterPanelContainer = document.getElementById('architect-tab-panels');
    const architectTabAddButton = document.getElementById('architect-tab-add');
    const architectTabMenu = document.getElementById('architect-tab-menu');
    const architectCenterTabStorageKey = 'architect.center.tab.v1';
    let architectCenterTabs = [];
    let architectTabSequence = 0;
    let architectCodeEditorModulePromise = null;
${isArchitectDoomEnabled() ? "    let architectDoomRuntimePromise = null;\n" : ""}    const architectTabTypeRegistry = new Map();
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

    function registerArchitectTabType(descriptor) {
      if (!descriptor || !descriptor.type || typeof descriptor.create !== 'function') return;
      architectTabTypeRegistry.set(descriptor.type, descriptor);
    }

    function createBuiltInArchitectTab(id, title, type, panelId) {
      return {
        id: id,
        title: title,
        type: type,
        lifecycle: 'built-in',
        dirty: false,
        closeable: false,
        panelId: panelId,
      };
    }

    function createPluginArchitectTab(descriptor) {
      architectTabSequence += 1;
      const id = 'plugin-tab-' + architectTabSequence;
      return {
        id: id,
        title: descriptor.title,
        type: descriptor.id,
        lifecycle: 'plugin',
        dirty: false,
        closeable: true,
        panelId: 'architect-panel-' + id,
        pluginDescriptor: descriptor,
        pluginSnapshot: null,
      };
    }

    async function hydrateArchitectPluginTabTypes() {
      const response = await fetch('/api/architect/v1/plugin-tabs', { cache: 'no-store' });
      const payload = await response.json().catch(function() { return {}; });
      if (!response.ok || payload.ok === false) throw new Error(payload.message || 'Failed to load Architect plugin tabs.');
      for (const descriptor of Array.from(architectTabTypeRegistry.values())) {
        if (descriptor.lifecycle === 'plugin') architectTabTypeRegistry.delete(descriptor.type);
      }
      for (const descriptor of (Array.isArray(payload.tabs) ? payload.tabs : [])) {
        registerArchitectTabType({ type: descriptor.id, title: descriptor.title, lifecycle: 'plugin', create: function() { return createPluginArchitectTab(descriptor); } });
      }
      renderArchitectTabMenu();
    }

    async function loadArchitectPluginTabSnapshot(tab, panel) {
      resetNode(panel);
      const status = document.createElement('p');
      status.textContent = activePlanId ? 'Loading checklist...' : 'Select a plan to use this plugin tab.';
      panel.appendChild(status);
      if (!activePlanId) return;
      const response = await fetch('/api/architect/v1/plugin-tabs/' + encodeURIComponent(tab.type) + '/snapshot?planId=' + encodeURIComponent(activePlanId), { cache: 'no-store' });
      const payload = await response.json().catch(function() { return {}; });
      if (!response.ok || payload.ok === false) { status.textContent = payload.message || 'Plugin tab is unavailable.'; return; }
      tab.pluginSnapshot = payload.snapshot;
      const state = payload.snapshot && payload.snapshot.state || {};
      resetNode(pluginTabSummaryEl);
      if (state.summary && state.summary.label) appendChip(pluginTabSummaryEl, tab.title, state.summary.label, false);
      for (const badge of (Array.isArray(state.badges) ? state.badges : [])) appendChip(pluginTabSummaryEl, badge.id, badge.label || '', false);
      resetNode(panel);
      const heading = document.createElement('h2');
      heading.textContent = tab.title;
      panel.appendChild(heading);
      const summary = document.createElement('p');
      summary.className = 'muted';
      summary.textContent = state.summary && state.summary.label || 'Checklist state loaded from daemon.';
      panel.appendChild(summary);
      for (const badge of (Array.isArray(state.badges) ? state.badges : [])) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = badge.label || badge.id;
        panel.appendChild(chip);
      }
      const list = document.createElement('div');
      list.className = 'stack';
      for (const item of (Array.isArray(state.items) ? state.items : [])) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!item.completed;
        input.addEventListener('change', async function() {
          input.disabled = true;
          const actionResponse = await fetch('/api/architect/v1/plugin-tabs/' + encodeURIComponent(tab.type) + '/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planId: activePlanId, revision: state.revision || null, action: { type: 'toggle', itemId: item.id } }) });
          const actionPayload = await actionResponse.json().catch(function() { return {}; });
          if (!actionResponse.ok || actionPayload.ok === false) { status.textContent = actionPayload.message || 'Checklist action failed.'; input.disabled = false; return; }
          await loadArchitectPluginTabSnapshot(tab, panel);
        });
        label.appendChild(input);
        label.appendChild(document.createTextNode(' ' + item.label));
        list.appendChild(label);
      }
      panel.appendChild(list);
    }

    function refreshOpenArchitectPluginTabs() {
      for (const tab of architectCenterTabs) {
        if (tab.lifecycle !== 'plugin') continue;
        const panel = document.getElementById(tab.panelId);
        if (panel) void loadArchitectPluginTabSnapshot(tab, panel);
      }
    }

    function createTerminalArchitectTab() {
      architectTabSequence += 1;
      const id = 'terminal-tab-' + architectTabSequence;
      return {
        id: id,
        title: 'Terminal ' + architectTabSequence,
        type: 'terminal',
        lifecycle: 'dynamic',
        dirty: true,
        closeable: true,
        panelId: 'architect-panel-' + id,
        terminalSessionId: null,
        terminalSocket: null,
        terminalSocketReady: false,
        terminalXterm: null,
        terminalFitAddon: null,
        terminalResizeObserver: null,
        terminalResizeTimer: 0,
        terminalResizeListener: null,
        terminalInputDisposable: null,
        terminalScheduleFit: null,
        terminalBlurListener: null,
      };
    }

    /* architect-doom-script:start */
    function createDoomArchitectTab() {
      architectTabSequence += 1;
      const id = 'doom-tab-' + architectTabSequence;
      return {
        id: id,
        title: 'Doom Session ' + architectTabSequence,
        type: 'doom',
        lifecycle: 'dynamic',
        dirty: false,
        closeable: true,
        panelId: 'architect-panel-' + id,
        doomProps: null,
        doomBundleUrl: null,
        doomMuted: false,
        doomPaused: false,
        doomSuspended: false,
        doomLifecyclePromise: Promise.resolve(),
        doomRoot: null,
        doomStatus: null,
        destroy: null,
      };
    }

    function loadArchitectDoomRuntime() {
      if (architectDoomRuntimePromise) return architectDoomRuntimePromise;
      architectDoomRuntimePromise = new Promise(function(resolve, reject) {
        if (window.Dos) { resolve(window.Dos); return; }
        const script = document.createElement('script');
        script.src = '/api/architect/v1/assets/js-dos/js-dos.js';
        script.async = true;
        script.onload = function() { window.Dos ? resolve(window.Dos) : reject(new Error('js-dos did not initialize.')); };
        script.onerror = function() { reject(new Error('Local js-dos runtime failed to load.')); };
        document.head.appendChild(script);
      }).catch(function(error) {
        architectDoomRuntimePromise = null;
        throw error;
      });
      return architectDoomRuntimePromise;
    }

    function setArchitectDoomPaused(tab, paused, message) {
      tab.doomPaused = paused;
      if (tab.doomProps && typeof tab.doomProps.setPaused === 'function') tab.doomProps.setPaused(paused);
      if (tab.doomStatus && message) tab.doomStatus.textContent = message;
    }

    async function stopArchitectDoomTab(tab, message) {
      const active = tab.doomProps;
      tab.doomProps = null;
      if (active && typeof active.stop === 'function') await active.stop();
      if (tab.doomRoot) tab.doomRoot.replaceChildren();
      if (tab.doomStatus && message) tab.doomStatus.textContent = message;
    }

    function queueArchitectDoomTask(tab, task) {
      tab.doomLifecyclePromise = (tab.doomLifecyclePromise || Promise.resolve()).catch(function() { /* prior lifecycle failure is already surfaced */ }).then(task);
      return tab.doomLifecyclePromise;
    }

    function suspendArchitectDoomTab(tab) {
      if (!tab || !tab.doomProps || tab.doomSuspended) return;
      tab.doomSuspended = true;
      setArchitectDoomPaused(tab, true, 'Stopping Doom while tab is inactive...');
      void queueArchitectDoomTask(tab, function() { return stopArchitectDoomTab(tab, 'Stopped while tab is inactive. Switch back to restart.'); }).catch(function(error) {
        if (tab.doomStatus) tab.doomStatus.textContent = error.message || 'Failed to stop inactive Doom session.';
      });
    }

    function resumeArchitectDoomTab(tab) {
      if (!tab || !tab.doomSuspended || !tab.doomBundleUrl) return;
      tab.doomSuspended = false;
      void queueArchitectDoomTask(tab, function() { return startArchitectDoomTab(tab); }).catch(function(error) {
        if (tab.doomStatus) tab.doomStatus.textContent = error.message || 'Failed to restart Doom session.';
      });
    }

    async function startArchitectDoomTab(tab) {
      if (!tab.doomBundleUrl) throw new Error('Download Doom Shareware first.');
      await stopArchitectDoomTab(tab, 'Starting Doom Shareware...');
      const Dos = await loadArchitectDoomRuntime();
      tab.doomPaused = false;
      tab.doomSuspended = false;
      tab.doomProps = Dos(tab.doomRoot, {
        url: tab.doomBundleUrl,
        pathPrefix: '/api/architect/v1/assets/js-dos/emulators/',
        autoStart: true,
        noNetworking: true,
        noCloud: true,
        onEvent: function(event) {
          if (event === 'ci-ready' && tab.doomStatus) tab.doomStatus.textContent = 'Playing. Click the game to use the keyboard.';
        },
      });
      if (tab.doomMuted && typeof tab.doomProps.setVolume === 'function') tab.doomProps.setVolume(0);
    }

    async function readArchitectDoomBundlePayload(response, fallbackMessage) {
      const payload = await response.json().catch(function() { return {}; });
      if (!response.ok || payload.ok === false) throw new Error(payload.message || fallbackMessage);
      return payload;
    }

    async function reloadDoomArchitectTabPanel(tab) {
      await stopArchitectDoomTab(tab, 'Reloading Doom tab...');
      const panel = document.getElementById(tab.panelId);
      if (!panel) return;
      panel.replaceChildren();
      tab.doomRoot = null;
      tab.doomStatus = null;
      renderDoomArchitectTabPanel(tab, panel);
    }

    function updateArchitectDoomDownloadProgress(download, progress, status) {
      if (!download || download.state !== 'downloading') return;
      const downloadedBytes = Number(download.downloaded_bytes) || 0;
      const totalBytes = Number(download.total_bytes) || 0;
      progress.hidden = false;
      if (totalBytes > 0) {
        progress.value = Math.min(100, Math.round(downloadedBytes * 100 / totalBytes));
        status.textContent = 'Downloading Doom Shareware... ' + progress.value + '%';
      } else {
        progress.removeAttribute('value');
        status.textContent = 'Downloading Doom Shareware...';
      }
    }

    async function loadArchitectDoomRecommendedBundleStatus(tab, card, approve, progress, status) {
      try {
        const payload = await readArchitectDoomBundlePayload(await fetch('/api/architect/v1/doom/spike-bundle/status', { cache: 'no-store' }), 'Failed to check the Doom Shareware download.');
        if (payload.bundle && payload.bundle.acquired === true) {
          tab.doomBundleUrl = payload.bundle.local_bundle_url;
          card.hidden = true;
          status.textContent = 'Ready. Click Start to play.';
          return;
        }
        card.hidden = false;
        approve.disabled = Boolean(payload.bundle && payload.bundle.download && payload.bundle.download.state === 'downloading');
        updateArchitectDoomDownloadProgress(payload.bundle && payload.bundle.download, progress, status);
        if (!approve.disabled) status.textContent = '';
      } catch (error) {
        card.hidden = false;
        approve.disabled = true;
        status.textContent = error.message || 'Failed to check the Doom Shareware download.';
      }
    }

    function renderDoomArchitectTabPanel(tab, panel) {
      const heading = document.createElement('h2');
      heading.textContent = tab.title;
      const surface = document.createElement('div');
      surface.className = 'doom-surface';
      const toolbar = document.createElement('div');
      toolbar.className = 'doom-toolbar';
      const recommended = document.createElement('div');
      recommended.className = 'doom-first-run-card';
      const recommendedText = document.createElement('span');
      recommendedText.textContent = 'Download Doom Shareware to start playing.';
      const approveRecommended = document.createElement('button');
      approveRecommended.type = 'button';
      approveRecommended.textContent = 'Download Doom Shareware';
      const downloadProgress = document.createElement('progress');
      downloadProgress.max = 100;
      downloadProgress.hidden = true;
      downloadProgress.setAttribute('aria-label', 'Doom Shareware download progress');
      recommended.appendChild(recommendedText);
      recommended.appendChild(approveRecommended);
      recommended.appendChild(downloadProgress);
      const start = document.createElement('button');
      start.type = 'button';
      start.textContent = 'Start';
      const pause = document.createElement('button');
      pause.type = 'button';
      pause.textContent = 'Pause';
      const resume = document.createElement('button');
      resume.type = 'button';
      resume.textContent = 'Resume';
      const mute = document.createElement('button');
      mute.type = 'button';
      mute.textContent = 'Mute';
      const fullscreen = document.createElement('button');
      fullscreen.type = 'button';
      fullscreen.textContent = 'Fullscreen';
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.textContent = 'Reset';
      const close = document.createElement('button');
      close.type = 'button';
      close.textContent = 'Close Session';
      const status = document.createElement('span');
      status.textContent = 'Loading...';
      const root = document.createElement('div');
      root.className = 'doom-viewport';
      root.setAttribute('aria-label', 'Doom Shareware viewport');
      toolbar.appendChild(start);
      toolbar.appendChild(pause);
      toolbar.appendChild(resume);
      toolbar.appendChild(mute);
      toolbar.appendChild(fullscreen);
      toolbar.appendChild(reset);
      toolbar.appendChild(close);
      toolbar.appendChild(status);
      surface.appendChild(recommended);
      surface.appendChild(toolbar);
      surface.appendChild(root);
      panel.appendChild(heading);
      panel.appendChild(surface);
      tab.doomRoot = root;
      tab.doomStatus = status;
      void loadArchitectDoomRecommendedBundleStatus(tab, recommended, approveRecommended, downloadProgress, status);
      approveRecommended.addEventListener('click', function() {
        approveRecommended.disabled = true;
        downloadProgress.hidden = false;
        downloadProgress.removeAttribute('value');
        status.textContent = 'Downloading Doom Shareware...';
        const progressTimer = window.setInterval(function() {
          fetch('/api/architect/v1/doom/spike-bundle/status', { cache: 'no-store' }).then(function(response) {
            return readArchitectDoomBundlePayload(response, 'Failed to read Doom Shareware download progress.');
          }).then(function(payload) {
            updateArchitectDoomDownloadProgress(payload.bundle && payload.bundle.download, downloadProgress, status);
          }).catch(function() { /* acquisition request surfaces the terminal error */ });
        }, 250);
        fetch('/api/architect/v1/doom/spike-bundle/acquire', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approved: true }),
        }).then(function(response) {
          return readArchitectDoomBundlePayload(response, 'Failed to download Doom Shareware.');
        }).then(function() {
          window.clearInterval(progressTimer);
          return reloadDoomArchitectTabPanel(tab);
        }).catch(function(error) {
          window.clearInterval(progressTimer);
          approveRecommended.disabled = false;
          status.textContent = error.message || 'Failed to download Doom Shareware.';
        });
      });
      start.addEventListener('click', function() { startArchitectDoomTab(tab).catch(function(error) { status.textContent = error.message || 'Failed to start Doom Shareware.'; }); });
      pause.addEventListener('click', function() { setArchitectDoomPaused(tab, true, 'Paused.'); });
      resume.addEventListener('click', function() { setArchitectDoomPaused(tab, false, 'Resumed.'); });
      mute.addEventListener('click', function() { tab.doomMuted = !tab.doomMuted; if (tab.doomProps && typeof tab.doomProps.setVolume === 'function') tab.doomProps.setVolume(tab.doomMuted ? 0 : 1); mute.textContent = tab.doomMuted ? 'Unmute' : 'Mute'; });
      fullscreen.addEventListener('click', function() { if (tab.doomProps && typeof tab.doomProps.setFullScreen === 'function') tab.doomProps.setFullScreen(true); });
      reset.addEventListener('click', function() { startArchitectDoomTab(tab).catch(function(error) { status.textContent = error.message || 'Failed to reset Doom Shareware.'; }); });
      close.addEventListener('click', function() { closeArchitectCenterTab(tab.id); });
      tab.destroy = function() { void stopArchitectDoomTab(tab, 'Closed.'); tab.doomRoot = null; tab.doomStatus = null; };
    }
    /* architect-doom-script:end */

    function createCodeEditorArchitectTab() {
      architectTabSequence += 1;
      const id = 'code-editor-tab-' + architectTabSequence;
      return {
        id: id,
        title: 'Code Editor ' + architectTabSequence,
        type: 'code-editor',
        lifecycle: 'dynamic',
        dirty: false,
        closeable: true,
        panelId: 'architect-panel-' + id,
        repoId: '',
        filePath: '',
        displayName: '',
        language: 'plaintext',
        monacoModelKey: '',
        loadState: 'idle',
        saveState: 'idle',
        lastKnownRevision: '',
        treeExpanded: {},
        destroy: null,
      };
    }

    function loadArchitectCodeEditorModule() {
      if (!architectCodeEditorModulePromise) {
        const moduleLines = [
          "function setSurfaceText(node, value) { if (node) node.textContent = value || ''; }",
          "function resetNode(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }",
          "function normalizeOptionsTab(tab) { if (!tab) throw new Error('Missing code editor tab state.'); return tab; }",
          "async function readJsonResponse(response, fallbackMessage) { const payload = await response.json().catch(function() { return {}; }); if (!response.ok || payload.ok === false) throw new Error(payload.message || fallbackMessage); return payload; }",
          "async function postEditorJson(path, body, fallbackMessage) { const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return readJsonResponse(response, fallbackMessage); }",
          "let architectMonacoPromise = null;",
          "let architectLucidePromise = null;",
          "function ensureArchitectLucide(root) {",
          "  if (window.lucide && typeof window.lucide.createIcons === 'function') { window.lucide.createIcons({ root: root || document }); return Promise.resolve(window.lucide); }",
          "  if (architectLucidePromise) return architectLucidePromise.then(function(lucide) { lucide.createIcons({ root: root || document }); return lucide; });",
          "  architectLucidePromise = new Promise(function(resolve, reject) {",
          "    const script = document.createElement('script');",
          "    script.src = '/api/architect/v1/assets/lucide/lucide.js';",
          "    script.async = true;",
          "    script.onload = function() { if (!window.lucide) { reject(new Error('Lucide did not initialize.')); return; } window.lucide.createIcons({ root: root || document }); resolve(window.lucide); };",
          "    script.onerror = function() { reject(new Error('Lucide icons failed to load.')); };",
          "    document.head.appendChild(script);",
          "  });",
          "  return architectLucidePromise;",
          "}",
          "function setIconButton(button, icon, label) { button.textContent = ''; button.title = label; button.setAttribute('aria-label', label); const marker = document.createElement('i'); marker.setAttribute('data-lucide', icon); marker.setAttribute('aria-hidden', 'true'); marker.style.width = '16px'; marker.style.height = '16px'; button.appendChild(marker); }",
          "function ensureArchitectMonaco() {",
          "  if (window.monaco && window.monaco.editor) return Promise.resolve(window.monaco);",
          "  if (architectMonacoPromise) return architectMonacoPromise;",
          "  architectMonacoPromise = new Promise(function(resolve, reject) {",
          "    const finish = function() { try { window.require.config({ paths: { vs: '/api/architect/v1/assets/monaco/vs' } }); window.require(['vs/editor/editor.main'], function() { resolve(window.monaco); }, reject); } catch (error) { reject(error); } };",
          "    if (window.require) { finish(); return; }",
          "    const script = document.createElement('script');",
          "    script.src = '/api/architect/v1/assets/monaco/vs/loader.js';",
          "    script.async = true;",
          "    script.onload = finish;",
          "    script.onerror = function() { reject(new Error('Monaco loader failed.')); };",
          "    document.head.appendChild(script);",
          "  });",
          "  return architectMonacoPromise;",
          "}",
          "export async function mountCodeEditorArchitectTab(options) {",
          "  const tab = normalizeOptionsTab(options.tab);",
          "  const panel = options.panel;",
          "  if (!panel) throw new Error('Missing code editor panel.');",
          "  if (tab.__codeEditorMounted) return;",
          "  tab.__codeEditorMounted = true;",
          "  tab.treeExpanded = tab.treeExpanded || {};",
          "  panel.textContent = '';",
          "  panel.style.padding = '0';",
          "  panel.style.overflow = 'hidden';",
          "  const root = document.createElement('div');",
          "  root.className = 'code-editor-root';",
          "  root.style.display = 'grid';",
          "  root.style.gridTemplateRows = 'auto minmax(0, 1fr) auto';",
          "  root.style.height = '100%';",
          "  root.style.minHeight = '0';",
          "  root.style.gap = '5px';",
          "  root.style.padding = '6px';",
          "  const toolbar = document.createElement('div');",
          "  toolbar.className = 'terminal-toolbar';",
          "  toolbar.style.gap = '5px';",
          "  toolbar.style.flexWrap = 'nowrap';",
          "  const repoSelect = document.createElement('select');",
          "  repoSelect.className = 'mini-button';",
          "  repoSelect.setAttribute('aria-label', 'Repository');",
          "  const refreshButton = document.createElement('button');",
          "  refreshButton.type = 'button';",
          "  refreshButton.className = 'mini-button';",
          "  setIconButton(refreshButton, 'refresh-cw', 'Refresh tree');",
          "  const revealButton = document.createElement('button');",
          "  revealButton.type = 'button';",
          "  revealButton.className = 'mini-button';",
          "  setIconButton(revealButton, 'locate-fixed', 'Reveal current file');",
          "  const currentFile = document.createElement('span');",
          "  currentFile.className = 'meta';",
          "  currentFile.style.overflow = 'hidden';",
          "  currentFile.style.textOverflow = 'ellipsis';",
          "  currentFile.style.whiteSpace = 'nowrap';",
          "  currentFile.style.minWidth = '0';",
          "  currentFile.style.flex = '1 1 180px';",
          "  const saveButton = document.createElement('button');",
          "  saveButton.type = 'button';",
          "  saveButton.className = 'mini-button';",
          "  setIconButton(saveButton, 'save', 'Save file');",
          "  toolbar.appendChild(repoSelect);",
          "  toolbar.appendChild(refreshButton);",
          "  toolbar.appendChild(revealButton);",
          "  toolbar.appendChild(currentFile);",
          "  toolbar.appendChild(saveButton);",
          "  const workspace = document.createElement('div');",
          "  workspace.style.display = 'grid';",
          "  workspace.style.gridTemplateColumns = 'minmax(160px, ' + String(tab.treeWidth || 260) + 'px) 6px minmax(0, 1fr)';",
          "  workspace.style.minHeight = '0';",
          "  workspace.style.gap = '0';",
          "  const treePane = document.createElement('div');",
          "  treePane.style.minHeight = '0';",
          "  treePane.style.overflow = 'auto';",
          "  treePane.style.borderRight = '1px solid rgba(148, 163, 184, 0.22)';",
          "  treePane.style.padding = '18px 4px 4px 0';",
          "  treePane.style.position = 'relative';",
          "  const treeCollapseButton = document.createElement('button');",
          "  treeCollapseButton.type = 'button';",
          "  treeCollapseButton.className = 'mini-button';",
          "  treeCollapseButton.style.position = 'absolute';",
          "  treeCollapseButton.style.top = '0';",
          "  treeCollapseButton.style.right = '4px';",
          "  treeCollapseButton.style.width = '20px';",
          "  treeCollapseButton.style.height = '18px';",
          "  treeCollapseButton.style.padding = '0';",
          "  setIconButton(treeCollapseButton, 'panel-left-close', 'Collapse repository explorer');",
          "  treePane.appendChild(treeCollapseButton);",
          "  const treeContent = document.createElement('div');",
          "  treePane.appendChild(treeContent);",
          "  const treeResizeHandle = document.createElement('div');",
          "  treeResizeHandle.setAttribute('role', 'separator');",
          "  treeResizeHandle.setAttribute('aria-orientation', 'vertical');",
          "  treeResizeHandle.title = 'Resize repository explorer';",
          "  treeResizeHandle.style.cursor = 'col-resize';",
          "  treeResizeHandle.style.background = 'rgba(148, 163, 184, 0.18)';",
          "  treeResizeHandle.style.width = '1px';",
          "  treeResizeHandle.style.margin = '0 2px';",
          "  const editorPane = document.createElement('div');",
          "  editorPane.style.minHeight = '0';",
          "  editorPane.style.display = 'grid';",
          "  editorPane.style.gridTemplateRows = 'minmax(0, 1fr)';",
          "  editorPane.style.position = 'relative';",
          "  const monacoMount = document.createElement('div');",
          "  monacoMount.style.minHeight = '0';",
          "  monacoMount.style.height = '100%';",
          "  monacoMount.style.width = '100%';",
          "  const emptyState = document.createElement('div');",
          "  emptyState.className = 'meta';",
          "  emptyState.textContent = 'Select a file from the daemon-governed tree.';",
          "  emptyState.style.position = 'absolute';",
          "  emptyState.style.inset = '12px';",
          "  const textarea = document.createElement('textarea');",
          "  textarea.className = 'chat-input';",
          "  textarea.spellcheck = false;",
          "  textarea.style.display = 'none';",
          "  textarea.style.height = '100%';",
          "  textarea.style.minHeight = '0';",
          "  textarea.style.resize = 'none';",
          "  textarea.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';",
          "  textarea.disabled = true;",
          "  editorPane.appendChild(monacoMount);",
          "  editorPane.appendChild(emptyState);",
          "  editorPane.appendChild(textarea);",
          "  workspace.appendChild(treePane);",
          "  workspace.appendChild(treeResizeHandle);",
          "  workspace.appendChild(editorPane);",
          "  const status = document.createElement('div');",
          "  status.className = 'meta';",
          "  status.textContent = 'Loading editor repositories...';",
          "  root.appendChild(toolbar);",
          "  root.appendChild(workspace);",
          "  root.appendChild(status);",
          "  panel.appendChild(root);",
          "  function refreshTab() { if (typeof options.refreshTabs === 'function') options.refreshTabs(tab.id); }",
          "  function selectedRepo() { return repoSelect.value || tab.repoId || ''; }",
          "  function applyTreeLayout() { workspace.style.gridTemplateColumns = tab.treeCollapsed ? '24px 0 minmax(0, 1fr)' : 'minmax(160px, ' + String(tab.treeWidth || 260) + 'px) 6px minmax(0, 1fr)'; treeContent.hidden = tab.treeCollapsed === true; treeResizeHandle.hidden = tab.treeCollapsed === true; treeCollapseButton.title = tab.treeCollapsed ? 'Expand repository explorer' : 'Collapse repository explorer'; treeCollapseButton.setAttribute('aria-label', treeCollapseButton.title); setIconButton(treeCollapseButton, tab.treeCollapsed ? 'panel-left-open' : 'panel-left-close', treeCollapseButton.title); ensureArchitectLucide(root).catch(function() {}); }",
          "  function syncTitle() {",
          "    const name = tab.filePath ? (tab.displayName || tab.filePath.split('/').pop()) : 'Code Editor';",
          "    tab.title = name || 'Code Editor';",
          "    currentFile.textContent = tab.filePath ? (tab.repoId + ' / ' + tab.filePath + (tab.dirty ? ' *' : '')) : 'No file selected';",
          "    refreshTab();",
          "  }",
          "  function setDirty(nextDirty) { tab.dirty = nextDirty === true; syncTitle(); }",
          "  function updateActiveTreeItem() {",
          "    Array.from(treePane.querySelectorAll('[data-editor-file-path]')).forEach(function(node) {",
          "      const active = node.dataset.editorFilePath === tab.filePath;",
          "      node.style.background = active ? 'rgba(96, 165, 250, 0.18)' : 'transparent';",
          "      node.style.color = active ? '#dbeafe' : '';",
          "    });",
          "  }",
          "  function currentEditorText() { return tab.monacoModel ? tab.monacoModel.getValue() : textarea.value; }",
          "  function showUnsupportedFileState() {",
          "    disposeEditorModel();",
          "    if (tab.monacoEditor) tab.monacoEditor.setModel(null);",
          "    textarea.value = '';",
          "    textarea.disabled = true;",
          "    textarea.style.display = 'none';",
          "    emptyState.hidden = false;",
          "    emptyState.textContent = 'The file is not displayed in the text editor because it is either binary or uses an unsupported text encoding.'; const open = document.createElement('button'); open.type = 'button'; open.className = 'mini-button'; open.textContent = 'Open Anyway'; open.style.marginTop = '8px'; open.addEventListener('click', function() { tab.openAnywayFilePath = tab.filePath; loadFile(tab.filePath).catch(function(error) { setSurfaceText(status, error && error.message ? error.message : String(error)); }); }); emptyState.appendChild(document.createElement('br')); emptyState.appendChild(open);",
          "    saveButton.disabled = true;",
          "  }",
          "  function disposeEditorModel() {",
          "    if (tab.monacoChangeDisposable && typeof tab.monacoChangeDisposable.dispose === 'function') tab.monacoChangeDisposable.dispose();",
          "    tab.monacoChangeDisposable = null;",
          "    if (tab.monacoModel && typeof tab.monacoModel.dispose === 'function') tab.monacoModel.dispose();",
          "    tab.monacoModel = null;",
          "  }",
          "  async function bindEditorContent(content) {",
          "    textarea.value = content;",
          "    textarea.disabled = false;",
          "    emptyState.hidden = true;",
          "    const monaco = await ensureArchitectMonaco();",
          "    disposeEditorModel();",
          "    const uriPath = encodeURIComponent(tab.id) + '/' + tab.filePath.split('/').map(encodeURIComponent).join('/');",
          "    const uri = monaco.Uri.parse('dreamgraph-editor:///' + uriPath);",
          "    tab.monacoModel = monaco.editor.createModel(content, tab.language || 'plaintext', uri);",
          "    if (monaco.editor && typeof monaco.editor.setTheme === 'function') monaco.editor.setTheme('vs-dark');",
          "    if (!tab.monacoEditor) {",
          "      tab.monacoEditor = monaco.editor.create(monacoMount, { model: tab.monacoModel, theme: 'vs-dark', automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false, fontSize: 13 });",
          "      if (monaco.KeyMod && monaco.KeyCode && typeof tab.monacoEditor.addCommand === 'function') tab.monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, triggerSaveCommand);",
          "    } else {",
          "      tab.monacoEditor.setModel(tab.monacoModel);",
          "      tab.monacoEditor.layout();",
          "    }",
          "    tab.monacoChangeDisposable = tab.monacoModel.onDidChangeContent(function() { textarea.value = tab.monacoModel.getValue(); saveButton.disabled = false; setDirty(true); });",
          "  }",
          "  async function loadFile(filePath) {",
          "    const repo = selectedRepo();",
          "    if (!repo || !filePath) throw new Error('Repo and file path are required.');",
          "    tab.loadState = 'loading';",
          "    status.textContent = 'Loading ' + filePath + ' from daemon...';",
          "    const payload = await postEditorJson('/api/architect/v1/editor/file/load', { repo: repo, file_path: filePath, open_anyway: tab.openAnywayFilePath === filePath }, 'Editor load failed.');",
          "    const file = payload.file || {};",
          "    tab.repoId = String(file.repo || repo);",
          "    tab.filePath = String(file.file_path || filePath);",
          "    tab.displayName = String(file.display_name || tab.filePath.split('/').pop() || tab.filePath);",
          "    tab.language = String(file.language || 'plaintext');",
          "    tab.lastKnownRevision = String(file.revision || '');",
          "    tab.monacoModelKey = tab.repoId + ':' + tab.filePath;",
          "    if (file.unsupported_text_editor && tab.openAnywayFilePath !== tab.filePath) { showUnsupportedFileState(); tab.loadState = 'unsupported'; revealButton.disabled = false; setDirty(false); updateActiveTreeItem(); status.textContent = 'Unsupported file: ' + tab.filePath; return; }",
          "    tab.openAnywayFilePath = '';",
          "    await bindEditorContent(String(file.content || ''));",
          "    tab.loadState = 'loaded';",
          "    revealButton.disabled = false;",
          "    setDirty(false);",
          "    updateActiveTreeItem();",
          "    status.textContent = 'Loaded ' + tab.filePath + ' | ' + tab.language;",
          "  }",
          "  function renderTreeNode(node, depth, parent) {",
          "    const row = document.createElement('div');",
          "    row.role = 'button';",
          "    row.tabIndex = 0;",
          "    row.style.display = 'block';",
          "    row.style.width = '100%';",
          "    row.style.textAlign = 'left';",
          "    row.style.margin = '0';",
          "    row.style.padding = '1px 4px 1px ' + String(4 + depth * 13) + 'px';",
          "    row.style.borderRadius = '3px';",
          "    row.style.cursor = 'default';",
          "    row.style.font = '0.72rem/1.25 var(--data-font, monospace)';",
          "    row.style.opacity = node.hidden ? '0.48' : '1';",
          "    row.textContent = (node.kind === 'directory' ? (tab.treeExpanded[node.path] ? 'v ' : '> ') : '  ') + String(node.name || node.path);",
          "    if (node.kind === 'file') row.dataset.editorFilePath = String(node.path || '');",
          "    parent.appendChild(row);",
          "    const children = document.createElement('div');",
          "    parent.appendChild(children);",
          "    function activateRow() {",
          "      if (node.kind === 'directory') {",
          "        const path = String(node.path || '');",
          "        if (tab.treeExpanded[path]) { delete tab.treeExpanded[path]; resetNode(children); row.textContent = '> ' + String(node.name || path || '.'); return; }",
          "        tab.treeExpanded[path] = true; row.textContent = 'v ' + String(node.name || path || '.');",
          "        loadTree(path, children, depth + 1).catch(function(error) { setSurfaceText(status, error && error.message ? error.message : String(error)); });",
          "        return;",
          "      }",
          "      loadFile(String(node.path || '')).catch(function(error) { tab.loadState = 'error'; setSurfaceText(status, error && error.message ? error.message : String(error)); });",
          "    }",
          "    row.addEventListener('click', activateRow);",
          "    row.addEventListener('keydown', function(event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activateRow(); } });",
          "  }",
          "  async function loadTree(path, container, depth) {",
          "    const repo = selectedRepo();",
          "    if (!repo) throw new Error('Repository is required.');",
          "    resetNode(container);",
          "    const pending = document.createElement('div');",
          "    pending.className = 'meta';",
          "    pending.textContent = 'Loading...';",
          "    container.appendChild(pending);",
          "    const payload = await postEditorJson('/api/architect/v1/editor/tree', { repo: repo, path: path || '' }, 'Editor tree load failed.');",
          "    resetNode(container);",
          "    const tree = payload.tree || {};",
          "    const children = Array.isArray(tree.children) ? tree.children : [];",
          "    if (!children.length) { const empty = document.createElement('div'); empty.className = 'meta'; empty.textContent = 'No files.'; container.appendChild(empty); return; }",
          "    children.forEach(function(child) { renderTreeNode(child, depth || 0, container); });",
          "    updateActiveTreeItem();",
          "  }",
          "  async function loadRepos() {",
          "    const response = await fetch('/api/architect/v1/editor/repos');",
          "    const payload = await readJsonResponse(response, 'Failed to load repos.');",
          "    repoSelect.textContent = '';",
          "    const repos = Array.isArray(payload.repos) ? payload.repos : [];",
          "    repos.forEach(function(repo, index) {",
          "      const option = document.createElement('option');",
          "      option.value = String(repo.id || '');",
          "      option.textContent = String(repo.display_name || repo.name || repo.id || 'repo');",
          "      if (!tab.repoId && index === 0) tab.repoId = option.value;",
          "      if (tab.repoId === option.value) option.selected = true;",
          "      repoSelect.appendChild(option);",
          "    });",
          "    repoSelect.hidden = false;",
          "    refreshButton.disabled = repos.length === 0;",
          "    treeCollapseButton.disabled = repos.length === 0;",
          "    revealButton.disabled = true;",
          "    saveButton.disabled = true;",
          "    if (!repos.length) { status.textContent = 'No configured repos available.'; return; }",
          "    repoSelect.value = tab.repoId || repoSelect.value;",
          "    status.textContent = 'Select a file from the daemon-governed tree.';",
          "    await loadTree('', treeContent, 0);",
          "  }",
          "  function applyGraphScanResult(scan) {",
          "    if (!scan || String(scan.repoId || '') !== String(tab.repoId || '') || String(scan.filePath || '') !== String(tab.filePath || '')) return;",
          "    if (scan.type === 'graph.file_scan_failed') {",
          "      tab.saveState = 'scan-failed';",
          "      status.textContent = 'Saved ' + tab.filePath + ' ✓ | Graph scan failed';",
          "      return;",
          "    }",
          "    tab.saveState = 'scan-complete';",
          "    status.textContent = 'Saved ' + tab.filePath + ' ✓ | Graph updated ✓ (' + String(scan.nodesUpdated || 0) + ' nodes, ' + String(scan.relationshipsUpdated || 0) + ' relationships)';",
          "  }",
          "  async function saveFile() {",
          "    const repo = selectedRepo();",
          "    const filePath = tab.filePath;",
          "    if (!repo || !filePath) throw new Error('A loaded file is required before save.');",
          "    tab.saveState = 'saving';",
          "    status.textContent = 'Saving ' + filePath + ' through daemon...';",
          "    const payload = await postEditorJson('/api/architect/v1/editor/file/save', { repo: repo, file_path: filePath, content: currentEditorText(), revision: tab.lastKnownRevision }, 'Editor save failed.');",
          "    const result = payload.result || {};",
          "    tab.repoId = String(result.repo || repo);",
          "    tab.filePath = String(result.file_path || filePath);",
          "    tab.displayName = String(result.display_name || tab.filePath.split('/').pop() || tab.filePath);",
          "    tab.lastKnownRevision = String(result.revision || tab.lastKnownRevision || '');",
          "    tab.saveState = 'scanning';",
          "    setDirty(false);",
          "    status.textContent = 'Saved ' + tab.filePath + ' ✓ | Graph scanning...';",
          "    if (result.graph_sync && result.graph_sync.event) applyGraphScanResult(result.graph_sync.event);",
          "  }",
          "  function triggerSaveCommand() { saveFile().catch(function(error) { tab.saveState = 'idle'; setSurfaceText(status, error && error.message ? error.message : String(error)); }); }",
          "  textarea.addEventListener('input', function() { saveButton.disabled = false; setDirty(true); });",
          "  textarea.addEventListener('keydown', function(event) { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); triggerSaveCommand(); } });",
          "  repoSelect.addEventListener('change', function() { tab.repoId = repoSelect.value; tab.filePath = ''; tab.displayName = ''; tab.lastKnownRevision = ''; tab.monacoModelKey = ''; tab.treeExpanded = {}; tab.openAnywayFilePath = ''; textarea.value = ''; textarea.disabled = true; emptyState.hidden = false; saveButton.disabled = true; revealButton.disabled = true; disposeEditorModel(); if (tab.monacoEditor) tab.monacoEditor.setModel(null); setDirty(false); loadTree('', treeContent, 0).catch(function(error) { setSurfaceText(status, error && error.message ? error.message : String(error)); }); });",
          "  refreshButton.addEventListener('click', function() { loadTree('', treeContent, 0).catch(function(error) { setSurfaceText(status, error && error.message ? error.message : String(error)); }); });",
          "  revealButton.addEventListener('click', function() { const active = treePane.querySelector('[data-editor-file-path=\\\"' + tab.filePath.replace(/\\\"/g, '\\\\\\\"') + '\\\"]'); if (active && typeof active.scrollIntoView === 'function') active.scrollIntoView({ block: 'center' }); });",
          "  treeCollapseButton.addEventListener('click', function() { tab.treeCollapsed = !tab.treeCollapsed; applyTreeLayout(); });",
          "  treeResizeHandle.addEventListener('pointerdown', function(event) { event.preventDefault(); treeResizeHandle.setPointerCapture(event.pointerId); const startX = event.clientX; const startWidth = tab.treeWidth || treePane.getBoundingClientRect().width || 260; const onMove = function(moveEvent) { tab.treeWidth = Math.max(160, Math.min(520, startWidth + moveEvent.clientX - startX)); tab.treeCollapsed = false; applyTreeLayout(); }; const onUp = function() { treeResizeHandle.removeEventListener('pointermove', onMove); treeResizeHandle.removeEventListener('pointerup', onUp); treeResizeHandle.removeEventListener('pointercancel', onUp); }; treeResizeHandle.addEventListener('pointermove', onMove); treeResizeHandle.addEventListener('pointerup', onUp); treeResizeHandle.addEventListener('pointercancel', onUp); });",
          "  saveButton.addEventListener('click', triggerSaveCommand);",
          "  const graphScanListener = function(event) { applyGraphScanResult(event.detail || {}); };",
          "  window.addEventListener('architect:graph-file-scan', graphScanListener);",
          "  tab.destroy = function() { window.removeEventListener('architect:graph-file-scan', graphScanListener); disposeEditorModel(); if (tab.monacoEditor && typeof tab.monacoEditor.dispose === 'function') tab.monacoEditor.dispose(); tab.monacoEditor = null; tab.__codeEditorMounted = false; };",
          "  ensureArchitectLucide(root).catch(function() { /* icons are progressive enhancement */ });",
          "  loadRepos().then(function() { if (tab.filePath) updateActiveTreeItem(); syncTitle(); }).catch(function(error) { setSurfaceText(status, error && error.message ? error.message : String(error)); });",
          "  syncTitle();",
          "}",
        ];
        const url = URL.createObjectURL(new Blob([moduleLines.join(String.fromCharCode(10))], { type: 'text/javascript' }));
        architectCodeEditorModulePromise = import(url).then(function(mod) {
          mod.__dreamgraphModuleUrl = url;
          return mod;
        }).catch(function(error) {
          try { URL.revokeObjectURL(url); } catch (_) { /* ignore */ }
          architectCodeEditorModulePromise = null;
          throw error;
        });
      }
      return architectCodeEditorModulePromise;
    }

    function resolveArchitectCenterTab(tabId) {
      const requested = tabId || 'chat';
      return architectCenterTabs.some(function(tab) { return tab.id === requested; }) ? requested : 'chat';
    }

    function handleArchitectTabPointerAction(event, action) {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      action();
    }

    function renderArchitectTabButton(tab, activeTabId) {
      const item = document.createElement('div');
      item.className = 'architect-tab-item' + (tab.id === activeTabId ? ' is-active' : '');
      item.dataset.architectTabItem = tab.id;
      item.dataset.architectTabType = tab.type;
      item.dataset.architectTabLifecycle = tab.lifecycle;

      const button = document.createElement('button');
      button.id = 'architect-tab-' + tab.id;
      button.className = 'architect-tab-button';
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', tab.id === activeTabId ? 'true' : 'false');
      button.setAttribute('aria-controls', tab.panelId);
      button.dataset.architectTab = tab.id;
      button.dataset.architectTabType = tab.type;
      button.dataset.architectTabLifecycle = tab.lifecycle;
      button.addEventListener('pointerdown', function(event) {
        handleArchitectTabPointerAction(event, function() { setArchitectCenterTab(tab.id); });
      });
      button.addEventListener('click', function() { setArchitectCenterTab(tab.id); });

      const label = document.createElement('span');
      label.className = 'architect-tab-label';
      label.textContent = tab.title + (tab.dirty ? ' *' : '');
      button.appendChild(label);
      item.appendChild(button);

      if (tab.closeable) {
        const close = document.createElement('button');
        close.className = 'architect-tab-close';
        close.type = 'button';
        close.setAttribute('aria-label', 'Close ' + tab.title);
        close.title = 'Close ' + tab.title;
        close.textContent = 'x';
        close.addEventListener('pointerdown', function(event) {
          handleArchitectTabPointerAction(event, function() { closeArchitectCenterTab(tab.id); });
        });
        close.addEventListener('click', function(event) {
          event.preventDefault();
          event.stopPropagation();
          closeArchitectCenterTab(tab.id);
        });
        item.appendChild(close);
      }
      return item;
    }

    function renderArchitectTabPanel(tab) {
      let panel = document.getElementById(tab.panelId);
      if (!panel) {
        panel = document.createElement('div');
        panel.id = tab.panelId;
        panel.className = 'architect-tab-panel ' + (tab.type === 'terminal' ? 'terminal-workspace' : (tab.type === 'doom' ? 'doom-workspace' : (tab.type === 'code-editor' ? 'code-editor-workspace' : '')));
        panel.setAttribute('role', 'tabpanel');
        panel.dataset.architectTabPanel = tab.id;
        panel.dataset.architectTabType = tab.type;
        if (tab.type === 'terminal') {
          renderTerminalArchitectTabPanel(tab, panel);
        } else if (tab.type === 'doom') {
          renderDoomArchitectTabPanel(tab, panel);
        } else if (tab.type === 'code-editor') {
          loadArchitectCodeEditorModule().then(function(mod) {
            if (mod && typeof mod.mountCodeEditorArchitectTab === 'function') {
              mod.mountCodeEditorArchitectTab({
                tab: tab,
                panel: panel,
                refreshTabs: function(tabId) { setArchitectCenterTab(tabId || tab.id); },
              });
            }
          }).catch(function(error) {
            panel.textContent = error && error.message ? error.message : 'Failed to load code editor module.';
          });
        } else if (tab.lifecycle === 'plugin') {
          void loadArchitectPluginTabSnapshot(tab, panel);
        }
        architectCenterPanelContainer.appendChild(panel);
      }
      panel.setAttribute('aria-labelledby', 'architect-tab-' + tab.id);
      panel.hidden = true;
      return panel;
    }

    function appendTerminalOutput(output, text) {
      output.textContent += text;
      output.scrollTop = output.scrollHeight;
    }

    async function postTerminalRequest(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const payload = await response.json().catch(function() { return {}; });
      if (!response.ok || payload.ok === false) throw new Error(payload.message || 'Terminal request failed.');
      return payload;
    }

    function updateTerminalTabTitle(tab, title) {
      tab.title = title;
      tab.dirty = false;
      const heading = document.querySelector('#' + tab.panelId + ' h2');
      if (heading) heading.textContent = title;
      const activePanel = architectCenterPanelContainer.querySelector('[data-architect-tab-panel]:not([hidden])');
      const activeTabId = activePanel ? activePanel.dataset.architectTabPanel : tab.id;
      renderArchitectCenterTabs(activeTabId);
    }

    function connectTerminalWebSocket(tab, term, fitAddon, mount, status) {
      if (!tab.terminalSessionId || tab.terminalSocket) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(protocol + '//' + window.location.host + '/api/architect/v1/terminal/' + encodeURIComponent(tab.terminalSessionId));
      tab.terminalSocket = socket;
      tab.terminalSocketReady = false;

      function sendTerminalMessage(payload) {
        if (!tab.terminalSocket || tab.terminalSocket.readyState !== WebSocket.OPEN) return;
        tab.terminalSocket.send(JSON.stringify(payload));
      }

      function fitAndResize() {
        if (!tab.terminalXterm || !tab.terminalFitAddon || mount.offsetParent === null || !mount.clientWidth || !mount.clientHeight) return;
        try {
          tab.terminalFitAddon.fit();
          sendTerminalMessage({ type: 'resize', cols: tab.terminalXterm.cols, rows: tab.terminalXterm.rows });
        } catch (error) {
          status.textContent = error.message || 'Terminal fit failed.';
        }
      }

      function scheduleFitAndResize() {
        window.clearTimeout(tab.terminalResizeTimer || 0);
        tab.terminalResizeTimer = window.setTimeout(fitAndResize, 30);
      }

      tab.terminalScheduleFit = scheduleFitAndResize;
      tab.terminalResizeListener = scheduleFitAndResize;
      socket.addEventListener('open', function() {
        tab.terminalSocketReady = true;
        status.textContent = 'Terminal connected.';
        scheduleFitAndResize();
      });
      socket.addEventListener('message', function(event) {
        let payload = null;
        try { payload = JSON.parse(event.data || '{}'); } catch (_) { return; }
        if (payload.type === 'snapshot') {
          const terminal = payload.terminal || {};
          if (terminal.title) updateTerminalTabTitle(tab, terminal.title);
          if (terminal.shell || terminal.cwd) status.textContent = (terminal.shell || 'terminal') + ' | ' + (terminal.cwd || 'project root');
          if (payload.output) term.write(String(payload.output));
          scheduleFitAndResize();
          return;
        }
        if (payload.type === 'data') {
          term.write(String(payload.data || ''));
          return;
        }
        if (payload.type === 'exit') {
          const terminal = payload.terminal || {};
          status.textContent = 'Terminal closed' + (terminal.exit_code == null ? '' : ' | exit ' + terminal.exit_code);
          return;
        }
        if (payload.type === 'error') {
          status.textContent = payload.message || payload.error || 'Terminal transport error.';
        }
      });
      socket.addEventListener('close', function() {
        tab.terminalSocketReady = false;
        if (tab.terminalSocket === socket) tab.terminalSocket = null;
        if (!status.textContent.startsWith('Terminal closed')) status.textContent = 'Terminal disconnected.';
      });
      socket.addEventListener('error', function() {
        status.textContent = 'Terminal WebSocket error.';
      });
      tab.terminalInputDisposable = term.onData(function(data) {
        sendTerminalMessage({ type: 'input', data: data });
      });
      window.addEventListener('resize', tab.terminalResizeListener);
      if (typeof ResizeObserver !== 'undefined') {
        tab.terminalResizeObserver = new ResizeObserver(scheduleFitAndResize);
        tab.terminalResizeObserver.observe(mount);
        tab.terminalResizeObserver.observe(architectCenterPanelContainer);
      }
      window.setTimeout(scheduleFitAndResize, 0);
      window.setTimeout(scheduleFitAndResize, 120);
    }

    async function ensureTerminalSession(tab, term, fitAddon, mount, status) {
      if (tab.terminalSessionId) {
        connectTerminalWebSocket(tab, term, fitAddon, mount, status);
        return;
      }
      status.textContent = 'Starting terminal in project root...';
      const payload = await postTerminalRequest('/api/architect/v1/terminals', { title: tab.title });
      tab.terminalSessionId = payload.terminal && payload.terminal.id;
      if (payload.terminal && payload.terminal.title) updateTerminalTabTitle(tab, payload.terminal.title);
      const shell = (payload.terminal && payload.terminal.shell) || 'terminal';
      status.textContent = shell + ' | ' + ((payload.terminal && payload.terminal.cwd) || 'project root');
      connectTerminalWebSocket(tab, term, fitAddon, mount, status);
    }

    function renderTerminalArchitectTabPanel(tab, panel) {
      const heading = document.createElement('h2');
      heading.textContent = tab.title;
      const surface = document.createElement('div');
      surface.className = 'terminal-surface';
      const toolbar = document.createElement('div');
      toolbar.className = 'terminal-toolbar';
      const status = document.createElement('span');
      status.textContent = 'Terminal pending daemon session.';
      const rename = document.createElement('button');
      rename.className = 'mini-button';
      rename.type = 'button';
      rename.textContent = 'Rename';
      toolbar.appendChild(status);
      toolbar.appendChild(rename);
      const consoleSurface = document.createElement('div');
      consoleSurface.className = 'terminal-console';
      const mount = document.createElement('div');
      mount.className = 'terminal-xterm-mount';
      mount.setAttribute('aria-label', 'Terminal');
      const fallback = document.createElement('div');
      fallback.className = 'terminal-fallback';
      fallback.hidden = true;
      consoleSurface.appendChild(mount);
      consoleSurface.appendChild(fallback);
      surface.appendChild(toolbar);
      surface.appendChild(consoleSurface);
      panel.appendChild(heading);
      panel.appendChild(surface);

      const TerminalCtor = window.Terminal;
      const FitAddonCtor = window.FitAddon && window.FitAddon.FitAddon;
      if (!TerminalCtor || !FitAddonCtor) {
        fallback.hidden = false;
        fallback.textContent = 'Terminal browser assets failed to load.';
        status.textContent = 'xterm assets unavailable.';
        return;
      }

      const term = new TerminalCtor({
        cursorBlink: true,
        convertEol: false,
        fontFamily: 'JetBrains Mono, Cascadia Code, IBM Plex Mono, SFMono-Regular, Consolas, monospace',
        fontSize: 13,
        theme: {
          background: '#07100d',
          foreground: '#edf5ee',
          cursor: '#68d8b6',
          selectionBackground: '#315c50',
        },
      });
      const fitAddon = new FitAddonCtor();
      tab.terminalXterm = term;
      tab.terminalFitAddon = fitAddon;
      term.loadAddon(fitAddon);
      term.open(mount);
      term.writeln('Starting local terminal session. Terminal output is local convenience output, not daemon payload authority.');
      ensureTerminalSession(tab, term, fitAddon, mount, status).catch(function(error) {
        fallback.hidden = false;
        fallback.textContent = error.message || 'Terminal failed to start.';
        status.textContent = fallback.textContent;
        term.writeln('');
        term.writeln(fallback.textContent);
      });
      consoleSurface.addEventListener('pointerdown', function(event) {
        if (event.button !== 0) return;
        term.focus();
      });
      tab.terminalBlurListener = function(event) {
        if (consoleSurface.contains(event.target)) return;
        blurArchitectTerminalTab(tab);
      };
      document.addEventListener('focusin', tab.terminalBlurListener, true);
      window.setTimeout(function() {
        if (tab.terminalScheduleFit) tab.terminalScheduleFit();
      }, 0);
      rename.addEventListener('click', function() {
        if (!tab.terminalSessionId) return;
        const title = window.prompt('Terminal name', tab.title);
        if (!title) return;
        postTerminalRequest('/api/architect/v1/terminals/' + encodeURIComponent(tab.terminalSessionId) + '/rename', { title: title }).then(function(payload) {
          if (payload.terminal && payload.terminal.title) updateTerminalTabTitle(tab, payload.terminal.title);
        }).catch(function(error) { status.textContent = error.message || 'Rename failed.'; });
      });
    }

    function blurArchitectTerminalTab(tab) {
      if (tab && tab.terminalXterm && typeof tab.terminalXterm.blur === 'function') tab.terminalXterm.blur();
    }

    function renderArchitectCenterTabs(activeTabId) {
      resetNode(architectCenterTabContainer);
      const normalized = resolveArchitectCenterTab(activeTabId);
      for (const tab of architectCenterTabs) {
        architectCenterTabContainer.appendChild(renderArchitectTabButton(tab, normalized));
        renderArchitectTabPanel(tab);
      }
      for (const panel of Array.from(architectCenterPanelContainer.querySelectorAll('[data-architect-tab-panel]'))) {
        const isActivePanel = panel.dataset.architectTabPanel === normalized;
        panel.hidden = !isActivePanel;
        if (!isActivePanel && panel.dataset.architectTabType === 'terminal') {
          const inactiveTab = architectCenterTabs.find(function(candidate) { return candidate.id === panel.dataset.architectTabPanel; });
          blurArchitectTerminalTab(inactiveTab);
        }
        if (!isActivePanel && panel.dataset.architectTabType === 'doom') {
          const inactiveTab = architectCenterTabs.find(function(candidate) { return candidate.id === panel.dataset.architectTabPanel; });
          suspendArchitectDoomTab(inactiveTab);
        }
      }
      const activePanel = architectCenterPanelContainer.querySelector('[data-architect-tab-panel="' + normalized + '"]');
      if (activePanel && activePanel.dataset.architectTabType === 'terminal') {
        const tab = architectCenterTabs.find(function(candidate) { return candidate.id === normalized; });
        if (tab && tab.terminalScheduleFit) window.setTimeout(tab.terminalScheduleFit, 0);
      }
      if (activePanel && activePanel.dataset.architectTabType === 'doom') {
        const tab = architectCenterTabs.find(function(candidate) { return candidate.id === normalized; });
        resumeArchitectDoomTab(tab);
      }
      return normalized;
    }

    function setArchitectCenterTab(tabId) {
      const normalized = renderArchitectCenterTabs(tabId);
      try { window.localStorage.setItem(architectCenterTabStorageKey, normalized); } catch (_) { /* storage may be unavailable */ }
    }

    function closeArchitectCenterTab(tabId) {
      const tab = architectCenterTabs.find(function(candidate) { return candidate.id === tabId; });
      if (!tab || !tab.closeable) return;
      if (typeof tab.destroy === 'function') {
        try { tab.destroy(); } catch (_) { /* best-effort cleanup */ }
        tab.destroy = null;
      }
      window.clearTimeout(tab.terminalResizeTimer || 0);
      tab.terminalResizeTimer = 0;
      if (tab.terminalResizeListener) {
        window.removeEventListener('resize', tab.terminalResizeListener);
        tab.terminalResizeListener = null;
      }
      if (tab.terminalBlurListener) {
        document.removeEventListener('focusin', tab.terminalBlurListener, true);
        tab.terminalBlurListener = null;
      }
      if (tab.terminalInputDisposable && typeof tab.terminalInputDisposable.dispose === 'function') {
        tab.terminalInputDisposable.dispose();
        tab.terminalInputDisposable = null;
      }
      if (tab.terminalSocket) {
        tab.terminalSocket.close(1000, 'tab closed');
        tab.terminalSocket = null;
      }
      if (tab.terminalResizeObserver) {
        tab.terminalResizeObserver.disconnect();
        tab.terminalResizeObserver = null;
      }
      if (tab.terminalXterm) {
        tab.terminalXterm.dispose();
        tab.terminalXterm = null;
      }
      tab.terminalFitAddon = null;
      tab.terminalScheduleFit = null;
      if (tab.terminalSessionId) {
        postTerminalRequest('/api/architect/v1/terminals/' + encodeURIComponent(tab.terminalSessionId) + '/close', {}).catch(function() { /* best-effort cleanup */ });
      }
      const activePanel = architectCenterPanelContainer.querySelector('[data-architect-tab-panel]:not([hidden])');
      const activeTabId = activePanel ? activePanel.dataset.architectTabPanel : 'chat';
      const wasActive = activeTabId === tab.id;
      architectCenterTabs = architectCenterTabs.filter(function(candidate) { return candidate.id !== tabId; });
      const panel = document.getElementById(tab.panelId);
      if (panel) panel.remove();
      setArchitectCenterTab(wasActive ? 'chat' : activeTabId);
    }

    function createArchitectCenterTab(type) {
      const descriptor = architectTabTypeRegistry.get(type);
      if (!descriptor) return;
      const tab = descriptor.create();
      architectCenterTabs.push(tab);
      setArchitectCenterTab(tab.id);
      if (architectTabMenu) architectTabMenu.hidden = true;
    }

    function renderArchitectTabMenu() {
      resetNode(architectTabMenu);
      for (const descriptor of architectTabTypeRegistry.values()) {
        const item = document.createElement('button');
        item.type = 'button';
        item.textContent = descriptor.title;
        item.addEventListener('click', function() { createArchitectCenterTab(descriptor.type); });
        architectTabMenu.appendChild(item);
      }
    }

    function hydrateArchitectCenterTabs() {
      architectCenterTabs = [
        createBuiltInArchitectTab('chat', 'Chat', 'chat', 'architect-panel-chat'),
        createBuiltInArchitectTab('plan', 'Plan', 'plan', 'architect-panel-plan'),
        createBuiltInArchitectTab('adr', 'ADR Editor', 'adr', 'architect-panel-adr'),
      ];
      registerArchitectTabType({ type: 'code-editor', title: 'New Code Editor', create: createCodeEditorArchitectTab });
      registerArchitectTabType({ type: 'terminal', title: 'New Terminal', create: createTerminalArchitectTab });
${isArchitectDoomEnabled() ? "      registerArchitectTabType({ type: 'doom', title: 'New Doom Session', create: createDoomArchitectTab });\n" : ""}      renderArchitectTabMenu();
      void hydrateArchitectPluginTabTypes().catch(function(error) { appendEventLine('[plugin-tabs] ' + (error && error.message ? error.message : 'Failed to hydrate plugin tabs.')); });
      let tabAddPointerHandled = false;
      architectTabAddButton.addEventListener('pointerdown', function(event) {
        handleArchitectTabPointerAction(event, function() {
          tabAddPointerHandled = true;
          architectTabMenu.hidden = !architectTabMenu.hidden;
        });
      });
      architectTabAddButton.addEventListener('click', function() {
        if (tabAddPointerHandled) {
          tabAddPointerHandled = false;
          return;
        }
        architectTabMenu.hidden = !architectTabMenu.hidden;
      });
      document.addEventListener('click', function(event) {
        if (architectTabMenu.hidden) return;
        if (architectTabMenu.contains(event.target) || architectTabAddButton.contains(event.target)) return;
        architectTabMenu.hidden = true;
      });
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

    function activeExecutionCapabilities() {
      const llm = activeArchitectRuntime && activeArchitectRuntime.capabilities ? activeArchitectRuntime.capabilities : {};
      return activeArchitectRuntime.execution_controls || llm.executionControls || { stop: false, pause: false, resume: false, steering: false };
    }

    function setChatProcessing(processing) {
      const controls = activeExecutionCapabilities();
      chatProcessing = processing;
      chatFormEl.classList.toggle('processing', processing);
      chatFormEl.setAttribute('aria-busy', processing ? 'true' : 'false');
      chatSubmitEl.disabled = false;
      chatSubmitEl.hidden = processing;
      chatPauseEl.hidden = !(processing && controls.pause);
      chatPauseEl.disabled = !(processing && controls.pause);
      chatStopEl.hidden = !(processing && controls.stop);
      chatStopEl.disabled = !(processing && controls.stop);
      chatScopePillEl.disabled = processing;
      chatInputEl.disabled = false;
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
      const tokenEconomy = payload && (payload.token_economy || payload.architect_token_economy || (payload.architect_llm && payload.architect_llm.token_economy) || (payload.result && (payload.result.token_economy || (payload.result.route && payload.result.route.token_economy))) || (activeArchitectRuntime && activeArchitectRuntime.token_economy));
      const budgetStatus = payload && (payload.budget_status || (payload.result && (payload.result.budget_status || (payload.result.token_economy && payload.result.token_economy.budget_status) || (payload.result.route && payload.result.route.token_economy && payload.result.route.token_economy.budget_status))));
      if (tokenEconomy) activeTokenEconomy = tokenEconomy;
      if (budgetStatus) activeTokenEconomy = Object.assign({}, activeTokenEconomy || {}, { budget_status: budgetStatus });
      renderTokenEconomyStatus(activeTokenEconomy);
      return activeArchitectRuntime;
    }

    function formatTokenCount(value) {
      const n = Number(value || 0);
      if (!Number.isFinite(n)) return '0';
      if (Math.abs(n) >= 1000) return String(Math.round(n / 100) / 10) + 'k';
      return String(Math.round(n));
    }

    function formatTokenTarget(value) {
      const n = Number(value || 0);
      if (!Number.isFinite(n) || n <= 0) return '0';
      if (n >= 1000) return String(Math.round(n / 1000)) + 'k';
      return String(Math.round(n));
    }

    function renderTokenEconomyStatus(config) {
      if (!chatTokenEconomyStatusEl) return;
      const economyEnabled = config && config.token_economy !== false;
      const preambleEnabled = config && config.preamble_compiler !== false;
      const target = config && config.soft_target_tokens || 16384;
      const status = config && config.budget_status;
      chatTokenEconomyStatusEl.textContent = economyEnabled
        ? '⚡ Token economy: Enabled (' + formatTokenTarget(target) + ')'
        : '⚡ Token economy: Disabled (Full context)';
      if (economyEnabled && status) {
        const actual = formatTokenCount(status.last_actual_tokens);
        const expected = formatTokenCount(status.expected_tokens || target);
        const balance = Number(status.balance_tokens || 0);
        const pressure = status.pressure_label || 'normal';
        chatTokenEconomyStatusEl.title = 'Architect token economy enabled. Daemon budget balance: actual ' + actual + ' of expected ' + expected + ', ' + (balance > 0 ? 'debt ' + formatTokenCount(balance) : balance < 0 ? 'credit ' + formatTokenCount(-balance) : 'balanced') + ', pressure ' + pressure + '. Click to switch this instance to full-context mode.';
      } else {
        chatTokenEconomyStatusEl.title = economyEnabled
          ? 'Architect token economy enabled. Click to switch this instance to full-context mode. Preamble compiler ' + (preambleEnabled ? 'enabled' : 'disabled') + '. Soft target ' + String(target) + ' tokens.'
          : 'Architect token economy disabled. Click to enable token economy for this instance.';
      }
      chatTokenEconomyStatusEl.classList.toggle('full-context', !economyEnabled);
      chatTokenEconomyStatusEl.setAttribute('aria-pressed', economyEnabled ? 'true' : 'false');
    }

    async function toggleTokenEconomyStatus() {
      if (!chatTokenEconomyStatusEl) return;
      const currentEnabled = activeTokenEconomy && activeTokenEconomy.token_economy !== false;
      const nextEnabled = !currentEnabled;
      const controls = selectedArchitectControls();
      chatTokenEconomyStatusEl.disabled = true;
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
            token_economy: nextEnabled,
          }),
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.message || ('Architect config failed with HTTP ' + response.status));
        }
        const runtime = updateActiveArchitectRuntime(payload);
        renderRuntime(payload);
        const persisted = payload.result && payload.result.persisted;
        chatStatusEl.textContent = 'Token economy ' + (nextEnabled ? 'enabled' : 'disabled') + (persisted ? ' | engine.env updated' : ' | in-memory only');
        appendEventLine('[config] token economy ' + (nextEnabled ? 'enabled' : 'disabled') + ' for ' + architectRuntimeLabel(runtime));
      } catch (error) {
        renderTokenEconomyStatus(activeTokenEconomy);
        chatStatusEl.textContent = 'Token economy toggle failed: ' + String(error instanceof Error ? error.message : error);
      } finally {
        chatTokenEconomyStatusEl.disabled = false;
      }
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

    function decodeVisibleEscapes(value) {
      return String(value || '')
        .replace(/\\r\\n/g, String.fromCharCode(10))
        .replace(/\\n/g, String.fromCharCode(10))
        .replace(/\\r/g, String.fromCharCode(10))
        .replace(/\\t/g, String.fromCharCode(9));
    }

    function looksLikeCutJson(value) {
      const text = String(value || '').trim();
      if (!text) return false;
      const startsStructured = text.startsWith('{') || text.startsWith('[') || text.indexOf('{') >= 0;
      const hasTruncationMarker = new RegExp('\\.\\.\\.$|\\[output truncated\\]|truncated', 'i').test(text);
      const openObjectCount = (text.match(new RegExp(String.fromCharCode(123), 'g')) || []).length;
      const closeObjectCount = (text.match(new RegExp(String.fromCharCode(125), 'g')) || []).length;
      const openArrayCount = (text.match(new RegExp(String.fromCharCode(91), 'g')) || []).length;
      const closeArrayCount = (text.match(new RegExp(String.fromCharCode(93), 'g')) || []).length;
      return startsStructured && (hasTruncationMarker || openObjectCount > closeObjectCount || openArrayCount > closeArrayCount);
    }

    function formatToolResultPreview(tool, preview) {
      if (!preview) return '';
      const value = unwrapToolResultPreview(preview);
      if (value && typeof value === 'object') {
        return summarizeJsonObject(value) || 'structured result received';
      }
      const text = collapseWhitespace(value == null ? decodeVisibleEscapes(preview) : value);
      return text.length > 180 ? text.slice(0, 180) + '...' : text;
    }

    function toolPreviewDetails(preview) {
      if (!preview) return '';
      const value = unwrapToolResultPreview(preview);
      if (value && typeof value === 'object') {
        return JSON.stringify(value, null, 2);
      }
      const raw = decodeVisibleEscapes(value == null ? preview : value);
      const marker = value == null && looksLikeCutJson(raw) ? 'Preview truncated before parsing' + String.fromCharCode(10) : '';
      const text = raw.trim();
      return marker + (text.length > 1800 ? text.slice(0, 1800).trim() + '...' : text);
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
      if (value && Array.isArray(value.content)) {
        const textParts = value.content
          .filter(function(part) { return part && part.type === 'text' && typeof part.text === 'string'; })
          .map(function(part) { return part.text; });
        if (textParts.length > 0) {
          const text = textParts.join(String.fromCharCode(10)).trim();
          const nested = tryParseJsonPayload(text);
          return nested ? nested.value : text;
        }
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
          if (exitCode !== null) return exitCode === 0 ? 'Passed' : 'Failed exit ' + exitCode;
          if (value.success === false || item.status === 'failed') return 'Failed';
          return 'Passed';
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
        pre.textContent = item.result_preview ? toolPreviewDetails(item.result_preview) : toolPreviewDetails(item.args_summary);
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

    function isArchitectProviderSetupSuppressed() {
      try {
        return window.localStorage.getItem(architectProviderSetupStorageKey) === 'suppressed';
      } catch (_) {
        return false;
      }
    }

    function setArchitectProviderSetupVisible(visible, persistSuppression) {
      architectProviderSetupEl.hidden = !visible;
      architectProviderShowEl.hidden = visible;
      if (!visible && persistSuppression && architectProviderSuppressEl.checked) {
        try { window.localStorage.setItem(architectProviderSetupStorageKey, 'suppressed'); } catch (_) { /* storage may be unavailable */ }
      }
    }

    function applyArchitectProviderChoice(choice) {
      if (choice === 'codex-cli') {
        architectAdapterSelectEl.value = 'codex-cli';
      } else if (choice === 'deterministic_fallback') {
        architectAdapterSelectEl.value = 'deterministic_fallback';
      } else {
        architectAdapterSelectEl.value = 'native_api_tool_loop';
        architectProviderSelectEl.value = choice === 'local' ? 'ollama' : 'openai';
      }
      syncArchitectControlState('');
      saveArchitectControls();
      architectProviderStatusEl.textContent = 'Selected ' + choice.replace(/[_-]+/g, ' ') + '. Testing readiness is recommended.';
    }

    async function testArchitectProviderReadiness() {
      architectProviderStatusEl.textContent = 'Testing selected Architect route...';
      const response = await fetch('/api/architect/v1/provider-readiness', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(selectedArchitectControls()) });
      const payload = await response.json().catch(function() { return {}; });
      if (!response.ok) throw new Error(payload.message || ('Provider readiness failed with HTTP ' + response.status));
      const readiness = payload.readiness || {};
      architectProviderStatusEl.textContent = (readiness.ready ? 'Ready: ' : 'Needs attention: ') + (readiness.detail || 'No readiness detail returned.');
      if (readiness.ready) setArchitectProviderSetupVisible(false, true);
      return readiness;
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
      const economyEnabled = activeTokenEconomy && activeTokenEconomy.token_economy !== false;
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
            token_economy: economyEnabled,
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
      const adapterModels = architectModelOptionsByProvider[adapter] || [];
      const normalizedPreferredModel = cliAdapter && preferredModel && adapterModels.indexOf(preferredModel) < 0 ? 'auto' : preferredModel;
      if (cliAdapter || deterministic) {
        if (architectProviderSelectEl.value && architectProviderSelectEl.value !== 'none') {
          lastNativeArchitectProvider = architectProviderSelectEl.value;
        }
        architectProviderSelectEl.value = 'none';
      } else if (architectProviderSelectEl.value === 'none' && lastNativeArchitectProvider) {
        architectProviderSelectEl.value = lastNativeArchitectProvider;
      }
      architectProviderSelectEl.disabled = cliAdapter || deterministic;
      renderArchitectModelOptions(modelProviderKeyForControls(), normalizedPreferredModel);
      architectModelInputEl.disabled = deterministic;
      syncAttachmentCapabilities(computeAttachmentCapabilities(adapter, deterministicProviderForAdapter(adapter), architectModelInputEl.value.trim()));
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
      architectModelInputEl.addEventListener('change', function() {
        syncAttachmentCapabilities(computeAttachmentCapabilities(architectAdapterSelectEl.value, deterministicProviderForAdapter(architectAdapterSelectEl.value), architectModelInputEl.value.trim()));
        saveArchitectControls();
      });
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

    function computeAttachmentCapabilities(adapter, provider, model) {
      const normalizedAdapter = String(adapter || 'native_api_tool_loop').toLowerCase();
      const normalizedProvider = String(provider || 'none').toLowerCase();
      const normalizedModel = String(model || '').toLowerCase();
      if (normalizedAdapter === 'codex-cli' || normalizedAdapter === 'copilot-cli') {
        return { textAttachments: true, imageAttachments: true };
      }
      if (normalizedAdapter === 'deterministic_fallback') {
        return { textAttachments: false, imageAttachments: false };
      }
      if (normalizedProvider === 'anthropic') {
        return { textAttachments: true, imageAttachments: normalizedModel.indexOf('claude') === 0 };
      }
      if (normalizedProvider === 'openai') {
        return {
          textAttachments: true,
          imageAttachments: normalizedModel.indexOf('gpt-5') === 0 || normalizedModel.indexOf('gpt-4.1') === 0 || normalizedModel.indexOf('gpt-4o') === 0 || normalizedModel.indexOf('o4') === 0 || normalizedModel.indexOf('o3') === 0,
        };
      }
      if (normalizedProvider === 'ollama' || normalizedProvider === 'lmstudio') {
        return { textAttachments: true, imageAttachments: false };
      }
      return { textAttachments: false, imageAttachments: false };
    }

    function formatAttachmentSize(size) {
      if (typeof size !== 'number' || !isFinite(size) || size < 1024) return String(size || 0) + ' B';
      if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
      return (size / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function renderPendingChatAttachments() {
      resetNode(chatAttachmentListEl);
      if (!pendingChatAttachments.length) {
        chatAttachmentListEl.hidden = true;
        return;
      }
      chatAttachmentListEl.hidden = false;
      pendingChatAttachments.forEach(function(attachment, index) {
        const item = document.createElement('li');
        const label = document.createElement('span');
        label.textContent = attachment.name + ' (' + attachment.kind + ', ' + formatAttachmentSize(attachment.size) + ')';
        item.appendChild(label);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'mini-icon-button';
        remove.setAttribute('aria-label', 'Remove attachment');
        remove.title = 'Remove attachment';
        remove.textContent = 'x';
        remove.addEventListener('click', function() {
          pendingChatAttachments.splice(index, 1);
          renderPendingChatAttachments();
        });
        item.appendChild(remove);
        chatAttachmentListEl.appendChild(item);
      });
    }

    function syncAttachmentCapabilities(capabilities) {
      activeAttachmentCapabilities = capabilities || { textAttachments: false, imageAttachments: false };
      const enabled = Boolean(activeAttachmentCapabilities.textAttachments || activeAttachmentCapabilities.imageAttachments);
      chatAttachmentButtonEl.disabled = !enabled;
      chatAttachmentButtonEl.title = enabled
        ? 'Add attachment'
        : 'Current adapter/model does not support standalone attachments.';
      if (!enabled && pendingChatAttachments.length) {
        pendingChatAttachments = [];
        renderPendingChatAttachments();
      }
      chatAttachmentInputEl.accept = [
        activeAttachmentCapabilities.textAttachments ? '.md,.txt,.json,.yaml,.yml,.ts,.tsx,.js,.jsx,.css,.html,.py,.cs,.sql,.sh,.ps1' : '',
        activeAttachmentCapabilities.imageAttachments ? 'image/*' : '',
      ].filter(Boolean).join(',');
    }

    async function readTextAttachment(file) {
      const text = await file.text();
      return {
        kind: 'text',
        name: file.name,
        mimeType: file.type || 'text/plain',
        size: file.size || text.length,
        content: text.slice(0, 24000),
        truncated: text.length > 24000,
      };
    }

    async function uploadTempAttachment(file) {
      const dataUrl = await new Promise(function(resolve, reject) {
        const reader = new FileReader();
        reader.onload = function() { resolve(String(reader.result || '')); };
        reader.onerror = function() { reject(reader.error || new Error('Attachment read failed.')); };
        reader.readAsDataURL(file);
      });
      const response = await fetch('/api/architect/v1/attachments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: file.name || 'attachment',
          mimeType: file.type || 'application/octet-stream',
          size: file.size || 0,
          dataBase64: String(dataUrl || ''),
        }),
      });
      const payload = await response.json().catch(function() { return {}; });
      if (!response.ok || !payload.attachment || !payload.attachment.file_path) {
        throw new Error(payload.message || ('Attachment upload failed with HTTP ' + response.status));
      }
      return payload.attachment;
    }

    async function readImageAttachment(file) {
      const uploaded = await uploadTempAttachment(file);
      return {
        kind: 'image',
        name: file.name,
        mimeType: file.type || uploaded.mime_type || 'image/png',
        size: uploaded.size || file.size || 0,
        filePath: uploaded.file_path,
        content: '@' + uploaded.file_path,
        truncated: false,
      };
    }

    async function stageAttachmentFiles(files) {
      const next = [];
      for (const file of Array.from(files || [])) {
        const mimeType = String(file.type || '').toLowerCase();
        if (mimeType.indexOf('image/') === 0) {
          if (!activeAttachmentCapabilities.imageAttachments) {
            chatStatusEl.textContent = 'Current model does not support image attachments.';
            continue;
          }
          next.push(await readImageAttachment(file));
          continue;
        }
        if (!activeAttachmentCapabilities.textAttachments) {
          chatStatusEl.textContent = 'Current model does not support text attachments.';
          continue;
        }
        next.push(await readTextAttachment(file));
      }
      if (next.length) {
        pendingChatAttachments = pendingChatAttachments.concat(next);
        renderPendingChatAttachments();
        chatStatusEl.textContent = 'Staged ' + String(next.length) + ' attachment' + (next.length === 1 ? '' : 's') + '.';
      }
      chatAttachmentInputEl.value = '';
    }

    function buildAttachmentPromptBlock() {
      if (!pendingChatAttachments.length) return '';
      return pendingChatAttachments.map(function(attachment) {
        const heading = '[Attachment: ' + attachment.name + ' | ' + attachment.mimeType + ' | ' + formatAttachmentSize(attachment.size) + ']';
        const suffix = attachment.truncated ? '\\n[attachment content truncated for browser transport]' : '';
        if (attachment.filePath) {
          return heading + '\\n' + '@' + attachment.filePath + suffix;
        }
        return heading + '\\n' + attachment.content + suffix;
      }).join('\\n\\n');
    }

    function clearPendingChatAttachments() {
      pendingChatAttachments = [];
      renderPendingChatAttachments();
      chatAttachmentInputEl.value = '';
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

    function isArchitectWhitespace(char) {
      return char === ' ' || char === String.fromCharCode(9) || char === String.fromCharCode(10) || char === String.fromCharCode(13) || char === String.fromCharCode(12) || char === String.fromCharCode(11);
    }

    function splitArchitectWords(value) {
      const text = String(value || '');
      const words = [];
      let current = '';
      for (let index = 0; index < text.length; index += 1) {
        const char = text.charAt(index);
        if (isArchitectWhitespace(char)) {
          if (current) {
            words.push(current);
            current = '';
          }
        } else {
          current += char;
        }
      }
      if (current) words.push(current);
      return words;
    }

    function parseChatSlashOverride(message) {
      const raw = String(message || '');
      let index = 0;
      while (index < raw.length && isArchitectWhitespace(raw.charAt(index))) index += 1;
      if (raw.charAt(index) !== '/') return { message: message, scope: null };
      const commandStart = index + 1;
      let commandEnd = commandStart;
      while (commandEnd < raw.length && !isArchitectWhitespace(raw.charAt(commandEnd))) commandEnd += 1;
      const command = raw.slice(commandStart, commandEnd).toLowerCase();
      if (command !== 'ask' && command !== 'global' && command !== 'repo' && command !== 'plan') {
        return { message: message, scope: null };
      }
      return {
        message: raw.slice(commandEnd).trim(),
        scope: command === 'plan' ? 'plan' : 'project'
      };
    }

    function parseArchitectSlashCommand(message) {
      const text = String(message || '').trim();
      if (!text || text.charAt(0) !== '/') return null;
      const tokens = splitArchitectWords(text.slice(1));
      if (!tokens.length) {
        return { name: '', args: [], raw: text, malformed: true };
      }
      return {
        name: String(tokens[0] || '').toLowerCase(),
        args: tokens.slice(1),
        raw: text,
        malformed: false,
      };
    }

    function slashHelpText() {
      return [
        '/status - Show the status of the current instance',
        '/stop - Stop a running Architect task when supported',
        '/pause - Pause a running Architect task when supported',
        '/resume - Resume a paused Architect task when supported',
        '/restart - Restart the bound daemon instance',
        '/plugin list - List runtime plugins',
        '/plugin inspect <plugin-id> - Show plugin details',
        '/plugin enable|disable <plugin-id> - Change plugin availability',
        '/plugin trust|untrust <plugin-id> - Change plugin trust',
        '/plugin reload|unload <plugin-id> - Reload or unload a plugin',
        '/plan new <name> - Create and select a plan',
        '/plan archive - Archive the selected plan',
        '/plan list|status|next|clear - Manage plan selection and lifecycle',
        '/plan search <query> - Search Architect plans',
        '/clear - Clear chat history',
        '/adr - List bound ADRs for the active plan',
        '/adr ADR-215 - Open ADR preview/editor',
        '/adr edit ADR-215 - Jump into the ADR editor',
        '/adr search <query> - Search ADR previews',
        '/adr proposed - Show proposed and unaccepted ADRs',
        '/git status|diff|branch|log - Show project git information',
        '/git commit <message> - Commit current project changes',
        '/help - Show slash commands',
      ].join('\\n');
    }

    function renderArchitectCommandResult(result) {
      if (!result || typeof result !== 'object') return '{}';
      return result.formatted_payload || result.content || '{}';
    }

    function architectCommandStatusText(result, fallbackName) {
      const title = result && result.title ? String(result.title) : String(fallbackName || 'command');
      return title + ' completed through the daemon command surface.';
    }

    async function runArchitectHostCommand(command, args) {
      const response = await fetch('/api/architect/v1/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: command, args: args || [] }),
      });
      const payload = await response.json().catch(function() { return {}; });
      if (!response.ok) {
        throw new Error(payload.message || ('Architect command failed with HTTP ' + response.status));
      }
      return payload.result || {};
    }

    async function fetchAdrIndex() {
      const response = await fetch('/api/architect/v1/adrs', { cache: 'no-store' });
      const payload = await response.json().catch(function() { return {}; });
      if (!response.ok) {
        throw new Error(payload.message || ('ADR index failed with HTTP ' + response.status));
      }
      return Array.isArray(payload.adrs) ? payload.adrs : [];
    }

    function formatAdrSlashResults(matches) {
      const items = Array.isArray(matches) ? matches : [];
      return items.map(function(adr) {
        const id = String((adr && adr.id) || 'ADR');
        const title = String((adr && adr.title) || 'Untitled ADR');
        const status = adr && adr.status ? ' [' + adr.status + ']' : '';
        const summary = String((adr && (adr.decision_summary || adr.problem_summary)) || '').trim();
        return id + status + ' - ' + title + (summary ? '\\n  ' + summary : '');
      }).join('\\n\\n');
    }

    async function handleAdrSlashCommand(args) {
      if (!args.length) {
        const bound = (((activePlanSnapshot || {}).registry || {}).adr_bindings || []).slice();
        appendChatMessage('assistant', bound.length ? bound.join('\\n') : 'No ADRs are bound to the active plan.');
        return true;
      }
      if (String(args[0] || '').toLowerCase() === 'search') {
        const query = args.slice(1).join(' ').trim().toLowerCase();
        if (!query) throw new Error('Usage: /adr search <query>');
        const matches = (await fetchAdrIndex()).filter(function(adr) {
          return [adr.id, adr.title, adr.status, adr.decision_summary, adr.problem_summary].filter(Boolean).join(' ').toLowerCase().indexOf(query) >= 0;
        });
        appendChatMessage('assistant', matches.length ? formatAdrSlashResults(matches) : 'No ADR matched "' + query + '".');
        return true;
      }
      if (String(args[0] || '').toLowerCase() === 'proposed') {
        const matches = (await fetchAdrIndex()).filter(function(adr) {
          const status = String((adr && adr.status) || '').toLowerCase();
          return status === 'proposed' || status === 'unaccepted';
        });
        appendChatMessage('assistant', matches.length ? formatAdrSlashResults(matches) : 'No proposed or unaccepted ADRs found.');
        return true;
      }
      if (String(args[0] || '').toLowerCase() === 'edit') {
        const adrId = String(args[1] || '').toUpperCase();
        if (!/^ADR-\d{3,}$/.test(adrId)) throw new Error('Usage: /adr edit ADR-215');
        setArchitectCenterTab('adr');
        await openAdrEditor(adrId);
        appendChatMessage('assistant', 'Opened ' + adrId + ' in the ADR editor.');
        return true;
      }
      const adrId = String(args[0] || '').toUpperCase();
      if (!/^ADR-\d{3,}$/.test(adrId)) throw new Error('Usage: /adr ADR-215');
      setArchitectCenterTab('adr');
      await openAdrEditor(adrId);
      appendChatMessage('assistant', 'Opened preview for ' + adrId + '.');
      return true;
    }

    async function tryHandleSlashCommand(message) {
      const slash = parseArchitectSlashCommand(message);
      if (!slash) return false;
      appendChatMessage('user', String(message || '').trim());
      if (slash.malformed) {
        appendChatMessage('assistant', 'That slash command is incomplete. Use /help to see available commands.');
        chatStatusEl.textContent = 'Slash command validation failed.';
        return true;
      }
      if (slash.name === 'help') {
        appendChatMessage('assistant', slashHelpText());
        return true;
      }
      if (slash.name === 'clear') {
        resetNode(chatLogEl);
        chatStatusEl.textContent = 'Chat history cleared.';
        return true;
      }
      if (slash.name === 'adr') {
        await handleAdrSlashCommand(slash.args);
        return true;
      }
      if (slash.name === 'status' || slash.name === 'restart' || slash.name === 'stop' || slash.name === 'pause' || slash.name === 'resume') {
        if (slash.name === 'restart') {
          appendChatMessage('assistant', 'Restarting...');
        }
        const result = await runArchitectHostCommand(slash.name, slash.args);
        appendChatMessage('assistant', renderArchitectCommandResult(result));
        chatStatusEl.textContent = architectCommandStatusText(result, slash.name);
        if (slash.name === 'stop') setChatProcessing(false);
        return true;
      }
      if (slash.name === 'plugin' || slash.name === 'git' || slash.name === 'plan') {
        const result = await runArchitectHostCommand(slash.name, slash.args);
        appendChatMessage('assistant', renderArchitectCommandResult(result));
        chatStatusEl.textContent = architectCommandStatusText(result, slash.name);
        if (slash.name === 'plan') {
          const structured = result.structured || {};
          const selected = structured.selected_plan_id || structured.plan_id || null;
          if (slash.args[0] === 'clear' || slash.args[0] === 'archive') {
            await loadPlans(null, { activatePlanScope: false });
          } else if (selected) {
            await loadPlans(selected, { activatePlanScope: true });
          } else if (slash.args[0] === 'new' || slash.args[0] === 'list' || slash.args[0] === 'search') {
            await loadPlans(activePlanId, { activatePlanScope: activeChatScope === 'plan' });
          }
        }
        return true;
      }
      appendChatMessage('assistant', 'I do not recognize /' + slash.name + '. Use /help to see available commands.');
      chatStatusEl.textContent = 'Slash command validation failed.';
      return true;
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
      const llm = payload.architect_llm || {};
      syncAttachmentCapabilities(llm.capabilities || computeAttachmentCapabilities(runtime.adapter, runtime.provider, runtime.model));
      architectModelConfigEl.textContent = 'Model: ' + architectRuntimeLabel(runtime);
      architectModelConfigEl.title = 'session: ' + (runtime.session_id || 'unknown') + ' | route: ' + (runtime.execution_route || runtime.adapter || 'unknown') + ' | autonomy: ' + (runtime.autonomy_mode || 'unknown') + ' | provenance: ' + (runtime.provenance_authority || 'unknown') + ' | adapter source: ' + (runtime.adapter_source || 'unknown') + ' | model source: ' + (runtime.model_source || 'unknown') + ' | provider source: ' + (runtime.provider_source || 'unknown');
    }

    function renderArchitectPulse(pulse) {
      if (!pulse) return;
      const cognitive = pulse.cognitive || {};
      const weather = pulse.weather || {};
      const plan = pulse.plan || {};
      const readiness = cognitive.llm_ready == null ? 'unknown' : (cognitive.llm_ready ? 'ready' : 'not ready');
      const reasons = Array.isArray(weather.reasons) ? weather.reasons.map(function(reason) { return reason.label || reason.id; }).filter(Boolean) : [];
      architectPulseStripEl.dataset.weather = weather.kind || 'unknown';
      architectPulseWeatherEl.textContent = 'Weather: ' + (weather.label || weather.kind || 'unknown');
      architectPulseWeatherEl.title = reasons.length ? reasons.join(' | ') : 'No pulse reasons reported.';
      architectPulseCognitiveEl.textContent = 'Cognitive: ' + (cognitive.state || 'unknown') + '/' + readiness + ' | tensions ' + String(cognitive.unresolved_tensions ?? '?') + ' | expiry ' + String(cognitive.expiring_next_cycle ?? '?');
      architectPulseCognitiveEl.title = 'Top tension: ' + (cognitive.top_tension_id || 'none') + ' | hash: ' + (pulse.pulse_hash || 'unknown');
      architectPulsePlanEl.textContent = plan.id ? 'Plan: ' + plan.id + ' ' + (plan.lifecycle || 'unknown') + '/' + (plan.execution || 'unknown') : 'Plan: none';
      architectPulsePlanEl.title = 'Active: ' + (plan.active_slice || 'none') + ' | Next: ' + (plan.next_slice || 'none');
      architectPulseAuthorityEl.textContent = 'Authority: ' + ((pulse.authority_boundary && pulse.authority_boundary.repository_authority) || 'dreamgraph_mcp');
      architectPulseAuthorityEl.title = 'Mutation mode: ' + ((pulse.authority_boundary && pulse.authority_boundary.mutation_mode) || 'governed_tools_only') + ' | direct filesystem claims: false';
    }

    async function loadArchitectPulse() {
      try {
        const response = await fetch('/api/architect/v1/pulse', { cache: 'no-store' });
        const payload = await response.json().catch(function() { return {}; });
        if (!response.ok) throw new Error(payload.message || ('Pulse failed with HTTP ' + response.status));
        renderArchitectPulse(payload.pulse);
      } catch (error) {
        architectPulseWeatherEl.textContent = 'Pulse unavailable';
        architectPulseWeatherEl.title = String(error instanceof Error ? error.message : error);
      }
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
      actions.style.justifyContent = 'flex-end';
      actions.appendChild(createAdrEditIconButton(function() {
        openAdrEditor(adr.id || adrId, payload).catch(function(error) {
          adrEditorStatusEl.textContent = String(error instanceof Error ? error.message : error);
        });
      }));
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

    function createAdrEditIconButton(onClick) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'adr-icon-button';
      button.setAttribute('aria-label', 'Edit ADR proposal');
      button.title = 'Edit proposal';
      button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>';
      button.addEventListener('click', onClick);
      return button;
    }

    function appendAdrListItem(node, adrId) {
      const item = document.createElement('li');
      item.className = 'adr-binding-item';
      const header = document.createElement('div');
      header.className = 'adr-binding-header';
      const title = document.createElement('strong');
      appendTextWithAdrPreviews(title, adrId);
      header.appendChild(title);
      header.appendChild(createAdrEditIconButton(function() {
        openAdrEditor(adrId).catch(function(error) {
          adrEditorStatusEl.textContent = String(error instanceof Error ? error.message : error);
        });
      }));
      item.appendChild(header);
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = 'daemon-governed ADR preview on hover or focus';
      item.appendChild(meta);
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
      activePlanSnapshot = plan || null;
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

      const livingState = plan.living_state || {
        confidence: 'low',
        review_state: 'draft',
        open_questions: [],
        nervous_points: [],
        branches: [],
        plan_asks: [],
        pulse: 'No living plan projection available.',
      };
      resetNode(livingPlanSummaryEl);
      appendChip(livingPlanSummaryEl, 'Confidence', livingState.confidence || 'low', false);
      appendChip(livingPlanSummaryEl, 'Review', livingState.review_state || 'draft', false);
      appendChip(livingPlanSummaryEl, 'Questions', String((livingState.open_questions || []).length), false);
      appendChip(livingPlanSummaryEl, 'Nervous points', String((livingState.nervous_points || []).length), false);
      appendChip(livingPlanSummaryEl, 'Branches', String((livingState.branches || []).length), false);
      appendChip(livingPlanSummaryEl, 'Plan asks', String((livingState.plan_asks || []).length), false);
      livingPlanPulseEl.textContent = livingState.pulse || 'No living plan pulse projected.';
      livingPlanPulseEl.title = livingState.next_review_prompt || livingState.last_changed_because || livingState.current_hypothesis || '';
      livingPlanQuestionCountEl.textContent = String((livingState.open_questions || []).length);
      renderList(livingPlanQuestionListEl, livingState.open_questions || [], 'No open questions projected from this plan.', function(node, question) {
        appendListItem(node, question, 'Unresolved plan question');
      });
      livingPlanNervousPointCountEl.textContent = String((livingState.nervous_points || []).length);
      renderList(livingPlanNervousPointListEl, livingState.nervous_points || [], 'No nervous points projected from this plan.', function(node, nervousPoint) {
        appendListItem(node, nervousPoint, 'Review-sensitive plan risk or guardrail');
      });

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
      activePlanSnapshot = null;
      archivePlanButtonEl.disabled = true;
      for (const node of document.querySelectorAll('button.plan-item')) {
        node.classList.remove('active');
      }
      planTitleEl.textContent = 'No plan selected';
      centerPlanTitleEl.textContent = 'No plan selected';
      resetNode(planChipsEl);
      resetNode(centerPlanChipsEl);
      resetNode(registrySummaryEl);
      resetNode(pluginTabSummaryEl);
      resetNode(livingPlanSummaryEl);
      livingPlanPulseEl.textContent = 'Select a plan to project its living state.';
      livingPlanPulseEl.title = '';
      livingPlanQuestionCountEl.textContent = '0';
      renderList(livingPlanQuestionListEl, [], 'No plan selected.', function(node, item) { appendListItem(node, item, ''); });
      livingPlanNervousPointCountEl.textContent = '0';
      renderList(livingPlanNervousPointListEl, [], 'No plan selected.', function(node, item) { appendListItem(node, item, ''); });
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
      refreshOpenArchitectPluginTabs();
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
      refreshOpenArchitectPluginTabs();
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
      const attachmentBlock = buildAttachmentPromptBlock();
      const outboundMessage = [dispatchMessage, attachmentBlock].filter(Boolean).join('\\n\\n');
      if (!outboundMessage) {
        chatStatusEl.textContent = 'Enter a message or add an attachment first.';
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
      appendChatMessage('user', outboundMessage);
      appendChatMessage('assistant', 'I am starting on that now. I will check the governed project context first, use DreamGraph tools where needed, and report the result when the pass is complete.');
      autonomyPassCount += 1;
      updateAutonomyPassView('running', 0);
      setChatProcessing(true);
      chatStatusEl.textContent = 'Architect is responding with ' + architectRuntimeLabel(requestRuntime) + ' in ' + dispatchScope + ' scope...';
      try {
        const response = await fetch('/api/architect/v1/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
          body: JSON.stringify({
            message: outboundMessage,
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
        clearPendingChatAttachments();
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

    function setArchitectWelcomeVisible(visible, rememberDismissal) {
      architectWelcomeEl.hidden = !visible;
      architectWelcomeReopenEl.hidden = visible;
      if (rememberDismissal) window.localStorage.setItem(architectWelcomeStorageKey, visible ? 'false' : 'true');
    }

    function appendArchitectWelcomeChip(container, label, value, warning) {
      const chip = document.createElement('span');
      chip.className = 'chip' + (warning ? ' warn' : '');
      chip.textContent = label + ': ' + value;
      container.appendChild(chip);
    }

    function renderArchitectWelcome(payload) {
      const readiness = payload && payload.onboarding_readiness || {};
      const project = readiness.project || {};
      const repositories = readiness.repositories || {};
      const projectMap = readiness.project_map || {};
      const runtime = readiness.architect_runtime || {};
      resetNode(architectWelcomeSummaryEl);
      resetNode(architectWelcomeWarningsEl);
      resetNode(architectWelcomeMissionsEl);
      appendArchitectWelcomeChip(architectWelcomeSummaryEl, 'Project', project.instance_name || project.status || 'choose project', project.status !== 'attached');
      appendArchitectWelcomeChip(architectWelcomeSummaryEl, 'Project map', projectMap.status || 'unknown', projectMap.status !== 'ready');
      appendArchitectWelcomeChip(architectWelcomeSummaryEl, 'Repositories', String(repositories.count || 0), !repositories.count);
      appendArchitectWelcomeChip(architectWelcomeSummaryEl, 'AI connection', runtime.status || 'unknown', runtime.status !== 'ready');
      appendArchitectWelcomeChip(architectWelcomeSummaryEl, 'Stack', projectMap.status === 'ready' ? 'learned from project map' : 'available after project map', projectMap.status !== 'ready');
      for (const check of (Array.isArray(readiness.required_to_start) ? readiness.required_to_start : [])) {
        if (check.status === 'ready') continue;
        const warning = document.createElement('div');
        warning.className = 'chip warn';
        warning.textContent = check.label + ': ' + (check.detail || 'Needs attention') + ' ';
        if (check.action && check.action.kind === 'open_route') {
          const link = document.createElement('a');
          link.href = check.action.target;
          link.textContent = check.action.label;
          warning.appendChild(link);
        } else if (check.action) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'mini-button';
          button.textContent = check.action.label;
          button.addEventListener('click', function() { sendChatMessage('Run the governed ' + check.action.target + ' action and report the result.').catch(function(error) { chatStatusEl.textContent = String(error instanceof Error ? error.message : error); }); });
          warning.appendChild(button);
        }
        architectWelcomeWarningsEl.appendChild(warning);
      }
      if (!architectWelcomeWarningsEl.childNodes.length) appendArchitectWelcomeChip(architectWelcomeWarningsEl, 'Readiness', 'required checks passed', false);
      for (const mission of architectOnboardingMissions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'architect-mission-card';
        button.dataset.missionId = mission.id;
        const title = document.createElement('strong');
        title.textContent = mission.title;
        const artifact = document.createElement('span');
        artifact.className = 'architect-mission-artifact';
        artifact.textContent = 'First artifact: ' + mission.artifact;
        button.appendChild(title);
        button.appendChild(artifact);
        button.addEventListener('click', function() { launchArchitectMission(mission).catch(function(error) { chatStatusEl.textContent = String(error instanceof Error ? error.message : error); }); });
        architectWelcomeMissionsEl.appendChild(button);
      }
      const dismissed = window.localStorage.getItem(architectWelcomeStorageKey) === 'true';
      setArchitectWelcomeVisible(!dismissed, false);
    }

    async function recordArchitectOnboardingEvent(event) {
      try {
        await fetch('/api/architect/v1/onboarding-events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event) });
      } catch (_) { /* local telemetry must never block onboarding */ }
    }

    async function launchArchitectMission(mission) {
      const startedAt = Date.now();
      const missionId = String(mission.id || mission.title || 'recipe').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 64);
      void recordArchitectOnboardingEvent({ event: 'mission_launched', mission_id: missionId });
      setArchitectWelcomeVisible(false, true);
      chatStatusEl.textContent = 'Launching mission: ' + mission.title + '...';
      if (mission.planBearing) {
        const plan = await ensureDaemonPlanForMission(mission.title);
        await loadPlans(plan.id, { activatePlanScope: true });
      } else {
        setChatScope('project');
      }
      await sendChatMessage(mission.prompt);
      void recordArchitectOnboardingEvent({ event: 'mission_completed', mission_id: missionId, duration_ms: Date.now() - startedAt });
    }

    function renderArchitectRecipes() {
      resetNode(architectRecipeGroupsEl);
      for (const group of architectRecipeGroups) {
        const section = document.createElement('section');
        section.className = 'architect-recipe-group';
        const title = document.createElement('h3');
        title.textContent = group.title;
        const grid = document.createElement('div');
        grid.className = 'architect-recipe-grid';
        for (const recipe of group.recipes) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'architect-mission-card';
          button.innerHTML = '<strong></strong><span class="architect-mission-artifact"></span>';
          button.querySelector('strong').textContent = recipe[0];
          button.querySelector('span').textContent = 'Artifact: ' + recipe[1] + ' | Verify: ' + recipe[2];
          button.addEventListener('click', function() { launchArchitectMission({ title: recipe[0], artifact: recipe[1], planBearing: recipe[3], prompt: recipe[0] + '. Produce: ' + recipe[1] + '. Verification expectation: ' + recipe[2] + '. Suggest the next useful recipe after the artifact.' }).catch(function(error) { chatStatusEl.textContent = String(error instanceof Error ? error.message : error); }); });
          grid.appendChild(button);
        }
        section.appendChild(title); section.appendChild(grid); architectRecipeGroupsEl.appendChild(section);
      }
    }

    function appendArchitectRepoRow(repo) {
      const row = document.createElement('div');
      row.className = 'architect-repo-row';
      const name = document.createElement('input');
      name.placeholder = 'repo-name';
      name.value = repo && repo.name || '';
      name.dataset.repoField = 'name';
      const role = document.createElement('select');
      role.dataset.repoField = 'role';
      for (const value of ['primary', 'frontend', 'backend', 'shared', 'docs', 'infra', 'other']) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        role.appendChild(option);
      }
      role.value = repo && repo.role || 'other';
      const path = document.createElement('input');
      path.placeholder = 'Absolute repository path';
      path.value = repo && repo.path || '';
      path.dataset.repoField = 'path';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'mini-button';
      remove.textContent = 'Remove';
      remove.addEventListener('click', function() { row.remove(); });
      row.appendChild(name); row.appendChild(role); row.appendChild(path); row.appendChild(remove);
      architectRepoSetupGridEl.appendChild(row);
    }

    function collectArchitectRepos() {
      return Array.from(architectRepoSetupGridEl.querySelectorAll('.architect-repo-row')).map(function(row) {
        return { name: row.querySelector('[data-repo-field="name"]').value, role: row.querySelector('[data-repo-field="role"]').value, path: row.querySelector('[data-repo-field="path"]').value };
      });
    }

    function renderArchitectRepoSetup(repoSetup) {
      resetNode(architectRepoSetupGridEl);
      architectRepoSetupScopeEl.textContent = repoSetup.scope_explanation || 'Repositories define the MCP-governed project scope.';
      for (const repo of (repoSetup.repositories || [])) appendArchitectRepoRow(repo);
      if (!architectRepoSetupGridEl.childNodes.length) appendArchitectRepoRow({ role: 'primary' });
      architectRepoMapEl.textContent = repoSetup.first_map_action && repoSetup.first_map_action.label || 'Build first project map';
      architectRepoSetupStatusEl.textContent = (repoSetup.repositories || []).length + ' connected repo(s) | map ' + (repoSetup.project_map && repoSetup.project_map.status || 'unknown') + (repoSetup.persisted ? '' : ' | attach an instance to persist changes');
    }

    async function loadArchitectRepoSetup() {
      const response = await fetch('/api/architect/v1/repo-setup', { cache: 'no-store' });
      if (!response.ok) throw new Error('Repository setup failed with HTTP ' + response.status);
      const payload = await response.json();
      renderArchitectRepoSetup(payload.repo_setup || {});
    }

    async function saveArchitectRepoSetup() {
      architectRepoSetupStatusEl.textContent = 'Validating and saving repositories...';
      const response = await fetch('/api/architect/v1/repo-setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repositories: collectArchitectRepos() }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || payload.error || 'Repository setup failed with HTTP ' + response.status);
      renderArchitectRepoSetup(payload.repo_setup || {});
      if (payload.onboarding_readiness) {
        renderArchitectWelcome({ onboarding_readiness: payload.onboarding_readiness });
        const required = payload.onboarding_readiness.required_to_start || [];
        void recordArchitectOnboardingEvent({ event: 'checklist_snapshot', ready_count: required.filter(function(check) { return check.status === 'ready'; }).length, required_count: required.length });
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

    function normalizeFilterValue(value) {
      return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    }

    function planMatchesFilters(plan) {
      const textFilter = (planSearchInputEl.value || '').trim().toLowerCase();
      const statusFilter = planStatusFilterEl.value;
      const normalizedStatusFilter = normalizeFilterValue(statusFilter);
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
      if (statusFilter && normalizeFilterValue(plan.status) !== normalizedStatusFilter && normalizeFilterValue(operational.plan_lifecycle) !== normalizedStatusFilter) return false;
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

    async function ensureDaemonPlanForMission(title) {
      const compactTitle = String(title || '').trim();
      const existing = planIndexCache.find(function(plan) { return String(plan.title || '').trim().toLowerCase() === compactTitle.toLowerCase(); });
      return existing || await createDaemonPlan(compactTitle);
    }

    async function createDaemonPlan(title) {
      const compactTitle = String(title || '').trim();
      if (!compactTitle) throw new Error('Enter a plan title first.');
      const response = await fetch('/api/architect/v1/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: compactTitle }),
      });
      const payload = await response.json().catch(function() { return {}; });
      if (!response.ok) throw new Error(payload.message || ('Plan create failed with HTTP ' + response.status));
      const plan = payload.plan || {};
      appendEventLine('[plan-action] created ' + (plan.id || compactTitle));
      return plan;
    }

    async function createPlanFromPanel() {
      const title = window.prompt('Plan title', 'New Architect Plan');
      if (title === null) return;
      createPlanButtonEl.disabled = true;
      railStatusEl.textContent = 'Creating plan...';
      try {
        const plan = await createDaemonPlan(title);
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
      stream.addEventListener('architect.execution_control', function(event) {
        appendTypedEventLine('execution-control', event);
      });
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
      stream.addEventListener('architect.pulse', function(event) {
        const envelope = appendTypedEventLine('pulse', event);
        renderArchitectPulse(envelope.payload);
      });
      stream.addEventListener('graph.file_scanned', function(event) {
        const envelope = parseArchitectEvent(event);
        appendTypedEventLine('graph-file-scanned', event);
        window.dispatchEvent(new CustomEvent('architect:graph-file-scan', { detail: envelope.payload || {} }));
      });
      stream.addEventListener('graph.file_scan_failed', function(event) {
        const envelope = parseArchitectEvent(event);
        appendTypedEventLine('graph-file-scan-failed', event);
        window.dispatchEvent(new CustomEvent('architect:graph-file-scan', { detail: envelope.payload || {} }));
      });
      stream.onerror = function() {
        liveEventStatusEl.textContent = 'Events: reconnecting';
        liveEventStatusEl.title = 'The Architect event stream will retry automatically.';
        appendEventLine('[stream] reconnecting');
      };
    }

    renderRuntime(initialRuntimePayload);
    renderTokenEconomyStatus(activeTokenEconomy);
    hydrateArchitectCenterTabs();
    hydrateArchitectControls(initialRuntimePayload);
    const initialArchitectReadiness = initialRuntimePayload && initialRuntimePayload.onboarding_readiness && initialRuntimePayload.onboarding_readiness.architect_runtime || {};
    architectProviderSuppressEl.checked = isArchitectProviderSetupSuppressed();
    setArchitectProviderSetupVisible(initialArchitectReadiness.status !== 'ready' && !architectProviderSuppressEl.checked);
    document.querySelectorAll('[data-provider-choice]').forEach(function(button) { button.addEventListener('click', function() { applyArchitectProviderChoice(button.dataset.providerChoice); }); });
    architectProviderTestEl.addEventListener('click', function() { testArchitectProviderReadiness().catch(function(error) { architectProviderStatusEl.textContent = 'Needs attention: ' + String(error instanceof Error ? error.message : error); }); });
    architectProviderDismissEl.addEventListener('click', function() { setArchitectProviderSetupVisible(false, true); });
    architectProviderShowEl.addEventListener('click', function(event) { event.preventDefault(); event.stopPropagation(); setArchitectProviderSetupVisible(true); });
    architectGuideLinkEl.addEventListener('click', function() { void recordArchitectOnboardingEvent({ event: 'guide_opened', source: 'architect' }); });
    try {
      if (window.localStorage.getItem(architectOnboardingVisitStorageKey) === 'visited') void recordArchitectOnboardingEvent({ event: 'second_session_return' });
      window.localStorage.setItem(architectOnboardingVisitStorageKey, 'visited');
    } catch (_) { /* local storage may be unavailable */ }
    renderChatScopePill();
    updateAutonomyPassView('idle', 0);
    renderArchitectWelcome(initialRuntimePayload);
    renderArchitectRecipes();
    loadArchitectRepoSetup().catch(function(error) { architectRepoSetupStatusEl.textContent = String(error instanceof Error ? error.message : error); });
    architectWelcomeDismissEl.addEventListener('click', function() { setArchitectWelcomeVisible(false, true); });
    architectWelcomeReopenEl.addEventListener('click', function() { setArchitectWelcomeVisible(true, true); });
    architectRepoAddEl.addEventListener('click', function() { appendArchitectRepoRow({ role: 'other' }); architectRepoSetupEl.open = true; });
    architectRepoSaveEl.addEventListener('click', function() { saveArchitectRepoSetup().catch(function(error) { architectRepoSetupStatusEl.textContent = String(error instanceof Error ? error.message : error); }); });
    architectRepoMapEl.addEventListener('click', function() { sendChatMessage('Run the governed scan_project action for the configured repository inventory and report the resulting project map status.').catch(function(error) { chatStatusEl.textContent = String(error instanceof Error ? error.message : error); }); });
    chatInputEl.addEventListener('keydown', function(event) {
      if (handleChatPromptHistoryKey(event)) return;
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      if (typeof chatFormEl.requestSubmit === 'function') {
        chatFormEl.requestSubmit();
      } else {
        chatFormEl.dispatchEvent(new Event('submit', { cancelable: true }));
      }
    });
    chatAttachmentButtonEl.addEventListener('click', function() {
      if (chatAttachmentButtonEl.disabled) {
        chatStatusEl.textContent = 'Current adapter/model does not support standalone attachments.';
        return;
      }
      chatAttachmentInputEl.click();
    });
    chatTokenEconomyStatusEl.addEventListener('click', function() {
      toggleTokenEconomyStatus().catch(function(error) {
        chatStatusEl.textContent = String(error instanceof Error ? error.message : error);
      });
    });
    function resizeChatInput() {
      chatInputEl.style.height = 'auto';
      const computed = window.getComputedStyle(chatInputEl);
      const lineHeight = Number.parseFloat(computed.lineHeight) || 18;
      const verticalPadding = Number.parseFloat(computed.paddingTop) + Number.parseFloat(computed.paddingBottom);
      const maxHeight = Math.ceil((lineHeight * 5) + verticalPadding);
      const nextHeight = Math.min(chatInputEl.scrollHeight, maxHeight);
      chatInputEl.style.height = String(nextHeight) + 'px';
      chatInputEl.style.overflowY = chatInputEl.scrollHeight > maxHeight ? 'auto' : 'hidden';
    }

    function loadChatPromptHistory() {
      try {
        const parsed = JSON.parse(window.localStorage.getItem(architectPromptHistoryStorageKey) || '[]');
        chatPromptHistory = Array.isArray(parsed) ? parsed.filter(function(item) { return typeof item === 'string' && item.trim().length > 0; }).slice(-architectPromptHistoryLimit) : [];
      } catch (_) {
        chatPromptHistory = [];
      }
    }

    function persistChatPromptHistory() {
      try {
        window.localStorage.setItem(architectPromptHistoryStorageKey, JSON.stringify(chatPromptHistory.slice(-architectPromptHistoryLimit)));
      } catch (_) { /* local prompt history is best effort */ }
    }

    function rememberChatPrompt(message) {
      const prompt = String(message || '').trim();
      if (!prompt) return;
      chatPromptHistory = chatPromptHistory.filter(function(item) { return item !== prompt; });
      chatPromptHistory.push(prompt);
      chatPromptHistory = chatPromptHistory.slice(-architectPromptHistoryLimit);
      chatPromptHistoryCursor = -1;
      chatPromptHistoryDraft = '';
      persistChatPromptHistory();
    }

    function cursorIsOnFirstPromptLine() {
      const cursor = chatInputEl.selectionStart || 0;
      return chatInputEl.value.slice(0, cursor).indexOf(String.fromCharCode(10)) < 0;
    }

    function cursorIsOnLastPromptLine() {
      const cursor = chatInputEl.selectionEnd || 0;
      return chatInputEl.value.slice(cursor).indexOf(String.fromCharCode(10)) < 0;
    }

    function setChatPromptDraft(value) {
      chatInputEl.value = value;
      resizeChatInput();
      const cursor = chatInputEl.value.length;
      chatInputEl.setSelectionRange(cursor, cursor);
    }

    function handleChatPromptHistoryKey(event) {
      if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
      if (event.key === 'ArrowUp') {
        if (!chatPromptHistory.length || !cursorIsOnFirstPromptLine()) return false;
        event.preventDefault();
        if (chatPromptHistoryCursor < 0) {
          chatPromptHistoryDraft = chatInputEl.value;
          chatPromptHistoryCursor = chatPromptHistory.length - 1;
        } else if (chatPromptHistoryCursor > 0) {
          chatPromptHistoryCursor -= 1;
        }
        setChatPromptDraft(chatPromptHistory[chatPromptHistoryCursor] || '');
        return true;
      }
      if (event.key === 'ArrowDown') {
        if (chatPromptHistoryCursor < 0 || !cursorIsOnLastPromptLine()) return false;
        event.preventDefault();
        if (chatPromptHistoryCursor < chatPromptHistory.length - 1) {
          chatPromptHistoryCursor += 1;
          setChatPromptDraft(chatPromptHistory[chatPromptHistoryCursor] || '');
        } else {
          chatPromptHistoryCursor = -1;
          setChatPromptDraft(chatPromptHistoryDraft);
          chatPromptHistoryDraft = '';
        }
        return true;
      }
      return false;
    }

    loadChatPromptHistory();
    chatAttachmentInputEl.addEventListener('change', function() {
      stageAttachmentFiles(chatAttachmentInputEl.files).catch(function(error) {
        chatStatusEl.textContent = String(error instanceof Error ? error.message : error);
      });
    });
    chatInputEl.addEventListener('paste', function(event) {
      const files = Array.from((event.clipboardData && event.clipboardData.files) || []).filter(function(file) {
        return String(file.type || '').toLowerCase().indexOf('image/') === 0;
      });
      if (!files.length) return;
      event.preventDefault();
      stageAttachmentFiles(files).catch(function(error) {
        chatStatusEl.textContent = String(error instanceof Error ? error.message : error);
      });
    });
    async function requestExecutionControl(action, args) {
      const result = await runArchitectHostCommand(action, args || []);
      appendChatMessage('assistant', renderArchitectCommandResult(result));
      chatStatusEl.textContent = architectCommandStatusText(result, action);
      if (action === 'stop') setChatProcessing(false);
      return result;
    }
    chatStopEl.addEventListener('click', function() {
      requestExecutionControl('stop').catch(function(error) {
        chatStatusEl.textContent = String(error instanceof Error ? error.message : error);
      });
    });
    chatPauseEl.addEventListener('click', function() {
      requestExecutionControl('pause').catch(function(error) {
        chatStatusEl.textContent = String(error instanceof Error ? error.message : error);
      });
    });
    chatInputEl.addEventListener('input', function() {
      chatPromptHistoryCursor = -1;
      chatPromptHistoryDraft = '';
      resizeChatInput();
    });
    resizeChatInput();
    chatFormEl.addEventListener('submit', function(event) {
      event.preventDefault();
      const message = chatInputEl.value.trim();
      if (chatProcessing) {
        const controls = activeExecutionCapabilities();
        if (!message) {
          chatStatusEl.textContent = 'Enter a steering prompt or stop the running task.';
          return;
        }
        if (!controls.steering) {
          chatStatusEl.textContent = 'Current runtime does not support steering while running.';
          return;
        }
        chatInputEl.value = '';
        resizeChatInput();
        requestExecutionControl('steer', [message]).catch(function(error) {
          chatStatusEl.textContent = String(error instanceof Error ? error.message : error);
        });
        return;
      }
      const hasAttachments = pendingChatAttachments.length > 0;
      if (!message && !hasAttachments) {
        chatStatusEl.textContent = 'Enter a message or add an attachment first.';
        return;
      }
      rememberChatPrompt(message);
      chatInputEl.value = '';
      resizeChatInput();
      Promise.resolve()
        .then(function() { return tryHandleSlashCommand(message); })
        .then(function(handled) {
          if (handled) return;
          return sendChatMessage(message);
        })
        .catch(function(error) {
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
    loadArchitectPulse();
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
        min-height: 22px;
        padding: 3px 6px;
        color: #cbd5e1;
        font-size: 10px;
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
        padding-inline: 5px;
      }

      #right-sidebar-stack {
        gap: 2px;
      }

      [data-architect-sidebar="right"] {
        padding: 6px;
      }

      [data-architect-sidebar="right"] #plan-title {
        margin: 0 24px 4px 0;
        font-size: 0.82rem;
        line-height: 1.18;
      }

      [data-architect-sidebar="right"] .status {
        margin-top: 6px;
        font-size: 0.72rem;
        line-height: 1.25;
      }

      .living-plan-foldout {
        margin-top: 6px;
        border-top: 1px solid rgba(148, 163, 184, 0.12);
      }

      .living-plan-foldout > summary {
        display: flex;
        align-items: center;
        gap: 5px;
        min-height: 20px;
        padding: 3px 0;
        color: #cbd5e1;
        cursor: pointer;
        font-size: 0.68rem;
        font-weight: 700;
        list-style-position: inside;
      }

      .living-plan-count {
        color: var(--muted);
        font-size: 0.62rem;
        font-weight: 700;
      }

      .living-plan-list {
        display: grid;
        gap: 4px;
        margin: 4px 0 0;
        padding: 0;
        list-style: none;
      }

      .living-plan-list li {
        min-width: 0;
        padding: 5px 6px;
        border: 1px solid var(--line);
        border-radius: 5px;
        background: rgba(255, 255, 255, 0.035);
        font-size: 0.68rem;
        line-height: 1.25;
        overflow-wrap: anywhere;
      }

      .living-plan-list strong {
        display: block;
        margin-bottom: 2px;
        font-size: 0.68rem;
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
  if (!isArchitectDoomEnabled()) {
    shell = shell
      .replace(/\/\* architect-doom-css:start \*\/[\s\S]*?\/\* architect-doom-css:end \*\//g, "")
      .replace(/\/\* architect-doom-script:start \*\/[\s\S]*?\/\* architect-doom-script:end \*\//g, "function suspendArchitectDoomTab() {}\n    function resumeArchitectDoomTab() {}");
  }
  return shell;
}

function handleArchitectContract(req: IncomingMessage, res: ServerResponse): void {
  sendJsonWithEtag(req, res, {
    ok: true,
    contract: "architect",
    version: "v1",
    ...buildMeta(),
    routes: {
      shell: "/architect",
      ...(isArchitectDoomEnabled() ? { doom_spike_harness: "/architect/doom-spike" } : {}),
      contract: "/api/architect",
      chat: "/api/architect/v1/chat",
      chat_method: "POST",
      chat_request_content_type: "application/json",
      chat_response_transports: ["application/json", "text/event-stream"],
      config: "POST /api/architect/v1/config",
      provider_readiness: "POST /api/architect/v1/provider-readiness",
      repo_setup: "GET|POST /api/architect/v1/repo-setup",
      onboarding_events: "GET|POST /api/architect/v1/onboarding-events",
      selection: "POST /api/architect/v1/selection",
      pulse: "GET /api/architect/v1/pulse",
      desires: "GET /api/architect/v1/desires",
      dream_playback: "GET /api/architect/v1/dreams/recent/playback",
      lifecycle: "GET /api/architect/v1/lifecycle",
      calibration_evaluation: "GET /api/architect/v1/calibration/evaluation",
      tension_clusters: "GET /api/architect/v1/tensions/clusters",
      plans: "/api/architect/v1/plans",
      plan_detail: "/api/architect/v1/plans/{planId}",
      plan_create: "POST /api/architect/v1/plans",
      plan_archive: "POST /api/architect/v1/plans/{planId}/archive",
      plugin_tabs: "GET /api/architect/v1/plugin-tabs",
      plugin_tab_snapshot: "GET /api/architect/v1/plugin-tabs/{tabTypeId}/snapshot?planId={planId}",
      plugin_tab_actions: "POST /api/architect/v1/plugin-tabs/{tabTypeId}/actions",
      events: "/api/architect/v1/events",
      plan_actions: "/api/architect/v1/plans/{planId}/actions",
      review_gates: "/api/architect/v1/plans/{planId}/review-gates",
      pending_diffs: "/api/architect/v1/plans/{planId}/pending-diffs",
      future_review: "/api/architect/v1/plans/{planId}/future-review",
      schedules: "/api/architect/v1/schedules",
      schedule_actions: "/api/architect/v1/schedules/{scheduleId}/actions",
      commands: "POST /api/architect/v1/commands",
      execution_controls: "POST /api/architect/v1/commands stop|pause|resume",
      terminals: "POST /api/architect/v1/terminals",
      terminal_input: "POST /api/architect/v1/terminals/{terminalId}/input",
      terminal_rename: "POST /api/architect/v1/terminals/{terminalId}/rename",
      terminal_close: "POST /api/architect/v1/terminals/{terminalId}/close",
      terminal_events: "GET /api/architect/v1/terminals/{terminalId}/events",
      ...(isArchitectDoomEnabled() ? {
        doom_spike_bundle_status: "GET /api/architect/v1/doom/spike-bundle/status",
        doom_spike_bundle_acquire: "POST /api/architect/v1/doom/spike-bundle/acquire",
        doom_spike_bundle: "GET /api/architect/v1/doom/spike-bundle",
      } : {}),
      editor_repos: "GET /api/architect/v1/editor/repos",
      editor_tree: "POST /api/architect/v1/editor/tree",
      editor_file_load: "POST /api/architect/v1/editor/file/load",
      editor_file_save: "POST /api/architect/v1/editor/file/save",
      editor_graph_events: "SSE graph.file_scanned|graph.file_scan_failed via /api/architect/v1/events",
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

    if (isArchitectDoomEnabled() && req.method === "GET" && pathname === "/architect/doom-spike") {
      html(res, 200, renderArchitectDoomSpikeHarness());
      return true;
    }

    if (req.method === "GET" && getArchitectBrowserAsset(pathname)) {
      await handleArchitectAssetRequest(res, pathname);
      return true;
    }

    if (req.method === "GET" && (pathname === "/api/architect" || pathname === "/api/architect/" || pathname === "/api/architect/v1" || pathname === "/api/architect/v1/")) {
      handleArchitectContract(req, res);
      return true;
    }

    if (isArchitectDoomEnabled() && req.method === "GET" && pathname === "/api/architect/v1/doom/spike-bundle/status") {
      await handleArchitectDoomSpikeBundleStatus(res);
      return true;
    }

    if (isArchitectDoomEnabled() && req.method === "POST" && pathname === "/api/architect/v1/doom/spike-bundle/acquire") {
      await handleArchitectDoomSpikeBundleAcquire(req, res);
      return true;
    }

    if (isArchitectDoomEnabled() && req.method === "GET" && pathname === "/api/architect/v1/doom/spike-bundle") {
      await handleArchitectDoomSpikeBundleRead(res);
      return true;
    }

    if (req.method === "GET" && pathname === "/api/architect/v1/editor/repos") {
      await handleArchitectEditorRepos(req, res);
      return true;
    }

    if (req.method === "POST" && pathname === "/api/architect/v1/editor/tree") {
      await handleArchitectEditorTreeRead(req, res);
      return true;
    }

    if (req.method === "POST" && pathname === "/api/architect/v1/editor/file/load") {
      await handleArchitectEditorFileLoad(req, res);
      return true;
    }

    if (req.method === "POST" && pathname === "/api/architect/v1/editor/file/save") {
      await handleArchitectEditorFileSave(req, res);
      return true;
    }

    if (pathname === "/api/architect/v1/attachments" && req.method !== "POST") {
      res.writeHead(405, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        Allow: "POST",
      });
      res.end(JSON.stringify({
        ok: false,
        error: "method_not_allowed",
        message: "Architect attachments must use POST application/json.",
      }));
      return true;
    }

    if (req.method === "POST" && pathname === "/api/architect/v1/attachments") {
      await handleArchitectAttachmentUpload(req, res);
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

    if (req.method === "POST" && pathname === "/api/architect/v1/provider-readiness") {
      await handleArchitectProviderReadinessRequest(req, res);
      return true;
    }

    if (req.method === "GET" && pathname === "/api/architect/v1/onboarding-events") {
      await handleArchitectOnboardingEventsRead(res);
      return true;
    }

    if (req.method === "POST" && pathname === "/api/architect/v1/onboarding-events") {
      await handleArchitectOnboardingEventRequest(req, res);
      return true;
    }

    if (req.method === "GET" && pathname === "/api/architect/v1/repo-setup") {
      await handleArchitectRepoSetupRead(res);
      return true;
    }

    if (req.method === "POST" && pathname === "/api/architect/v1/repo-setup") {
      await handleArchitectRepoSetupWrite(req, res);
      return true;
    }

    if (req.method === "POST" && pathname === "/api/architect/v1/selection") {
      await handleArchitectSelectionRequest(req, res);
      return true;
    }

    if (req.method === "GET" && pathname === "/api/architect/v1/pulse") {
      await handleArchitectPulseRequest(res);
      return true;
    }

    if (req.method === "GET" && pathname === "/api/architect/v1/desires") {
      await handleArchitectDesiresRequest(res);
      return true;
    }

    if (req.method === "GET" && pathname === "/api/architect/v1/dreams/recent/playback") {
      await handleArchitectDreamPlaybackRequest(res);
      return true;
    }

    if (req.method === "GET" && pathname === "/api/architect/v1/lifecycle") {
      await handleArchitectLifecycleRequest(res);
      return true;
    }

    if (req.method === "GET" && pathname === "/api/architect/v1/calibration/evaluation") {
      await handleArchitectCalibrationEvaluationRequest(res);
      return true;
    }

    if (req.method === "GET" && pathname === "/api/architect/v1/tensions/clusters") {
      await handleArchitectTensionClustersRequest(res);
      return true;
    }

    if (req.method === "POST" && pathname === "/api/architect/v1/commands") {
      await handleArchitectCommandRequest(req, res);
      return true;
    }

    if (req.method === "POST" && (pathname === "/api/architect/v1/terminals" || pathname === "/api/architect/v1/terminals/")) {
      await handleArchitectTerminalCreateRequest(req, res);
      return true;
    }

    const terminalSubroute = parseArchitectTerminalSubroute(pathname);
    if (terminalSubroute && !terminalSubroute.terminalId) {
      jsonError(res, 400, "bad_request", "Missing terminal id");
      return true;
    }

    if (req.method === "GET" && terminalSubroute?.suffix === "events") {
      handleArchitectTerminalEvents(req, res, terminalSubroute.terminalId);
      return true;
    }

    if (req.method === "POST" && terminalSubroute?.suffix === "input") {
      await handleArchitectTerminalInputRequest(req, res, terminalSubroute.terminalId);
      return true;
    }

    if (req.method === "POST" && terminalSubroute?.suffix === "rename") {
      await handleArchitectTerminalRenameRequest(req, res, terminalSubroute.terminalId);
      return true;
    }

    if (req.method === "POST" && terminalSubroute?.suffix === "close") {
      handleArchitectTerminalCloseRequest(res, terminalSubroute.terminalId);
      return true;
    }

    if (req.method === "GET" && pathname === "/api/architect/v1/plans") {
      await handlePlansIndex(req, res);
      return true;
    }

    if (req.method === "GET" && (pathname === "/api/architect/v1/plugin-tabs" || pathname === "/api/architect/v1/plugin-tabs/")) {
      await handleArchitectPluginTabsIndex(req, res);
      return true;
    }

    const pluginTabSubroute = parseArchitectPluginTabSubroute(pathname);
    if (pluginTabSubroute && !pluginTabSubroute.tabTypeId) {
      jsonError(res, 400, "bad_request", "Missing Architect plugin tab type id");
      return true;
    }
    if (req.method === "GET" && pluginTabSubroute?.suffix === "snapshot") {
      await handleArchitectPluginTabSnapshot(req, res, pluginTabSubroute.tabTypeId);
      return true;
    }
    if (req.method === "POST" && pluginTabSubroute?.suffix === "actions") {
      await handleArchitectPluginTabAction(req, res, pluginTabSubroute.tabTypeId);
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
