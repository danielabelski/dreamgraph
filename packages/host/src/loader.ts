import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  parsePluginManifest,
  type PluginManifest,
} from "@dreamgraph/sdk";
import {
  buildErrored,
  buildLoaded,
  buildRejected,
  buildUnloaded,
  type PluginIdentity,
  type TelemetryEmitter,
} from "./telemetry-emitter.js";
import { gateInProcessLoad, gatePluginId } from "./gates.js";
import {
  PluginRegistry,
  type PluginRegistryEntry,
  type PluginRuntime,
} from "./registry.js";

/**
 * Host safety configuration. Until M8 ships, the in-process switch defaults
 * to deny; a plugin may still be loaded in-process when its manifest sets
 * `trusted: true` (declared via `instance.json:plugins[].trusted`).
 */
export interface HostPluginSafetyConfig {
  allowInProcessPlugins?: boolean;
  /** Print one-line trust banner to stderr on every successful load. */
  printTrustBanner?: boolean;
  /** Where the banner is printed. Defaults to `console.warn`. */
  bannerSink?: (line: string) => void;
}

export interface InstancePluginEntry {
  /** Either an absolute or instance-relative path to the plugin root. */
  path?: string;
  /** Or an npm package name resolvable from the host process. */
  package?: string;
  /** Operator-asserted trust override; required when allowInProcessPlugins is false. */
  trusted?: boolean;
  /** Operator may pre-disable a discovered plugin. */
  enabled?: boolean;
}

export interface InstancePluginsManifest {
  plugins?: InstancePluginEntry[];
  /** Mirrors the `experimental_plugins` flag described in §M0 Gap 3. */
  experimental_plugins?: boolean;
}

export interface DiscoveredPlugin {
  /** Filesystem root containing `plugin.json`, when discovered from disk. */
  rootDir?: string;
  /** Operator-asserted trust override (from `instance.json`). */
  trusted: boolean;
  /** Operator-supplied enabled flag; defaults to true. */
  enabled: boolean;
  manifest: PluginManifest;
  manifestSourcePath: string;
}

export interface PluginLoadOutcome {
  manifest: PluginManifest;
  status: "loaded" | "rejected" | "errored";
  reason?: string;
  detail?: string;
}

export interface PluginLoaderOptions {
  /** Absolute path to the host instance root (`<instance>/`). */
  instanceRoot: string;
  /** Stable identifier for this instance. Surfaced via PluginContext. */
  instanceUuid: string;
  /** Bus adapter publishing `plugin.*` telemetry. */
  telemetry: TelemetryEmitter;
  /** Host safety policy. */
  safety?: HostPluginSafetyConfig;
}

/**
 * Discover plugins from `<instance>/plugins/` and from `instance.json:plugins[]`.
 *
 * Auto-discovery from arbitrary `node_modules` is deliberately not implemented;
 * see roadmap §11 M3 trust-boundary notice.
 */
export async function discoverPlugins(
  options: PluginLoaderOptions,
): Promise<DiscoveredPlugin[]> {
  const discovered: DiscoveredPlugin[] = [];
  const seen = new Set<string>();

  // 1. <instance>/plugins/<id>/plugin.json
  const pluginsDir = path.join(options.instanceRoot, "plugins");
  let dirEntries: string[] = [];
  try {
    dirEntries = await fs.readdir(pluginsDir);
  } catch {
    // missing dir is fine
  }
  for (const name of dirEntries) {
    const root = path.join(pluginsDir, name);
    const manifestPath = path.join(root, "plugin.json");
    let raw: string;
    try {
      raw = await fs.readFile(manifestPath, "utf8");
    } catch {
      continue;
    }
    const parsed = safeParseManifest(raw, manifestPath);
    if (!parsed) continue;
    if (seen.has(parsed.manifest.id)) continue;
    seen.add(parsed.manifest.id);
    discovered.push({
      rootDir: root,
      trusted: false,
      enabled: true,
      manifest: parsed.manifest,
      manifestSourcePath: manifestPath,
    });
  }

  // 2. instance.json:plugins[]
  const instanceJsonPath = path.join(options.instanceRoot, "instance.json");
  let instanceManifest: InstancePluginsManifest | undefined;
  try {
    const raw = await fs.readFile(instanceJsonPath, "utf8");
    instanceManifest = JSON.parse(raw) as InstancePluginsManifest;
  } catch {
    // missing or unparseable instance.json — discovery continues with
    // whatever was found on disk.
  }
  if (instanceManifest?.plugins) {
    for (const entry of instanceManifest.plugins) {
      if (entry.path) {
        const root = path.isAbsolute(entry.path)
          ? entry.path
          : path.join(options.instanceRoot, entry.path);
        const manifestPath = path.join(root, "plugin.json");
        let raw: string;
        try {
          raw = await fs.readFile(manifestPath, "utf8");
        } catch {
          continue;
        }
        const parsed = safeParseManifest(raw, manifestPath);
        if (!parsed) continue;
        // Allow instance.json to override trust/enabled even for an entry
        // that was already discovered on disk.
        const existing = discovered.find(
          (d) => d.manifest.id === parsed.manifest.id,
        );
        if (existing) {
          existing.trusted = entry.trusted ?? existing.trusted;
          existing.enabled = entry.enabled ?? existing.enabled;
          continue;
        }
        discovered.push({
          rootDir: root,
          trusted: entry.trusted ?? false,
          enabled: entry.enabled ?? true,
          manifest: parsed.manifest,
          manifestSourcePath: manifestPath,
        });
        seen.add(parsed.manifest.id);
      }
      // entry.package — resolution from node_modules is deferred until the
      // M3 follow-up that wires `import.meta.resolve()`. Listing the entry is
      // not a load.
    }
  }

  return discovered;
}

function safeParseManifest(
  raw: string,
  source: string,
): { manifest: PluginManifest } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  try {
    return { manifest: parsePluginManifest(parsed) };
  } catch {
    // We deliberately do not emit telemetry here; callers without a
    // registered identity cannot be attributed to a plugin id. The loader
    // re-validates and emits `plugin.errored{ reason: manifest_invalid }`
    // when it can attribute the failure. Source is preserved for callers
    // that want to log the path themselves.
    void source;
    return null;
  }
}

/**
 * Load every discovered plugin into the registry, applying the host safety
 * gates and emitting the M3 telemetry envelope. Seam wiring (tools,
 * resources, events) is handled separately by the matching `wire*` helpers.
 */
export async function loadDiscoveredPlugins(args: {
  loader: PluginLoaderOptions;
  registry: PluginRegistry;
  discovered: readonly DiscoveredPlugin[];
}): Promise<PluginLoadOutcome[]> {
  const outcomes: PluginLoadOutcome[] = [];
  const safety = args.loader.safety ?? {};
  const allowInProcess = safety.allowInProcessPlugins === true;
  const sink = safety.bannerSink ?? ((line: string) => console.warn(line));

  for (const plugin of args.discovered) {
    const identity: PluginIdentity = {
      plugin_id: plugin.manifest.id,
      plugin_version: plugin.manifest.version,
    };

    if (!plugin.enabled) {
      outcomes.push({
        manifest: plugin.manifest,
        status: "rejected",
        reason: "plugin_quarantined",
        detail: "Plugin is disabled in instance.json",
      });
      args.loader.telemetry.emit(
        "plugin.output.rejected",
        buildRejected({
          identity,
          reason: "plugin_quarantined",
          seam: "host",
          detail: "Plugin is disabled in instance.json",
        }),
      );
      continue;
    }

    const idGate = gatePluginId(plugin.manifest.id);
    if (!idGate.ok) {
      outcomes.push({
        manifest: plugin.manifest,
        status: "rejected",
        reason: idGate.reason,
        detail: idGate.detail,
      });
      args.loader.telemetry.emit(
        "plugin.output.rejected",
        buildRejected({
          identity,
          reason: idGate.reason,
          seam: "host",
          ...(idGate.detail !== undefined ? { detail: idGate.detail } : {}),
        }),
      );
      continue;
    }

    const inProcGate = gateInProcessLoad({
      allowInProcessPlugins: allowInProcess,
      trusted: plugin.trusted,
    });
    if (!inProcGate.ok) {
      outcomes.push({
        manifest: plugin.manifest,
        status: "rejected",
        reason: inProcGate.reason,
        detail: inProcGate.detail,
      });
      args.loader.telemetry.emit(
        "plugin.output.rejected",
        buildRejected({
          identity,
          reason: inProcGate.reason,
          seam: "host",
          ...(inProcGate.detail !== undefined
            ? { detail: inProcGate.detail }
            : {}),
        }),
      );
      continue;
    }

    const runtime: PluginRuntime = "in-process";
    const entry: PluginRegistryEntry = {
      manifest: plugin.manifest,
      runtime,
      trusted: plugin.trusted,
      status: "loaded",
      loadedAt: new Date().toISOString(),
      lastSeenEffects: [],
    };
    try {
      args.registry.add(entry);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      args.loader.telemetry.emit(
        "plugin.errored",
        buildErrored({
          identity,
          reason: "manifest_invalid",
          message,
        }),
      );
      outcomes.push({
        manifest: plugin.manifest,
        status: "errored",
        reason: "manifest_invalid",
        detail: message,
      });
      continue;
    }

    args.loader.telemetry.emit(
      "plugin.loaded",
      buildLoaded({
        identity,
        runtime,
        trusted: plugin.trusted,
        capabilities: plugin.manifest.capabilities,
      }),
    );

    if (safety.printTrustBanner !== false) {
      sink(
        `plugin ${plugin.manifest.id}@${plugin.manifest.version} loaded with FULL HOST TRUST (${runtime})`,
      );
    }

    outcomes.push({ manifest: plugin.manifest, status: "loaded" });
  }

  return outcomes;
}

/**
 * Remove a plugin from the registry and emit `plugin.unloaded`. Seam
 * unwiring is the caller's responsibility (tools/resources/events
 * registries each remove their entries before this is called).
 */
export function unloadPlugin(args: {
  registry: PluginRegistry;
  telemetry: TelemetryEmitter;
  pluginId: string;
  reason: "shutdown" | "disable" | "reload" | "quarantine";
}): void {
  const entry = args.registry.get(args.pluginId);
  if (!entry) return;
  args.telemetry.emit(
    "plugin.unloaded",
    buildUnloaded({
      identity: {
        plugin_id: entry.manifest.id,
        plugin_version: entry.manifest.version,
      },
      reason: args.reason,
    }),
  );
  args.registry.setStatus(args.pluginId, "unloaded");
  args.registry.remove(args.pluginId);
}
