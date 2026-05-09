import type {
  ArchetypeProviderDefinition,
  MarkdownFenceDefinition,
  PluginManifest,
  PolicyProposal,
  ResourceDefinition,
  ToolDefinition,
  UiElementDefinition,
} from "@dreamgraph/sdk";

/**
 * Runtime surface passed to every plugin handler. Mirrors the contract
 * specified in `plans/DREAMGRAPH_SDK_ROADMAP.md` §5.3.
 *
 * The deny list lives in `docs/sdk/plugin-context.md`. In M3 this is an
 * API boundary, not a sandbox: `ctx` does not expose raw `fs`, `process`,
 * dynamic `import()`, internal-tier writers, tension/graph mutation,
 * `setInterval` / `setTimeout` helpers, or arbitrary network primitives.
 * Plugin code that reaches around `ctx` to Node globals is treated as a
 * trust violation and grounds for quarantine, not as a sandbox escape.
 *
 * Stronger runtime isolation is deferred to M8 (worker-thread runtime).
 */
export interface PluginIdentitySurface {
  readonly id: string;
  readonly version: string;
}

export interface PluginInstanceSurface {
  readonly uuid: string;
}

export interface PluginLogger {
  debug(message: string, meta?: object): void;
  info(message: string, meta?: object): void;
  warn(message: string, meta?: object): void;
  error(message: string, meta?: object): void;
}

export interface PluginEventEnvelope {
  readonly kind: string;
  readonly payload: unknown;
}

export type PluginEventHandler = (
  event: PluginEventEnvelope,
) => void | Promise<void>;

export interface PluginEventEmitSurface {
  emit(kind: string, payload: unknown): void;
  /**
   * Subscribe to a stable event kind. Returns an `unsubscribe` function.
   * Hosts that do not yet wire the subscription seam may return a no-op
   * unsubscribe and log a warning; callers should not rely on this for
   * critical-path behavior until the seam is documented as live.
   */
  subscribe(kind: string, handler: PluginEventHandler): () => void;
}

/**
 * Tools surface — register MCP tools contributed by the plugin (M4).
 *
 * Registration is stateful in the host's contribution registry. The
 * returned `unregister` function removes the entry so subsequent MCP
 * sessions no longer see the tool. Existing sessions retain the tool
 * binding but invocations after unregister return a `tool_unavailable`
 * error from the wrapper handler.
 */
export interface PluginToolsSurface {
  register(definition: ToolDefinition): () => void;
}

/**
 * Resources surface — register MCP resources contributed by the plugin (M4).
 * Mirrors {@link PluginToolsSurface} semantics for the `plugin://<id>/...`
 * URI namespace.
 */
export interface PluginResourcesSurface {
  register(definition: ResourceDefinition): () => void;
}

/**
 * UI surface — register semantic UI elements contributed by the plugin (M6).
 *
 * Metadata-only: the seam writes into `ui_registry.json` via the host's
 * locked write path and emits `plugin.output.accepted` /
 * `plugin.output.rejected` telemetry. The element id MUST be prefixed
 * with `<plugin-id>.` and the manifest MUST declare both the
 * `ui:register` capability and the `mutate_ui_registry` effect.
 *
 * The executable / iframe UI surface (§4.7 ui executable) is not
 * exposed here and remains post-1.0.
 */
export interface PluginUiSurface {
  register(definition: UiElementDefinition): () => void;
}

/**
 * Policies surface — propose discipline rules tagged `source: "plugin:<id>"`
 * (M6 closure, §4.6). The host journals proposals; merging into the live
 * manifest is deferred until a monotonicity model is specified.
 */
export interface PluginPoliciesSurface {
  propose(proposal: PolicyProposal): () => void;
}

/**
 * Archetypes surface — register a provider whose payload feeds federation
 * (M6 closure, §4.8). The host stores the provider record and may invoke
 * `definition.fetch()` on demand.
 */
export interface PluginArchetypesSurface {
  registerProvider(definition: ArchetypeProviderDefinition): () => void;
}

/**
 * Markdown fences surface — register a custom code-fence language the
 * webview SDK can introspect (M6 closure, §4.9). Manifest-only stub: no
 * rendering boundary is exposed in-process.
 */
export interface PluginMarkdownFencesSurface {
  register(definition: MarkdownFenceDefinition): () => void;
}

export interface PluginContext {
  readonly plugin: PluginIdentitySurface;
  readonly instance: PluginInstanceSurface;
  readonly logger: PluginLogger;
  readonly events: PluginEventEmitSurface;
  readonly tools: PluginToolsSurface;
  readonly resources: PluginResourcesSurface;
  readonly ui: PluginUiSurface;
  readonly policies: PluginPoliciesSurface;
  readonly archetypes: PluginArchetypesSurface;
  readonly markdownFences: PluginMarkdownFencesSurface;
  readonly signal: AbortSignal;
}

export interface PluginContextDependencies {
  manifest: PluginManifest;
  instanceUuid: string;
  logger: PluginLogger;
  events: PluginEventEmitSurface;
  tools: PluginToolsSurface;
  resources: PluginResourcesSurface;
  ui: PluginUiSurface;
  policies: PluginPoliciesSurface;
  archetypes: PluginArchetypesSurface;
  markdownFences: PluginMarkdownFencesSurface;
  signal: AbortSignal;
}

export function createPluginContext(
  deps: PluginContextDependencies,
): PluginContext {
  return {
    plugin: { id: deps.manifest.id, version: deps.manifest.version },
    instance: { uuid: deps.instanceUuid },
    logger: deps.logger,
    events: deps.events,
    tools: deps.tools,
    resources: deps.resources,
    ui: deps.ui,
    policies: deps.policies,
    archetypes: deps.archetypes,
    markdownFences: deps.markdownFences,
    signal: deps.signal,
  };
}

/**
 * Minimal logger implementation that prefixes every message with the plugin
 * id, matching the M3 trust-banner aesthetic and avoiding cross-plugin
 * logger leakage. Hosts may swap this out for a structured logger.
 */
export function createNamespacedLogger(
  pluginId: string,
  sink: (level: string, line: string, meta?: object) => void = (level, line) =>
    // eslint-disable-next-line no-console
    console.log(`[${level}] ${line}`),
): PluginLogger {
  const wrap = (level: "debug" | "info" | "warn" | "error") =>
    (message: string, meta?: object) =>
      sink(level, `plugin:${pluginId} ${message}`, meta);
  return {
    debug: wrap("debug"),
    info: wrap("info"),
    warn: wrap("warn"),
    error: wrap("error"),
  };
}
