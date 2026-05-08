import type { PluginEffect } from "../manifest.js";

export type JsonSchema = Record<string, unknown>;

export interface ToolContext {
  pluginId: string;
  signal?: AbortSignal;
}

export type ToolHandler<Input = unknown, Output = unknown> = (
  input: Input,
  context: ToolContext,
) => Output | Promise<Output>;

export interface ToolDefinition<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  expectedEffects: PluginEffect[];
  forbiddenEffects?: PluginEffect[];
  handler: ToolHandler<Input, Output>;
}

export function defineTool<Input = unknown, Output = unknown>(
  definition: ToolDefinition<Input, Output>,
): ToolDefinition<Input, Output> {
  return definition;
}
