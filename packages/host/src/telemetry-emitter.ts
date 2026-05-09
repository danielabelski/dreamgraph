import type {
  PluginErroredPayload,
  PluginHandlerCompletedPayload,
  PluginHandlerStartedPayload,
  PluginLoadedPayload,
  PluginOutputAcceptedPayload,
  PluginOutputRejectedPayload,
  PluginRejectReason,
  PluginTelemetryEventKind,
  PluginTelemetryPayloadByKind,
  PluginUnloadedPayload,
} from "@dreamgraph/sdk";

/**
 * Adapter that bridges plugin-host telemetry into whatever event bus the
 * daemon owns. The host package is intentionally bus-agnostic so this
 * package can be unit-tested without booting the daemon.
 *
 * Implementations MUST publish the event onto the same bus that fronts
 * `/explorer/api/events` so SSE consumers and other plugins observe it
 * exactly like any other graph event.
 */
export interface TelemetryEmitter {
  emit<K extends PluginTelemetryEventKind>(
    kind: K,
    payload: PluginTelemetryPayloadByKind[K],
  ): void;
}

function nowIso(): string {
  return new Date().toISOString();
}

export interface PluginIdentity {
  plugin_id: string;
  plugin_version: string;
}

export function buildLoaded(args: {
  identity: PluginIdentity;
  runtime: PluginLoadedPayload["runtime"];
  trusted: boolean;
  capabilities: readonly string[];
}): PluginLoadedPayload {
  return {
    plugin_id: args.identity.plugin_id,
    plugin_version: args.identity.plugin_version,
    occurred_at: nowIso(),
    runtime: args.runtime,
    trusted: args.trusted,
    capabilities: args.capabilities,
  };
}

export function buildUnloaded(args: {
  identity: PluginIdentity;
  reason: PluginUnloadedPayload["reason"];
}): PluginUnloadedPayload {
  return {
    plugin_id: args.identity.plugin_id,
    plugin_version: args.identity.plugin_version,
    occurred_at: nowIso(),
    reason: args.reason,
  };
}

export function buildErrored(args: {
  identity: PluginIdentity;
  reason: PluginErroredPayload["reason"];
  message: string;
  event_loop_lag_ms?: number;
}): PluginErroredPayload {
  return {
    plugin_id: args.identity.plugin_id,
    plugin_version: args.identity.plugin_version,
    occurred_at: nowIso(),
    reason: args.reason,
    message: args.message,
    ...(args.event_loop_lag_ms !== undefined
      ? { event_loop_lag_ms: args.event_loop_lag_ms }
      : {}),
  };
}

export function buildHandlerStarted(args: {
  identity: PluginIdentity;
  correlation_id: string;
  seam: PluginHandlerStartedPayload["seam"];
  target: string;
}): PluginHandlerStartedPayload {
  return {
    plugin_id: args.identity.plugin_id,
    plugin_version: args.identity.plugin_version,
    occurred_at: nowIso(),
    correlation_id: args.correlation_id,
    seam: args.seam,
    target: args.target,
  };
}

export function buildHandlerCompleted(args: {
  identity: PluginIdentity;
  correlation_id: string;
  seam: PluginHandlerCompletedPayload["seam"];
  target: string;
  duration_ms: number;
  ok: boolean;
}): PluginHandlerCompletedPayload {
  return {
    plugin_id: args.identity.plugin_id,
    plugin_version: args.identity.plugin_version,
    occurred_at: nowIso(),
    correlation_id: args.correlation_id,
    seam: args.seam,
    target: args.target,
    duration_ms: args.duration_ms,
    ok: args.ok,
  };
}

export function buildAccepted(args: {
  identity: PluginIdentity;
  correlation_id: string;
  effect: string;
  seam: PluginOutputAcceptedPayload["seam"];
  target?: string;
}): PluginOutputAcceptedPayload {
  return {
    plugin_id: args.identity.plugin_id,
    plugin_version: args.identity.plugin_version,
    occurred_at: nowIso(),
    correlation_id: args.correlation_id,
    effect: args.effect,
    seam: args.seam,
    ...(args.target !== undefined ? { target: args.target } : {}),
  };
}

export function buildRejected(args: {
  identity: PluginIdentity;
  reason: PluginRejectReason;
  seam: PluginOutputRejectedPayload["seam"];
  correlation_id?: string;
  target?: string;
  detail?: string;
}): PluginOutputRejectedPayload {
  return {
    plugin_id: args.identity.plugin_id,
    plugin_version: args.identity.plugin_version,
    occurred_at: nowIso(),
    reason: args.reason,
    seam: args.seam,
    ...(args.correlation_id !== undefined
      ? { correlation_id: args.correlation_id }
      : {}),
    ...(args.target !== undefined ? { target: args.target } : {}),
    ...(args.detail !== undefined ? { detail: args.detail } : {}),
  };
}

/**
 * No-op emitter useful for unit tests where the host package is exercised
 * without a real bus. Records every emission for assertion.
 */
export class RecordingTelemetryEmitter implements TelemetryEmitter {
  public readonly events: Array<{
    kind: PluginTelemetryEventKind;
    payload: unknown;
  }> = [];

  emit<K extends PluginTelemetryEventKind>(
    kind: K,
    payload: PluginTelemetryPayloadByKind[K],
  ): void {
    this.events.push({ kind, payload });
  }

  clear(): void {
    this.events.length = 0;
  }
}
