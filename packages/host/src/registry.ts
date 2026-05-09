import type { PluginManifest } from "@dreamgraph/sdk";

export type PluginRuntime = "in-process" | "worker";

export type PluginStatus =
  | "loaded"
  | "quarantined"
  | "disabled"
  | "unloaded"
  | "error";

export interface PluginRegistryEntry {
  manifest: PluginManifest;
  runtime: PluginRuntime;
  trusted: boolean;
  status: PluginStatus;
  loadedAt: string;
  /** Last reason a host-mediated effect was rejected for this plugin. */
  lastRejection?: { reason: string; detail?: string; at: string };
  /** Most recent effects observed inside the manifest envelope. */
  lastSeenEffects: string[];
}

/**
 * In-memory registry of plugins loaded by `@dreamgraph/host`.
 *
 * Backs the `system://plugins` resource described in the M3 exit criteria.
 * The host is the only writer; resource handlers are expected to read
 * snapshots through `list()` / `get()`.
 */
export class PluginRegistry {
  private readonly entries = new Map<string, PluginRegistryEntry>();

  add(entry: PluginRegistryEntry): void {
    if (this.entries.has(entry.manifest.id)) {
      throw new Error(`Plugin '${entry.manifest.id}' is already registered`);
    }
    this.entries.set(entry.manifest.id, entry);
  }

  get(pluginId: string): PluginRegistryEntry | undefined {
    return this.entries.get(pluginId);
  }

  list(): readonly PluginRegistryEntry[] {
    return Array.from(this.entries.values());
  }

  setStatus(pluginId: string, status: PluginStatus): void {
    const entry = this.entries.get(pluginId);
    if (!entry) return;
    entry.status = status;
  }

  recordRejection(pluginId: string, reason: string, detail?: string): void {
    const entry = this.entries.get(pluginId);
    if (!entry) return;
    entry.lastRejection = {
      reason,
      ...(detail !== undefined ? { detail } : {}),
      at: new Date().toISOString(),
    };
  }

  recordEffect(pluginId: string, effect: string): void {
    const entry = this.entries.get(pluginId);
    if (!entry) return;
    if (!entry.lastSeenEffects.includes(effect)) {
      entry.lastSeenEffects.push(effect);
      // Trim to a bounded window so a chatty plugin cannot grow this unboundedly.
      if (entry.lastSeenEffects.length > 32) {
        entry.lastSeenEffects.shift();
      }
    }
  }

  remove(pluginId: string): void {
    this.entries.delete(pluginId);
  }

  clear(): void {
    this.entries.clear();
  }
}
