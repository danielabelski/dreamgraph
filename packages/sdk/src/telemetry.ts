import type { PluginRejectReason } from "./reject-reasons.js";

/**
 * Stable plugin lifecycle/telemetry event kinds.
 *
 * Per `plans/DREAMGRAPH_SDK_ROADMAP.md` §8.3 these MUST be available in the
 * SDK from day one so that the discipline engine, narrative chronicler, and
 * operator surfaces can all reason about plugins as evaluable cognitive
 * actors. Producers land with the M3 host loader.
 *
 * The kinds are stable because the host owns emission and the payload shapes
 * are normative for every plugin runtime; plugins themselves never produce
 * them directly.
 */
export const PluginTelemetryEventKinds = [
  "plugin.loaded",
  "plugin.unloaded",
  "plugin.errored",
  "plugin.handler.started",
  "plugin.handler.completed",
  "plugin.output.accepted",
  "plugin.output.rejected",
] as const;

export type PluginTelemetryEventKind = (typeof PluginTelemetryEventKinds)[number];

export interface PluginTelemetryBase {
  plugin_id: string;
  plugin_version: string;
  occurred_at: string;
}

export interface PluginLoadedPayload extends PluginTelemetryBase {
  runtime: "in-process" | "worker";
  trusted: boolean;
  capabilities: readonly string[];
}

export interface PluginUnloadedPayload extends PluginTelemetryBase {
  reason: "shutdown" | "disable" | "reload" | "quarantine";
}

export interface PluginErroredPayload extends PluginTelemetryBase {
  reason: PluginRejectReason | "unhandled_throw";
  message: string;
  /** Wall-clock event-loop lag in ms, when reason === "event_loop_stall". */
  event_loop_lag_ms?: number;
}

export interface PluginHandlerStartedPayload extends PluginTelemetryBase {
  correlation_id: string;
  seam: "tool" | "resource" | "event" | "schedule_action";
  target: string;
}

export interface PluginHandlerCompletedPayload extends PluginTelemetryBase {
  correlation_id: string;
  seam: "tool" | "resource" | "event" | "schedule_action";
  target: string;
  duration_ms: number;
  ok: boolean;
}

export interface PluginOutputAcceptedPayload extends PluginTelemetryBase {
  correlation_id: string;
  effect: string;
  seam: "tool" | "resource" | "event" | "schedule_action" | "webhook" | "ui" | "archetype" | "policy" | "markdown_fence";
  target?: string;
}

export interface PluginOutputRejectedPayload extends PluginTelemetryBase {
  correlation_id?: string;
  reason: PluginRejectReason;
  seam: "tool" | "resource" | "event" | "schedule_action" | "webhook" | "ui" | "archetype" | "policy" | "markdown_fence" | "host";
  target?: string;
  detail?: string;
}

export type PluginTelemetryPayloadByKind = {
  "plugin.loaded": PluginLoadedPayload;
  "plugin.unloaded": PluginUnloadedPayload;
  "plugin.errored": PluginErroredPayload;
  "plugin.handler.started": PluginHandlerStartedPayload;
  "plugin.handler.completed": PluginHandlerCompletedPayload;
  "plugin.output.accepted": PluginOutputAcceptedPayload;
  "plugin.output.rejected": PluginOutputRejectedPayload;
};

export function isPluginTelemetryEventKind(
  value: unknown,
): value is PluginTelemetryEventKind {
  return (
    typeof value === "string" &&
    (PluginTelemetryEventKinds as readonly string[]).includes(value)
  );
}
