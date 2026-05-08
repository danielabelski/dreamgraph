import type { EventHandlerDefinition } from "./events.js";
import type { PluginManifest } from "./manifest.js";
import type { ResourceDefinition } from "./seams/resources.js";
import type { ToolDefinition } from "./seams/tools.js";

export interface PluginSetupContext {
  pluginId: string;
  signal?: AbortSignal;
}

export interface PluginDefinition {
  manifest: PluginManifest;
  tools?: readonly ToolDefinition[];
  resources?: readonly ResourceDefinition[];
  eventHandlers?: readonly EventHandlerDefinition[];
  setup?: (context: PluginSetupContext) => void | Promise<void>;
}

export function definePlugin(definition: PluginDefinition): PluginDefinition {
  return definition;
}
