/**
 * MCP tools for plugin lifecycle management (M3.5).
 *
 * Exposes hot reload/unload over MCP so the `dg plugin reload` and
 * `dg plugin unload` CLI subcommands can call into a running daemon
 * without forcing a full restart.
 *
 * Read-only listing is provided by the existing `system://plugins`
 * resource and the `dg plugin list/inspect` CLI subcommands.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  reloadPlugin,
  unloadPluginById,
} from "../plugins/manager.js";
import { logger } from "../utils/logger.js";

const ReloadInputSchema = {
  plugin_id: z
    .string()
    .min(1)
    .describe("The plugin id (matches manifest.id, e.g. 'examples.hello-events')."),
};

const UnloadInputSchema = {
  plugin_id: z
    .string()
    .min(1)
    .describe("The plugin id to unload."),
  reason: z
    .enum(["disable", "shutdown", "quarantine"])
    .optional()
    .describe("Reason recorded in the plugin.unloaded telemetry event."),
};

export function registerPluginOpsTools(server: McpServer): void {
  server.tool(
    "plugin_reload",
    "Hot-reload a single plugin by id: deactivate, drop subscriptions and " +
      "MCP tool/resource contributions, re-discover the manifest, re-load " +
      "and call activate(). Operator must hold appropriate permissions; " +
      "fails closed if the plugin is not currently discoverable.",
    ReloadInputSchema,
    async ({ plugin_id }) => {
      logger.debug(`plugin_reload called for ${plugin_id}`);
      const result = await reloadPlugin(plugin_id);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "plugin_unload",
    "Hot-unload a single plugin by id: deactivate, drop subscriptions and " +
      "MCP tool/resource contributions, remove from the runtime registry. " +
      "Existing MCP sessions retain the tool name binding but invocations " +
      "after unload return a `tool_unavailable` error.",
    UnloadInputSchema,
    async ({ plugin_id, reason }) => {
      logger.debug(`plugin_unload called for ${plugin_id}`);
      const result = await unloadPluginById(plugin_id, reason ?? "disable");
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );
}
