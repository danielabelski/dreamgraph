/**
 * @dreamgraph/host — plugin loader, capability gates, telemetry, registry,
 * and watchdog used by the DreamGraph daemon.
 *
 * This package is intentionally bus-agnostic and filesystem-bounded: it
 * does not import the daemon's event bus, scheduler, or LLM client. Hosts
 * inject those through the `TelemetryEmitter` and (post-M3) `PluginContext`
 * dependency surfaces.
 */

export * from "./gates.js";
export * from "./telemetry-emitter.js";
export * from "./registry.js";
export * from "./watchdog.js";
export * from "./context.js";
export * from "./loader.js";

export type PluginHostRuntimeState = "unconfigured" | "disabled" | "ready";

export interface PluginHostStatus {
  state: PluginHostRuntimeState;
  loadedPluginCount: number;
  message?: string;
}

export interface PluginHostOptions {
  instanceRoot?: string;
  enabled?: boolean;
}

/**
 * Backward-compatible status helper kept from the M1 host skeleton. M3 hosts
 * should use `discoverPlugins() + loadDiscoveredPlugins()` with a
 * `PluginRegistry` directly.
 */
export function createPluginHostStatus(options: PluginHostOptions = {}): PluginHostStatus {
  return {
    state: options.enabled === false ? "disabled" : "unconfigured",
    loadedPluginCount: 0,
    message:
      "Use discoverPlugins() + loadDiscoveredPlugins() with a PluginRegistry; this helper is retained for the M1 daemon health probe only.",
  };
}
