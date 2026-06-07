/**
 * DreamGraph CLI - Architect daemon HTTP client.
 *
 * Thin client over the daemon-owned /api/architect/v1 contract. This module
 * owns transport concerns only; Architect state and authority stay in daemon
 * routes and MCP tools.
 */

export interface ArchitectClientOptions {
  port: number;
  timeoutMs?: number;
  chatTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface ArchitectRequestOptions {
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface CreateArchitectPlanInput {
  title: string;
  id?: string;
}

export interface ArchiveArchitectPlanInput {
  auditReason?: string;
}

export interface SetArchitectConfigInput {
  adapter?: string;
  provider?: string;
  model?: string;
  autonomyMode?: string;
}

export interface ArchitectChatInput extends SetArchitectConfigInput {
  message: string;
  planId?: string;
  scope?: "project" | "plan";
  continuationToken?: string;
  stream?: boolean;
  rawEvents?: boolean;
}

export interface ArchitectCommandInput {
  command: string;
  args?: string[];
  planId?: string;
  auditReason?: string;
}

export interface ArchitectScheduleActionInput {
  action: "run_now" | "pause" | "resume";
  planId?: string;
  sliceId?: string;
  auditReason: string;
}

export interface ArchitectJsonEvent<T = unknown> {
  type: string;
  data: T;
}

export class ArchitectDaemonError extends Error {
  readonly statusCode?: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(message: string, options: { statusCode?: number; code?: string; details?: unknown } = {}) {
    super(message);
    this.name = "ArchitectDaemonError";
    this.statusCode = options.statusCode;
    this.code = options.code;
    this.details = options.details;
  }
}

function describeDaemonError(statusCode: number, payload: unknown): string {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const message = typeof record.message === "string" ? record.message : undefined;
    const error = typeof record.error === "string" ? record.error : undefined;
    if (message && error) return `${message} (${error})`;
    if (message) return message;
    if (error) return error;
  }
  return `Architect daemon request failed with HTTP ${statusCode}`;
}

function isSensitiveKey(key: string): boolean {
  return /token|secret|password|credential|api[_-]?key|authorization/i.test(key);
}

export function redactArchitectValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[redacted:depth]";
  if (typeof value === "string") {
    return value.replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted:api-key]");
  }
  if (Array.isArray(value)) return value.map((item) => redactArchitectValue(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    redacted[key] = isSensitiveKey(key) ? "[redacted]" : redactArchitectValue(entry, depth + 1);
  }
  return redacted;
}

export async function architectRequest<T = Record<string, unknown>>(
  client: ArchitectClientOptions,
  path: string,
  options: ArchitectRequestOptions = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const timeoutMs = options.timeoutMs ?? client.timeoutMs ?? 30_000;
  const fetchImpl = client.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`http://127.0.0.1:${client.port}${path}`, {
      method,
      headers: options.body ? { "Content-Type": "application/json", Accept: "application/json" } : { Accept: "application/json" },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json")
      ? await response.json().catch(() => null)
      : await response.text().catch(() => "");

    if (!response.ok) {
      const code = payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).error === "string"
        ? (payload as Record<string, unknown>).error as string
        : undefined;
      throw new ArchitectDaemonError(describeDaemonError(response.status, payload), {
        statusCode: response.status,
        code,
        details: payload,
      });
    }

    return payload as T;
  } catch (error) {
    if (error instanceof ArchitectDaemonError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ArchitectDaemonError(`Architect daemon request timed out after ${timeoutMs}ms`, { code: "timeout" });
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ArchitectDaemonError(`Architect daemon unavailable: ${message}`, { code: "daemon_unavailable" });
  } finally {
    clearTimeout(timeout);
  }
}

export function getArchitectPulse(client: ArchitectClientOptions): Promise<Record<string, unknown>> {
  return architectRequest(client, "/api/architect/v1/pulse");
}

export function listArchitectPlans(client: ArchitectClientOptions): Promise<Record<string, unknown>> {
  return architectRequest(client, "/api/architect/v1/plans");
}

export function getArchitectPlan(client: ArchitectClientOptions, planId: string): Promise<Record<string, unknown>> {
  return architectRequest(client, `/api/architect/v1/plans/${encodeURIComponent(planId)}`);
}

export function createArchitectPlan(client: ArchitectClientOptions, input: CreateArchitectPlanInput): Promise<Record<string, unknown>> {
  return architectRequest(client, "/api/architect/v1/plans", {
    method: "POST",
    body: {
      title: input.title,
      ...(input.id ? { id: input.id } : {}),
      actor: "dreamgraph-cli",
    },
  });
}

export function selectArchitectPlan(client: ArchitectClientOptions, planId: string | null): Promise<Record<string, unknown>> {
  return architectRequest(client, "/api/architect/v1/selection", {
    method: "POST",
    body: planId == null ? { clear: true, actor: "dreamgraph-cli" } : { plan_id: planId, actor: "dreamgraph-cli" },
  });
}

export function archiveArchitectPlan(client: ArchitectClientOptions, planId: string, input: ArchiveArchitectPlanInput = {}): Promise<Record<string, unknown>> {
  return architectRequest(client, `/api/architect/v1/plans/${encodeURIComponent(planId)}/archive`, {
    method: "POST",
    body: {
      audit_reason: input.auditReason ?? `Operator archived Architect plan ${planId} from dg architect plan archive.`,
      actor: "dreamgraph-cli",
      slice_id: "slice-2-plan-lifecycle-commands",
    },
  });
}

export function getArchitectConfig(client: ArchitectClientOptions): Promise<Record<string, unknown>> {
  return architectRequest(client, "/api/architect/v1/config", { method: "POST", body: {} });
}

export function setArchitectConfig(client: ArchitectClientOptions, input: SetArchitectConfigInput): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {};
  if (input.adapter != null) body.adapter = input.adapter;
  if (input.provider != null) body.provider = input.provider;
  if (input.model != null) body.model = input.model;
  if (input.autonomyMode != null) body.autonomy_mode = input.autonomyMode;
  return architectRequest(client, "/api/architect/v1/config", { method: "POST", body });
}

export function getArchitectProviderReadiness(
  client: ArchitectClientOptions,
  input: SetArchitectConfigInput,
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {};
  if (input.adapter != null) body.adapter = input.adapter;
  if (input.provider != null) body.provider = input.provider;
  if (input.model != null) body.model = input.model;
  return architectRequest(client, "/api/architect/v1/provider-readiness", { method: "POST", body });
}

function normalizeSseEventName(name: string): string {
  if (name === "architect.chat.status") return "status";
  if (name === "architect.chat.result") return "result";
  if (name.endsWith("heartbeat") || name.endsWith("noop")) return "heartbeat";
  return name;
}

export function parseArchitectSse(text: string, options: { includeRaw?: boolean } = {}): ArchitectJsonEvent[] {
  const events: ArchitectJsonEvent[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0 || lines.every((line) => line.startsWith(":"))) continue;
    const eventLine = lines.find((line) => line.startsWith("event:"));
    const dataLines = lines.filter((line) => line.startsWith("data:"));
    const eventName = normalizeSseEventName(eventLine?.slice(6).trim() ?? "message");
    if (eventName === "heartbeat" && !options.includeRaw) continue;
    const rawData = dataLines.map((line) => line.slice(5).trimStart()).join("\n");
    let data: unknown = rawData;
    try {
      data = rawData ? JSON.parse(rawData) : null;
    } catch {
      data = rawData;
    }
    events.push({ type: eventName, data: options.includeRaw ? data : redactArchitectValue(data) });
  }
  return events;
}

export async function postArchitectChat(
  client: ArchitectClientOptions,
  input: ArchitectChatInput,
): Promise<Record<string, unknown> | { ok: true; transport: "sse"; events: ArchitectJsonEvent[]; result?: Record<string, unknown> }> {
  const timeoutMs = client.chatTimeoutMs ?? 30 * 60_000;
  const fetchImpl = client.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const body: Record<string, unknown> = {
    message: input.message,
    ...(input.planId ? { plan_id: input.planId } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.continuationToken ? { continuation_token: input.continuationToken } : {}),
    ...(input.adapter ? { adapter: input.adapter } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.autonomyMode ? { autonomy_mode: input.autonomyMode } : {}),
    ...(input.stream ? { responseTransport: "sse", stream: true } : {}),
  };

  try {
    const response = await fetchImpl(`http://127.0.0.1:${client.port}/api/architect/v1/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: input.stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("text/event-stream")
      ? await response.text().catch(() => "")
      : contentType.includes("application/json")
        ? await response.json().catch(() => null)
        : await response.text().catch(() => "");
    if (!response.ok) {
      throw new ArchitectDaemonError(describeDaemonError(response.status, payload), {
        statusCode: response.status,
        code: payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).error === "string"
          ? (payload as Record<string, unknown>).error as string
          : undefined,
        details: payload,
      });
    }
    if (typeof payload === "string") {
      const events = parseArchitectSse(payload, { includeRaw: input.rawEvents });
      const result = events.find((event) => event.type === "result")?.data;
      return {
        ok: true,
        transport: "sse",
        events,
        ...(result && typeof result === "object" ? { result: result as Record<string, unknown> } : {}),
      };
    }
    return payload as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ArchitectDaemonError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ArchitectDaemonError(`Architect chat request timed out after ${timeoutMs}ms`, { code: "timeout" });
    }
    throw new ArchitectDaemonError(`Architect daemon unavailable: ${error instanceof Error ? error.message : String(error)}`, { code: "daemon_unavailable" });
  } finally {
    clearTimeout(timeout);
  }
}

export function postArchitectCommand(client: ArchitectClientOptions, input: ArchitectCommandInput): Promise<Record<string, unknown>> {
  return architectRequest(client, "/api/architect/v1/commands", {
    method: "POST",
    body: {
      command: input.command,
      args: input.args ?? [],
      ...(input.planId ? { plan_id: input.planId } : {}),
      ...(input.auditReason ? { audit_reason: input.auditReason } : {}),
      actor: "dreamgraph-cli",
    },
  });
}

export function getArchitectEvents(client: ArchitectClientOptions): Promise<Record<string, unknown>> {
  return architectRequest(client, "/api/architect/v1/events");
}

export function listArchitectAdrs(client: ArchitectClientOptions): Promise<Record<string, unknown>> {
  return architectRequest(client, "/api/architect/v1/adrs");
}

export function getArchitectAdr(client: ArchitectClientOptions, adrId: string): Promise<Record<string, unknown>> {
  return architectRequest(client, `/api/architect/v1/adrs/${encodeURIComponent(adrId)}`);
}

export function getArchitectFutureReview(client: ArchitectClientOptions, planId: string): Promise<Record<string, unknown>> {
  return architectRequest(client, `/api/architect/v1/plans/${encodeURIComponent(planId)}/future-review`);
}

export function decideArchitectFutureReview(
  client: ArchitectClientOptions,
  planId: string,
  decision: string,
  reason: string,
): Promise<Record<string, unknown>> {
  return architectRequest(client, `/api/architect/v1/plans/${encodeURIComponent(planId)}/review-gates`, {
    method: "POST",
    body: {
      action: "future_review_decision",
      gate_id: "phase-6-adaptive-future-review",
      slice_id: "phase-6-afe-and-scheduler-integration",
      decision,
      audit_reason: reason,
      actor: "dreamgraph-cli",
    },
  });
}

export function getArchitectSchedules(client: ArchitectClientOptions): Promise<Record<string, unknown>> {
  return architectRequest(client, "/api/architect/v1/schedules");
}

export function postArchitectScheduleAction(
  client: ArchitectClientOptions,
  scheduleId: string,
  input: ArchitectScheduleActionInput,
): Promise<Record<string, unknown>> {
  return architectRequest(client, `/api/architect/v1/schedules/${encodeURIComponent(scheduleId)}/actions`, {
    method: "POST",
    body: {
      action: input.action,
      audit_reason: input.auditReason,
      actor: "dreamgraph-cli",
      ...(input.planId ? { plan_id: input.planId } : {}),
      ...(input.sliceId ? { slice_id: input.sliceId } : {}),
    },
  });
}
