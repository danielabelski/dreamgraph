export const StableEventKinds = [
  "snapshot.changed",
  "cache.invalidated",
] as const;

export type StableEventKind = (typeof StableEventKinds)[number];

/**
 * Default SDK event kind surface. Experimental event kinds are intentionally
 * excluded; import them from `@dreamgraph/sdk/events/experimental`.
 */
export type EventKind = StableEventKind;

export interface PluginEvent<K extends string = EventKind, P = unknown> {
  kind: K;
  payload: P;
  occurredAt?: string;
}

export interface PluginEventContext {
  pluginId: string;
  signal?: AbortSignal;
}

export type PluginEventHandler<K extends string = EventKind, P = unknown> = (
  event: PluginEvent<K, P>,
  context: PluginEventContext,
) => void | Promise<void>;

export interface EventHandlerDefinition<K extends string = EventKind, P = unknown> {
  kind: K;
  experimental: boolean;
  handler: PluginEventHandler<K, P>;
}

export function defineEventHandler<K extends StableEventKind, P = unknown>(
  kind: K,
  handler: PluginEventHandler<K, P>,
): EventHandlerDefinition<K, P> {
  return { kind, experimental: false, handler };
}
