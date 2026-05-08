import type {
  EventHandlerDefinition,
  PluginEventHandler,
} from "./events.js";

export const ExperimentalEventKinds = [
  "dream.cycle.completed",
  "tension.created",
  "tension.resolved",
  "candidate.added",
  "candidate.promoted",
  "candidate.rejected",
  "audit.appended",
] as const;

export type ExperimentalEventKind = (typeof ExperimentalEventKinds)[number];

export function defineExperimentalEventHandler<
  K extends ExperimentalEventKind,
  P = unknown,
>(
  kind: K,
  handler: PluginEventHandler<K, P>,
): EventHandlerDefinition<K, P> {
  return { kind, experimental: true, handler };
}
