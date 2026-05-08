import type { PluginEffect } from "../manifest.js";
import type { JsonSchema } from "./tools.js";

export interface ResourceContext {
  pluginId: string;
  signal?: AbortSignal;
}

export interface ResourceReadRequest<Params = Record<string, unknown>> {
  uri: string;
  params?: Params;
}

export type ResourceHandler<Params = Record<string, unknown>, Output = unknown> = (
  request: ResourceReadRequest<Params>,
  context: ResourceContext,
) => Output | Promise<Output>;

export interface ResourceDefinition<Params = Record<string, unknown>, Output = unknown> {
  uriNamespace: string;
  name: string;
  description?: string;
  outputSchema?: JsonSchema;
  expectedEffects: PluginEffect[];
  forbiddenEffects?: PluginEffect[];
  handler: ResourceHandler<Params, Output>;
}

export function defineResource<Params = Record<string, unknown>, Output = unknown>(
  definition: ResourceDefinition<Params, Output>,
): ResourceDefinition<Params, Output> {
  return definition;
}
