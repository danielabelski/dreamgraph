/**
 * Plugin manager — daemon-side glue between `@dreamgraph/host` and the
 * running DreamGraph process.
 *
 * Owns the singleton {@link PluginRegistry}, the {@link TelemetryEmitter}
 * bridge that re-publishes plugin telemetry on the `graphEventBus`, and
 * the bootstrap entry point invoked at daemon startup.
 *
 * The host package is intentionally bus-agnostic; this module is the only
 * place that knows about `graphEventBus`, `getActiveScope()`, and the
 * `DG_ALLOW_INPROCESS_PLUGINS` env switch.
 */

import {
  buildErrored,
  buildHandlerCompleted,
  buildHandlerStarted,
  buildAccepted,
  buildRejected,
  createNamespacedLogger,
  createPluginContext,
  discoverPlugins,
  loadDiscoveredPlugins,
  PluginRegistry,
  unloadPlugin,
  type DiscoveredPlugin,
  type PluginContext,
  type PluginEventHandler,
  type PluginLoadOutcome,
  type TelemetryEmitter,
} from "@dreamgraph/host";
import type {
  ArchetypeProviderDefinition,
  MarkdownFenceDefinition,
  PluginTelemetryEventKind,
  PluginTelemetryPayloadByKind,
  PolicyProposal,
  ResourceDefinition,
  ToolDefinition,
  UiElementDefinition,
} from "@dreamgraph/sdk";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { graphEventBus, type GraphEventKind } from "../graph/events.js";
import { getActiveScope } from "../instance/index.js";
import { logger } from "../utils/logger.js";
import { applyPluginUiElement, removePluginUiElements } from "../tools/ui-registry.js";
import {
  applyPluginArchetypeProvider,
  applyPluginMarkdownFence,
  applyPluginPolicyProposal,
  removePluginArchetypeProviders,
  removePluginMarkdownFences,
  removePluginPolicyProposals,
} from "./closure-stores.js";

class GraphEventBusTelemetryBridge implements TelemetryEmitter {
  emit<K extends PluginTelemetryEventKind>(
    kind: K,
    payload: PluginTelemetryPayloadByKind[K],
  ): void {
    graphEventBus.emit(kind as GraphEventKind, {
      payload: payload as unknown as Record<string, unknown>,
    });
  }
}

let _registry: PluginRegistry | null = null;
let _telemetry: TelemetryEmitter | null = null;
let _bootstrapped = false;
let _lastDiscovered: DiscoveredPlugin[] = [];

/** Plugin runtime handle: lifecycle controls created when activate() succeeds. */
interface ActivePluginHandle {
  pluginId: string;
  abortController: AbortController;
  unsubscribers: Array<() => void>;
  deactivate?: () => void | Promise<void>;
}
const _activeHandles = new Map<string, ActivePluginHandle>();

/**
 * Plugin-contributed MCP tools/resources (M4). Keyed by plugin id so we
 * can drop all of a plugin's contributions on unload/reload without
 * leaking entries into subsequent MCP sessions.
 */
export interface ContributedTool {
  pluginId: string;
  pluginVersion: string;
  definition: ToolDefinition;
  /** Set false on unregister; wrapper handler short-circuits. */
  active: boolean;
}
export interface ContributedResource {
  pluginId: string;
  pluginVersion: string;
  definition: ResourceDefinition;
  active: boolean;
}
const _contributedTools = new Map<string, ContributedTool[]>();
const _contributedResources = new Map<string, ContributedResource[]>();

/** Stable event kinds plugins may subscribe to (M3). */
const SUBSCRIBABLE_KINDS: ReadonlySet<string> = new Set([
  "snapshot.changed",
  "cache.invalidated",
]);

/** Reserved event-kind prefixes plugins are not allowed to emit. */
const RESERVED_EMIT_PREFIXES = ["plugin."];

export function getPluginRegistry(): PluginRegistry {
  if (!_registry) _registry = new PluginRegistry();
  return _registry;
}

export function getPluginTelemetry(): TelemetryEmitter {
  if (!_telemetry) _telemetry = new GraphEventBusTelemetryBridge();
  return _telemetry;
}

export function getLastDiscoveredPlugins(): readonly DiscoveredPlugin[] {
  return _lastDiscovered;
}

/** All currently-contributed MCP tools across active plugins. */
export function getContributedTools(): ContributedTool[] {
  const out: ContributedTool[] = [];
  for (const list of _contributedTools.values()) {
    for (const c of list) if (c.active) out.push(c);
  }
  return out;
}

/** All currently-contributed MCP resources across active plugins. */
export function getContributedResources(): ContributedResource[] {
  const out: ContributedResource[] = [];
  for (const list of _contributedResources.values()) {
    for (const c of list) if (c.active) out.push(c);
  }
  return out;
}

/** True if a plugin is currently activated (its activate() returned). */
export function isPluginActivated(pluginId: string): boolean {
  return _activeHandles.has(pluginId);
}

/** Subscription count for a plugin (events bus subscriptions). */
export function getPluginSubscriptionCount(pluginId: string): number {
  return _activeHandles.get(pluginId)?.unsubscribers.length ?? 0;
}

/**
 * Read the in-process safety switch from env. Defaults to deny (false).
 *
 * Operators opt in by setting `DG_ALLOW_INPROCESS_PLUGINS=true`; an
 * individual plugin may also be allowed via `instance.json:plugins[].trusted`.
 */
export function readAllowInProcessFromEnv(): boolean {
  const raw = process.env.DG_ALLOW_INPROCESS_PLUGINS;
  return raw === "1" || raw === "true";
}

export interface BootstrapPluginsResult {
  ran: boolean;
  outcomes: PluginLoadOutcome[];
  reason?: string;
}

/**
 * Discover and load plugins for the active instance. Idempotent: a second
 * call is a no-op. Safe to call in legacy mode (no instance scope) — it
 * simply skips with `{ ran: false, reason: "no-active-scope" }` because
 * legacy mode has no `<instance>/plugins/` directory or `instance.json`.
 */
export async function bootstrapPlugins(): Promise<BootstrapPluginsResult> {
  if (_bootstrapped) {
    return { ran: false, outcomes: [], reason: "already-bootstrapped" };
  }
  const scope = getActiveScope();
  if (!scope) {
    _bootstrapped = true;
    return { ran: false, outcomes: [], reason: "no-active-scope" };
  }

  _bootstrapped = true;
  const registry = getPluginRegistry();
  const telemetry = getPluginTelemetry();
  const allowInProcess = readAllowInProcessFromEnv();

  const loaderOptions = {
    instanceRoot: scope.instanceRoot,
    instanceUuid: scope.uuid,
    telemetry,
    safety: {
      allowInProcessPlugins: allowInProcess,
      bannerSink: (line: string) => logger.warn(line),
    },
  };

  let discovered: DiscoveredPlugin[] = [];
  try {
    discovered = await discoverPlugins(loaderOptions);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Plugin discovery failed: ${msg}`);
    return { ran: true, outcomes: [], reason: `discovery-failed: ${msg}` };
  }
  _lastDiscovered = discovered;

  if (discovered.length === 0) {
    logger.info("Plugin discovery: no plugins found in <instance>/plugins or instance.json");
    return { ran: true, outcomes: [] };
  }

  logger.info(
    `Plugin discovery: ${discovered.length} candidate(s); allowInProcessPlugins=${allowInProcess}`,
  );

  const outcomes = await loadDiscoveredPlugins({
    loader: loaderOptions,
    registry,
    discovered,
  });

  const loaded = outcomes.filter((o) => o.status === "loaded").length;
  const rejected = outcomes.length - loaded;
  logger.info(`Plugins loaded: ${loaded}; rejected: ${rejected}`);

  // Post-load activation seam: dynamically import each loaded plugin's
  // entry module and invoke its `activate(ctx)` export. This is
  // best-effort — failures are logged + telemetry-reported but do not
  // unwind the registry entry (the host already considers the plugin
  // loaded for trust-banner / system://plugins purposes).
  for (const outcome of outcomes) {
    if (outcome.status !== "loaded") continue;
    const plugin = discovered.find(
      (d) => d.manifest.id === outcome.manifest.id,
    );
    if (!plugin) continue;
    await activateLoadedPlugin(plugin, telemetry);
  }

  return { ran: true, outcomes };
}

async function activateLoadedPlugin(
  plugin: DiscoveredPlugin,
  telemetry: TelemetryEmitter,
): Promise<void> {
  if (!plugin.rootDir) return;
  const identity = {
    plugin_id: plugin.manifest.id,
    plugin_version: plugin.manifest.version,
  };
  const entryPath = path.join(plugin.rootDir, plugin.manifest.main);
  const moduleUrl = pathToFileURL(entryPath).href;

  let mod: Record<string, unknown>;
  try {
    mod = (await import(moduleUrl)) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      `Plugin ${plugin.manifest.id} import failed: ${msg}`,
    );
    telemetry.emit(
      "plugin.errored",
      buildErrored({
        identity,
        reason: "manifest_invalid",
        message: `import failed: ${msg}`,
      }),
    );
    return;
  }

  const activate = resolveActivate(mod);
  if (!activate) {
    logger.warn(
      `Plugin ${plugin.manifest.id} has no activate() export; module loaded but inert`,
    );
    return;
  }

  const abortController = new AbortController();
  const unsubscribers: Array<() => void> = [];
  const scope = getActiveScope();
  const instanceUuid = scope ? scope.uuid : "unknown";

  const ctx: PluginContext = createPluginContext({
    manifest: plugin.manifest,
    instanceUuid,
    logger: createNamespacedLogger(plugin.manifest.id, (level, line) => {
      if (level === "error") logger.error(line);
      else if (level === "warn") logger.warn(line);
      else if (level === "debug") logger.debug(line);
      else logger.info(line);
    }),
    events: {
      emit(kind, payload) {
        if (typeof kind !== "string") return;
        if (RESERVED_EMIT_PREFIXES.some((p) => kind.startsWith(p))) {
          logger.warn(
            `Plugin ${plugin.manifest.id} attempted to emit reserved kind '${kind}'; ignored`,
          );
          return;
        }
        graphEventBus.emit(kind as GraphEventKind, {
          payload: (payload ?? {}) as Record<string, unknown>,
        });
      },
      subscribe(kind, handler) {
        if (!SUBSCRIBABLE_KINDS.has(kind)) {
          logger.warn(
            `Plugin ${plugin.manifest.id} subscribed to unsupported kind '${kind}'; returning no-op unsubscribe`,
          );
          return () => {};
        }
        const unsub = graphEventBus.subscribe((evt) => {
          if (evt.kind !== kind) return;
          void invokeHandler({
            handler,
            event: { kind: evt.kind, payload: evt.payload },
            identity,
            telemetry,
            pluginId: plugin.manifest.id,
          });
        });
        unsubscribers.push(unsub);
        return unsub;
      },
    },
    tools: {
      register(definition) {
        return registerContributedTool({
          plugin,
          identity,
          telemetry,
          definition,
        });
      },
    },
    resources: {
      register(definition) {
        return registerContributedResource({
          plugin,
          identity,
          telemetry,
          definition,
        });
      },
    },
    ui: {
      register(definition) {
        return registerContributedUiElement({
          plugin,
          identity,
          telemetry,
          definition,
        });
      },
    },
    policies: {
      propose(proposal) {
        return registerContributedPolicy({
          plugin,
          identity,
          telemetry,
          proposal,
        });
      },
    },
    archetypes: {
      registerProvider(definition) {
        return registerContributedArchetypeProvider({
          plugin,
          identity,
          telemetry,
          definition,
        });
      },
    },
    markdownFences: {
      register(definition) {
        return registerContributedMarkdownFence({
          plugin,
          identity,
          telemetry,
          definition,
        });
      },
    },
    signal: abortController.signal,
  });

  let result: unknown;
  try {
    const activateFn = activate as (c: PluginContext) => unknown;
    result = await activateFn(ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      `Plugin ${plugin.manifest.id} activate() threw: ${msg}`,
    );
    telemetry.emit(
      "plugin.errored",
      buildErrored({
        identity,
        reason: "handler_threw",
        message: `activate() threw: ${msg}`,
      }),
    );
    for (const u of unsubscribers) {
      try {
        u();
      } catch {
        /* swallow */
      }
    }
    return;
  }

  const deactivate =
    result && typeof result === "object" && "deactivate" in result &&
      typeof (result as { deactivate?: unknown }).deactivate === "function"
      ? (result as { deactivate: () => void | Promise<void> }).deactivate
      : undefined;

  _activeHandles.set(plugin.manifest.id, {
    pluginId: plugin.manifest.id,
    abortController,
    unsubscribers,
    ...(deactivate ? { deactivate } : {}),
  });

  logger.info(
    `Plugin ${plugin.manifest.id} activated (${unsubscribers.length} subscription(s))`,
  );
}

function resolveActivate(mod: Record<string, unknown>): unknown {
  if (typeof mod.activate === "function") return mod.activate;
  const def = mod.default as unknown;
  if (typeof def === "function") return def;
  if (
    def && typeof def === "object" && "activate" in def &&
    typeof (def as { activate?: unknown }).activate === "function"
  ) {
    return (def as { activate: unknown }).activate;
  }
  return null;
}

async function invokeHandler(args: {
  handler: PluginEventHandler;
  event: { kind: string; payload: unknown };
  identity: { plugin_id: string; plugin_version: string };
  telemetry: TelemetryEmitter;
  pluginId: string;
}): Promise<void> {
  const correlation_id = `${args.identity.plugin_id}:${args.event.kind}:${Date.now().toString(36)}`;
  const startedAt = Date.now();
  args.telemetry.emit(
    "plugin.handler.started",
    buildHandlerStarted({
      identity: args.identity,
      correlation_id,
      seam: "event",
      target: args.event.kind,
    }),
  );
  let ok = true;
  try {
    await args.handler(args.event);
  } catch (err) {
    ok = false;
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      `Plugin ${args.pluginId} handler for '${args.event.kind}' threw: ${msg}`,
    );
    args.telemetry.emit(
      "plugin.errored",
      buildErrored({
        identity: args.identity,
        reason: "handler_threw",
        message: msg,
      }),
    );
  } finally {
    args.telemetry.emit(
      "plugin.handler.completed",
      buildHandlerCompleted({
        identity: args.identity,
        correlation_id,
        seam: "event",
        target: args.event.kind,
        duration_ms: Date.now() - startedAt,
        ok,
      }),
    );
  }
}

/* ------------------------------------------------------------------ */
/*  M4 — plugin-contributed tools/resources gates                     */
/* ------------------------------------------------------------------ */

function emitContribReject(args: {
  telemetry: TelemetryEmitter;
  identity: { plugin_id: string; plugin_version: string };
  reason: Parameters<typeof buildRejected>[0]["reason"];
  seam: Parameters<typeof buildRejected>[0]["seam"];
  target: string;
  detail?: string;
}): () => void {
  args.telemetry.emit(
    "plugin.output.rejected",
    buildRejected({
      identity: args.identity,
      reason: args.reason,
      seam: args.seam,
      ...(args.detail !== undefined ? { detail: args.detail } : {}),
    }),
  );
  logger.warn(
    `Plugin ${args.identity.plugin_id} ${args.seam} '${args.target}' rejected: ${args.reason}` +
      (args.detail ? ` (${args.detail})` : ""),
  );
  return () => {};
}

function registerContributedTool(args: {
  plugin: DiscoveredPlugin;
  identity: { plugin_id: string; plugin_version: string };
  telemetry: TelemetryEmitter;
  definition: ToolDefinition;
}): () => void {
  const { plugin, identity, telemetry, definition } = args;
  const expectedPrefix = plugin.manifest.id.replace(/[^a-zA-Z0-9_]/g, '_') + '_';
  // Capability gate
  if (!plugin.manifest.capabilities.includes("tools:register")) {
    return emitContribReject({
      telemetry,
      identity,
      reason: "tool_capability_missing",
      seam: "tool",
      target: definition.name,
      detail: "manifest.capabilities must include 'tools:register'",
    });
  }
  // Naming gate — must be `<plugin-id>.<suffix>`
  if (!definition.name.startsWith(expectedPrefix)) {
    return emitContribReject({
      telemetry,
      identity,
      reason: "tool_name_unprefixed",
      seam: "tool",
      target: definition.name,
      detail: `tool name must start with '${expectedPrefix}'`,
    });
  }
  // Effect gate — every expectedEffect must be in manifest.expectedEffects
  for (const eff of definition.expectedEffects) {
    if (!plugin.manifest.expectedEffects.includes(eff)) {
      return emitContribReject({
        telemetry,
        identity,
        reason: "effect_undeclared",
        seam: "tool",
        target: definition.name,
        detail: `effect '${eff}' not in manifest.expectedEffects`,
      });
    }
    if (plugin.manifest.forbiddenEffects.includes(eff)) {
      return emitContribReject({
        telemetry,
        identity,
        reason: "effect_forbidden",
        seam: "tool",
        target: definition.name,
        detail: `effect '${eff}' is in manifest.forbiddenEffects`,
      });
    }
  }
  // Collision gate — across all active plugins
  for (const list of _contributedTools.values()) {
    for (const c of list) {
      if (c.active && c.definition.name === definition.name) {
        return emitContribReject({
          telemetry,
          identity,
          reason: "tool_name_collision",
          seam: "tool",
          target: definition.name,
          detail: `tool name already registered by ${c.pluginId}`,
        });
      }
    }
  }
  const entry: ContributedTool = {
    pluginId: plugin.manifest.id,
    pluginVersion: plugin.manifest.version,
    definition,
    active: true,
  };
  const list = _contributedTools.get(plugin.manifest.id) ?? [];
  list.push(entry);
  _contributedTools.set(plugin.manifest.id, list);
  telemetry.emit(
    "plugin.output.accepted",
    {
      plugin_id: identity.plugin_id,
      plugin_version: identity.plugin_version,
      occurred_at: new Date().toISOString(),
      correlation_id: `${identity.plugin_id}:tool.register:${Date.now().toString(36)}`,
      effect: "emit_tool",
      seam: "tool",
      target: definition.name,
    } as PluginTelemetryPayloadByKind["plugin.output.accepted"],
  );
  logger.info(
    `Plugin ${plugin.manifest.id} registered tool '${definition.name}'`,
  );
  return () => {
    entry.active = false;
  };
}

function registerContributedResource(args: {
  plugin: DiscoveredPlugin;
  identity: { plugin_id: string; plugin_version: string };
  telemetry: TelemetryEmitter;
  definition: ResourceDefinition;
}): () => void {
  const { plugin, identity, telemetry, definition } = args;
  const expectedNamespace = `plugin://${plugin.manifest.id}`;
  if (!plugin.manifest.capabilities.includes("resources:register")) {
    return emitContribReject({
      telemetry,
      identity,
      reason: "resource_capability_missing",
      seam: "resource",
      target: definition.uriNamespace,
      detail: "manifest.capabilities must include 'resources:register'",
    });
  }
  if (
    definition.uriNamespace !== expectedNamespace &&
    !definition.uriNamespace.startsWith(`${expectedNamespace}/`)
  ) {
    return emitContribReject({
      telemetry,
      identity,
      reason: "resource_uri_out_of_namespace",
      seam: "resource",
      target: definition.uriNamespace,
      detail: `resource uri must start with '${expectedNamespace}'`,
    });
  }
  for (const eff of definition.expectedEffects) {
    if (!plugin.manifest.expectedEffects.includes(eff)) {
      return emitContribReject({
        telemetry,
        identity,
        reason: "effect_undeclared",
        seam: "resource",
        target: definition.uriNamespace,
        detail: `effect '${eff}' not in manifest.expectedEffects`,
      });
    }
    if (plugin.manifest.forbiddenEffects.includes(eff)) {
      return emitContribReject({
        telemetry,
        identity,
        reason: "effect_forbidden",
        seam: "resource",
        target: definition.uriNamespace,
        detail: `effect '${eff}' is in manifest.forbiddenEffects`,
      });
    }
  }
  const entry: ContributedResource = {
    pluginId: plugin.manifest.id,
    pluginVersion: plugin.manifest.version,
    definition,
    active: true,
  };
  const list = _contributedResources.get(plugin.manifest.id) ?? [];
  list.push(entry);
  _contributedResources.set(plugin.manifest.id, list);
  telemetry.emit(
    "plugin.output.accepted",
    {
      plugin_id: identity.plugin_id,
      plugin_version: identity.plugin_version,
      occurred_at: new Date().toISOString(),
      correlation_id: `${identity.plugin_id}:resource.register:${Date.now().toString(36)}`,
      effect: "emit_resource",
      seam: "resource",
      target: definition.uriNamespace,
    } as PluginTelemetryPayloadByKind["plugin.output.accepted"],
  );
  logger.info(
    `Plugin ${plugin.manifest.id} registered resource '${definition.uriNamespace}'`,
  );
  return () => {
    entry.active = false;
  };
}

/* ------------------------------------------------------------------ */
/*  M6 — plugin-contributed UI elements                                */
/* ------------------------------------------------------------------ */

/**
 * Track plugin-contributed UI elements so we can prune them on unload.
 * The actual element data lives in `ui_registry.json`; we only need ids
 * here to drive the inverse op via `removePluginUiElements`.
 */
const _contributedUiIds = new Map<string, Set<string>>();

export function getContributedUiElementIds(pluginId: string): readonly string[] {
  return Array.from(_contributedUiIds.get(pluginId) ?? []);
}

function registerContributedUiElement(args: {
  plugin: DiscoveredPlugin;
  identity: { plugin_id: string; plugin_version: string };
  telemetry: TelemetryEmitter;
  definition: UiElementDefinition;
}): () => void {
  const { plugin, identity, telemetry, definition } = args;
  // UI element ids retain the raw <plugin-id>. prefix (dotted form). Unlike MCP tool names
  // (which must be model-safe snake_case), UI ids are namespaced human-readable identifiers
  // and preserve the natural plugin id so they remain stable across registries and docs.
  const expectedPrefix = plugin.manifest.id + '.';

  if (!plugin.manifest.capabilities.includes("ui:register")) {
    return emitContribReject({
      telemetry,
      identity,
      reason: "ui_capability_missing",
      seam: "ui",
      target: definition.id,
      detail: "manifest.capabilities must include 'ui:register'",
    });
  }
  if (!definition.id.startsWith(expectedPrefix)) {
    return emitContribReject({
      telemetry,
      identity,
      reason: "ui_id_unprefixed",
      seam: "ui",
      target: definition.id,
      detail: `ui element id must start with '${expectedPrefix}'`,
    });
  }
  if (!plugin.manifest.expectedEffects.includes("mutate_ui_registry")) {
    return emitContribReject({
      telemetry,
      identity,
      reason: "effect_undeclared",
      seam: "ui",
      target: definition.id,
      detail: "effect 'mutate_ui_registry' not in manifest.expectedEffects",
    });
  }
  if (plugin.manifest.forbiddenEffects.includes("mutate_ui_registry")) {
    return emitContribReject({
      telemetry,
      identity,
      reason: "effect_forbidden",
      seam: "ui",
      target: definition.id,
      detail: "effect 'mutate_ui_registry' is in manifest.forbiddenEffects",
    });
  }
  // Effect declarations on the definition itself must be a subset of the
  // manifest's expectedEffects (mirrors tools/resources gating).
  for (const eff of definition.expectedEffects ?? []) {
    if (!plugin.manifest.expectedEffects.includes(eff)) {
      return emitContribReject({
        telemetry,
        identity,
        reason: "effect_undeclared",
        seam: "ui",
        target: definition.id,
        detail: `effect '${eff}' not in manifest.expectedEffects`,
      });
    }
  }

  // Track id eagerly; the registry write below is async and we want
  // unload to clean up even if the write loses to a race.
  const ids = _contributedUiIds.get(plugin.manifest.id) ?? new Set<string>();
  ids.add(definition.id);
  _contributedUiIds.set(plugin.manifest.id, ids);

  // Fire-and-forget the file write; never let a registry write throw
  // into the activate() call. Failures are logged + telemetry-reported.
  void applyPluginUiElement(plugin.manifest.id, {
    id: definition.id,
    name: definition.name,
    purpose: definition.purpose,
    category: definition.category,
    inputs: definition.inputs,
    outputs: definition.outputs,
    interactions: definition.interactions,
    ...(definition.children !== undefined ? { children: definition.children } : {}),
    ...(definition.implementations !== undefined
      ? { implementations: definition.implementations }
      : {}),
    ...(definition.used_by !== undefined ? { used_by: definition.used_by } : {}),
    ...(definition.tags !== undefined ? { tags: definition.tags } : {}),
  })
    .then(({ merged }) => {
      telemetry.emit(
        "plugin.output.accepted",
        {
          plugin_id: identity.plugin_id,
          plugin_version: identity.plugin_version,
          occurred_at: new Date().toISOString(),
          correlation_id: `${identity.plugin_id}:ui.register:${Date.now().toString(36)}`,
          effect: "mutate_ui_registry",
          seam: "ui",
          target: definition.id,
        } as PluginTelemetryPayloadByKind["plugin.output.accepted"],
      );
      logger.info(
        `Plugin ${plugin.manifest.id} ${merged ? "updated" : "registered"} UI element '${definition.id}'`,
      );
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      emitContribReject({
        telemetry,
        identity,
        reason: "handler_threw",
        seam: "ui",
        target: definition.id,
        detail: msg,
      });
    });

  return () => {
    ids.delete(definition.id);
  };
}

/* ------------------------------------------------------------------ */
/*  M6 closure — policies / archetypes / markdown_fences seams         */
/* ------------------------------------------------------------------ */

const _contributedPolicyIds = new Map<string, Set<string>>();
const _contributedArchetypeIds = new Map<string, Set<string>>();
const _contributedFenceLanguages = new Map<string, Set<string>>();

export function getContributedPolicyIds(pluginId: string): readonly string[] {
  return Array.from(_contributedPolicyIds.get(pluginId) ?? []);
}
export function getContributedArchetypeProviderIds(pluginId: string): readonly string[] {
  return Array.from(_contributedArchetypeIds.get(pluginId) ?? []);
}
export function getContributedMarkdownFenceLanguages(pluginId: string): readonly string[] {
  return Array.from(_contributedFenceLanguages.get(pluginId) ?? []);
}

function emitContribAccept(args: {
  telemetry: TelemetryEmitter;
  identity: { plugin_id: string; plugin_version: string };
  effect: string;
  seam: Parameters<typeof buildAccepted>[0]["seam"];
  target: string;
}): void {
  args.telemetry.emit(
    "plugin.output.accepted",
    buildAccepted({
      identity: args.identity,
      correlation_id: `${args.identity.plugin_id}:${args.seam}.register:${Date.now().toString(36)}`,
      effect: args.effect,
      seam: args.seam,
      target: args.target,
    }),
  );
}

function registerContributedPolicy(args: {
  plugin: DiscoveredPlugin;
  identity: { plugin_id: string; plugin_version: string };
  telemetry: TelemetryEmitter;
  proposal: PolicyProposal;
}): () => void {
  const { plugin, identity, telemetry, proposal } = args;
  if (!plugin.manifest.capabilities.includes("policy:propose")) {
    return emitContribReject({
      telemetry,
      identity,
      reason: "policy_capability_missing",
      seam: "policy",
      target: proposal.id,
      detail: "manifest.capabilities must include 'policy:propose'",
    });
  }
  if (!plugin.manifest.expectedEffects.includes("propose_policy")) {
    return emitContribReject({
      telemetry,
      identity,
      reason: "effect_undeclared",
      seam: "policy",
      target: proposal.id,
      detail: "effect 'propose_policy' not in manifest.expectedEffects",
    });
  }
  if (proposal.weakens === true) {
    return emitContribReject({
      telemetry,
      identity,
      reason: "policy_weakening_rejected",
      seam: "policy",
      target: proposal.id,
      detail: "proposals that weaken existing rules are not accepted",
    });
  }
  const proposal_id = `${plugin.manifest.id}:${proposal.id}`;
  const ids = _contributedPolicyIds.get(plugin.manifest.id) ?? new Set<string>();
  ids.add(proposal_id);
  _contributedPolicyIds.set(plugin.manifest.id, ids);

  void applyPluginPolicyProposal(plugin.manifest.id, proposal)
    .then(({ replaced }) => {
      emitContribAccept({
        telemetry,
        identity,
        effect: "propose_policy",
        seam: "policy",
        target: proposal_id,
      });
      logger.info(
        `Plugin ${plugin.manifest.id} ${replaced ? "updated" : "proposed"} policy '${proposal_id}'`,
      );
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      emitContribReject({
        telemetry,
        identity,
        reason: "handler_threw",
        seam: "policy",
        target: proposal_id,
        detail: msg,
      });
    });

  return () => {
    ids.delete(proposal_id);
  };
}

function registerContributedArchetypeProvider(args: {
  plugin: DiscoveredPlugin;
  identity: { plugin_id: string; plugin_version: string };
  telemetry: TelemetryEmitter;
  definition: ArchetypeProviderDefinition;
}): () => void {
  const { plugin, identity, telemetry, definition } = args;
  if (!plugin.manifest.capabilities.includes("archetypes:provide")) {
    return emitContribReject({
      telemetry,
      identity,
      reason: "archetype_capability_missing",
      seam: "archetype",
      target: definition.id,
      detail: "manifest.capabilities must include 'archetypes:provide'",
    });
  }
  if (!plugin.manifest.expectedEffects.includes("provide_archetypes")) {
    return emitContribReject({
      telemetry,
      identity,
      reason: "effect_undeclared",
      seam: "archetype",
      target: definition.id,
      detail: "effect 'provide_archetypes' not in manifest.expectedEffects",
    });
  }
  // Minimum schema gate: provider must offer at least one fetch path.
  if (!definition.url && !definition.inline && !definition.fetch) {
    return emitContribReject({
      telemetry,
      identity,
      reason: "archetype_schema_invalid",
      seam: "archetype",
      target: definition.id,
      detail: "provider must specify one of url, inline, or fetch()",
    });
  }
  const { provider_id, replaced } = applyPluginArchetypeProvider(
    plugin.manifest.id,
    definition,
  );
  const ids = _contributedArchetypeIds.get(plugin.manifest.id) ?? new Set<string>();
  ids.add(provider_id);
  _contributedArchetypeIds.set(plugin.manifest.id, ids);
  emitContribAccept({
    telemetry,
    identity,
    effect: "provide_archetypes",
    seam: "archetype",
    target: provider_id,
  });
  logger.info(
    `Plugin ${plugin.manifest.id} ${replaced ? "updated" : "registered"} archetype provider '${provider_id}'`,
  );
  return () => {
    ids.delete(provider_id);
  };
}

function registerContributedMarkdownFence(args: {
  plugin: DiscoveredPlugin;
  identity: { plugin_id: string; plugin_version: string };
  telemetry: TelemetryEmitter;
  definition: MarkdownFenceDefinition;
}): () => void {
  const { plugin, identity, telemetry, definition } = args;
  if (!plugin.manifest.capabilities.includes("markdown:register_fence")) {
    return emitContribReject({
      telemetry,
      identity,
      reason: "markdown_fence_capability_missing",
      seam: "markdown_fence",
      target: definition.language,
      detail: "manifest.capabilities must include 'markdown:register_fence'",
    });
  }
  if (!plugin.manifest.expectedEffects.includes("render_markdown_fence")) {
    return emitContribReject({
      telemetry,
      identity,
      reason: "effect_undeclared",
      seam: "markdown_fence",
      target: definition.language,
      detail: "effect 'render_markdown_fence' not in manifest.expectedEffects",
    });
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(definition.language)) {
    return emitContribReject({
      telemetry,
      identity,
      reason: "markdown_fence_language_invalid",
      seam: "markdown_fence",
      target: definition.language,
      detail: "language must be lowercase, dot/dash/underscore separated",
    });
  }
  const result = applyPluginMarkdownFence(plugin.manifest.id, definition);
  if (!result.ok) {
    return emitContribReject({
      telemetry,
      identity,
      reason: "markdown_fence_language_collision",
      seam: "markdown_fence",
      target: definition.language,
      detail: `language already owned by plugin '${result.owner}'`,
    });
  }
  const langs = _contributedFenceLanguages.get(plugin.manifest.id) ?? new Set<string>();
  langs.add(definition.language);
  _contributedFenceLanguages.set(plugin.manifest.id, langs);
  emitContribAccept({
    telemetry,
    identity,
    effect: "render_markdown_fence",
    seam: "markdown_fence",
    target: definition.language,
  });
  logger.info(
    `Plugin ${plugin.manifest.id} ${result.replaced ? "updated" : "registered"} markdown fence '${definition.language}'`,
  );
  return () => {
    langs.delete(definition.language);
  };
}

/* ------------------------------------------------------------------ */
/*  M3.5 — hot unload / reload                                         */
/* ------------------------------------------------------------------ */

/** Tear down a single plugin: deactivate, unsubscribe, drop contributions, unload from registry. */
export async function unloadPluginById(
  pluginId: string,
  reason: "shutdown" | "disable" | "reload" | "quarantine" = "disable",
): Promise<{ unloaded: boolean }> {
  const handle = _activeHandles.get(pluginId);
  if (handle) {
    handle.abortController.abort();
    if (handle.deactivate) {
      try {
        await handle.deactivate();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`Plugin ${pluginId} deactivate() threw: ${msg}`);
      }
    }
    for (const u of handle.unsubscribers) {
      try {
        u();
      } catch {
        /* swallow */
      }
    }
    _activeHandles.delete(pluginId);
  }
  // Mark all contributions inactive so subsequent MCP sessions don't see them
  // and existing-session handler wrappers short-circuit.
  for (const c of _contributedTools.get(pluginId) ?? []) c.active = false;
  for (const c of _contributedResources.get(pluginId) ?? []) c.active = false;
  _contributedTools.delete(pluginId);
  _contributedResources.delete(pluginId);

  // M6 — drop any UI elements this plugin contributed to ui_registry.json.
  // We do this best-effort: a registry write failure must not block unload.
  if (_contributedUiIds.get(pluginId)?.size) {
    try {
      const { removed } = await removePluginUiElements(pluginId);
      if (removed > 0) {
        logger.info(
          `Plugin ${pluginId} unload pruned ${removed} UI element(s) from ui_registry.json`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Plugin ${pluginId} UI registry prune failed: ${msg}`);
    }
    _contributedUiIds.delete(pluginId);
  }

  // M6 closure — drop policy proposals (journal), archetype providers
  // (in-memory), and markdown fences (in-memory) owned by this plugin.
  if (_contributedPolicyIds.get(pluginId)?.size) {
    try {
      const { removed } = await removePluginPolicyProposals(pluginId);
      if (removed > 0) {
        logger.info(
          `Plugin ${pluginId} unload pruned ${removed} policy proposal(s)`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Plugin ${pluginId} policy prune failed: ${msg}`);
    }
    _contributedPolicyIds.delete(pluginId);
  }
  if (_contributedArchetypeIds.get(pluginId)?.size) {
    const { removed } = removePluginArchetypeProviders(pluginId);
    if (removed > 0) {
      logger.info(
        `Plugin ${pluginId} unload pruned ${removed} archetype provider(s)`,
      );
    }
    _contributedArchetypeIds.delete(pluginId);
  }
  if (_contributedFenceLanguages.get(pluginId)?.size) {
    const { removed } = removePluginMarkdownFences(pluginId);
    if (removed > 0) {
      logger.info(
        `Plugin ${pluginId} unload pruned ${removed} markdown fence(s)`,
      );
    }
    _contributedFenceLanguages.delete(pluginId);
  }

  const registry = getPluginRegistry();
  const present = !!registry.get(pluginId);
  if (present) {
    unloadPlugin({
      registry,
      telemetry: getPluginTelemetry(),
      pluginId,
      reason,
    });
  }
  return { unloaded: present || !!handle };
}

/** Reload one plugin in place: unload, re-discover, re-load + activate. */
export async function reloadPlugin(pluginId: string): Promise<{
  reloaded: boolean;
  outcome?: PluginLoadOutcome;
  reason?: string;
}> {
  const scope = getActiveScope();
  if (!scope) return { reloaded: false, reason: "no-active-scope" };

  await unloadPluginById(pluginId, "reload");

  const registry = getPluginRegistry();
  const telemetry = getPluginTelemetry();
  const allowInProcess = readAllowInProcessFromEnv();
  const loaderOptions = {
    instanceRoot: scope.instanceRoot,
    instanceUuid: scope.uuid,
    telemetry,
    safety: {
      allowInProcessPlugins: allowInProcess,
      bannerSink: (line: string) => logger.warn(line),
    },
  };

  // Re-discover so we pick up manifest edits
  const discovered = await discoverPlugins(loaderOptions);
  _lastDiscovered = discovered;
  const target = discovered.find((d) => d.manifest.id === pluginId);
  if (!target) {
    return { reloaded: false, reason: "not-discovered" };
  }

  const outcomes = await loadDiscoveredPlugins({
    loader: loaderOptions,
    registry,
    discovered: [target],
  });
  const outcome = outcomes[0];
  if (outcome?.status === "loaded") {
    await activateLoadedPlugin(target, telemetry);
  }
  return outcome ? { reloaded: outcome.status === "loaded", outcome } : { reloaded: false };
}


export function _resetPluginManagerForTest(): void {
  for (const handle of _activeHandles.values()) {
    handle.abortController.abort();
    for (const u of handle.unsubscribers) {
      try {
        u();
      } catch {
        /* swallow */
      }
    }
  }
  _activeHandles.clear();
  _registry = null;
  _telemetry = null;
  _bootstrapped = false;
  _lastDiscovered = [];
  _contributedTools.clear();
  _contributedResources.clear();
}
