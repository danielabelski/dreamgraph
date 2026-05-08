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

export function createPluginHostStatus(options: PluginHostOptions = {}): PluginHostStatus {
  return {
    state: options.enabled === false ? "disabled" : "unconfigured",
    loadedPluginCount: 0,
    message: "Runtime plugin loading is intentionally not implemented in the M1 host skeleton.",
  };
}
