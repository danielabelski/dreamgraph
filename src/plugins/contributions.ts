/**
 * Plugin contributions adapter — bridges plugin-registered MCP tools and
 * resources (M4) onto a per-session McpServer instance.
 *
 * The DreamGraph daemon creates a fresh `McpServer` per client session.
 * This module is invoked from `createServer()` after the static tools and
 * resources are wired, iterating the manager's contribution registry and
 * binding each entry into the new session.
 *
 * Important semantics:
 *   - Contributions registered AFTER a session opens are not visible to
 *     that session (MCP has no live tool list mutation). New sessions
 *     pick them up.
 *   - When a plugin is unloaded/reloaded, contributions are marked
 *     inactive. The wrapper handlers below short-circuit with an error
 *     so existing sessions don't invoke a torn-down plugin.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import {
  buildHandlerCompleted,
  buildHandlerStarted,
  type TelemetryEmitter,
} from "@dreamgraph/host";
import {
  getContributedResources,
  getContributedTools,
  getPluginTelemetry,
  type ContributedResource,
  type ContributedTool,
} from "./manager.js";
import { logger } from "../utils/logger.js";

function correlationFor(pluginId: string, target: string): string {
  return `${pluginId}:${target}:${Date.now().toString(36)}`;
}

/**
 * Convert a JSON-Schema property descriptor into a Zod schema. Supports the
 * subset that plugin tools realistically declare today: scalar types
 * (string/number/integer/boolean), enums, arrays of any of the above, and
 * nested objects. Anything outside that subset falls back to `z.unknown()`,
 * which lets the request pass through untyped rather than failing
 * validation.
 */
function jsonSchemaPropToZod(prop: Record<string, unknown>): ZodTypeAny {
  const type = prop?.["type"];
  const description = typeof prop?.["description"] === "string"
    ? (prop["description"] as string)
    : undefined;
  const enumVals = Array.isArray(prop?.["enum"]) ? (prop["enum"] as unknown[]) : undefined;

  let schema: ZodTypeAny;
  if (enumVals && enumVals.every((v) => typeof v === "string")) {
    schema = z.enum(enumVals as [string, ...string[]]);
  } else if (type === "string") {
    schema = z.string();
  } else if (type === "integer") {
    schema = z.number().int();
  } else if (type === "number") {
    schema = z.number();
  } else if (type === "boolean") {
    schema = z.boolean();
  } else if (type === "array") {
    const items = (prop["items"] as Record<string, unknown> | undefined) ?? {};
    schema = z.array(jsonSchemaPropToZod(items));
  } else if (type === "object") {
    const shape = jsonSchemaToZodShape(prop);
    schema = Object.keys(shape).length ? z.object(shape).passthrough() : z.record(z.unknown());
  } else {
    schema = z.unknown();
  }
  return description ? schema.describe(description) : schema;
}

/**
 * Convert a plugin tool's `inputSchema` (JSON Schema object form) into a
 * Zod raw shape suitable for `McpServer.tool(name, desc, shape, cb)`.
 * Properties not listed in `required` are wrapped in `.optional()` so MCP
 * preserves them when present and omits them otherwise.
 */
function jsonSchemaToZodShape(input: Record<string, unknown> | undefined): ZodRawShape {
  if (!input || typeof input !== "object") return {};
  const props = input["properties"];
  if (!props || typeof props !== "object") return {};
  const required = new Set(
    Array.isArray(input["required"])
      ? (input["required"] as unknown[]).filter((v): v is string => typeof v === "string")
      : [],
  );
  const shape: ZodRawShape = {};
  for (const [key, raw] of Object.entries(props as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const field = jsonSchemaPropToZod(raw as Record<string, unknown>);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return shape;
}

function bindTool(
  server: McpServer,
  c: ContributedTool,
  telemetry: TelemetryEmitter,
): void {
  const { definition } = c;
  const description =
    definition.description?.trim() ||
    `Plugin tool '${definition.name}' contributed by ${c.pluginId}@${c.pluginVersion}`;
  const identity = {
    plugin_id: c.pluginId,
    plugin_version: c.pluginVersion,
  };
  // Translate the plugin's JSON-Schema `inputSchema` into a Zod raw
  // shape so the MCP SDK exposes the parameters in `tools/list` and
  // forwards validated arguments to the handler. Unsupported schema
  // fragments degrade to `z.unknown()` rather than failing the
  // registration.
  const shape = jsonSchemaToZodShape(
    definition.inputSchema as Record<string, unknown> | undefined,
  );
  server.tool(definition.name, description, shape, async (args, _extra) => {
    if (!c.active) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: "tool_unavailable",
              detail: `Plugin ${c.pluginId} has been unloaded; restart your MCP session to refresh tool list.`,
            }),
          },
        ],
      };
    }
    const correlation_id = correlationFor(c.pluginId, definition.name);
    telemetry.emit(
      "plugin.handler.started",
      buildHandlerStarted({
        identity,
        correlation_id,
        seam: "tool",
        target: definition.name,
      }),
    );
    const startedAt = Date.now();
    let ok = true;
    try {
      const result = await definition.handler(args, {
        pluginId: c.pluginId,
      });
      const text =
        typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      ok = false;
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        `Plugin tool ${definition.name} threw: ${msg}`,
      );
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: "handler_threw", message: msg }),
          },
        ],
      };
    } finally {
      telemetry.emit(
        "plugin.handler.completed",
        buildHandlerCompleted({
          identity,
          correlation_id,
          seam: "tool",
          target: definition.name,
          duration_ms: Date.now() - startedAt,
          ok,
        }),
      );
    }
  });
}

function bindResource(
  server: McpServer,
  c: ContributedResource,
  telemetry: TelemetryEmitter,
): void {
  const { definition } = c;
  const identity = {
    plugin_id: c.pluginId,
    plugin_version: c.pluginVersion,
  };
  const safeName = definition.uriNamespace
    .replace(/^plugin:\/\//, "plugin-")
    .replace(/[^\w.-]+/g, "-");
  server.resource(
    safeName,
    definition.uriNamespace,
    {
      description:
        definition.description ||
        `Plugin resource '${definition.uriNamespace}' contributed by ${c.pluginId}@${c.pluginVersion}`,
      mimeType: "application/json",
    },
    async (uri) => {
      if (!c.active) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({
                error: "resource_unavailable",
                detail: `Plugin ${c.pluginId} has been unloaded.`,
              }),
            },
          ],
        };
      }
      const correlation_id = correlationFor(c.pluginId, definition.uriNamespace);
      telemetry.emit(
        "plugin.handler.started",
        buildHandlerStarted({
          identity,
          correlation_id,
          seam: "resource",
          target: definition.uriNamespace,
        }),
      );
      const startedAt = Date.now();
      let ok = true;
      try {
        const result = await definition.handler(
          { uri: uri.href },
          { pluginId: c.pluginId },
        );
        const text =
          typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return {
          contents: [
            { uri: uri.href, mimeType: "application/json", text },
          ],
        };
      } catch (err) {
        ok = false;
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          `Plugin resource ${definition.uriNamespace} threw: ${msg}`,
        );
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({ error: "handler_threw", message: msg }),
            },
          ],
        };
      } finally {
        telemetry.emit(
          "plugin.handler.completed",
          buildHandlerCompleted({
            identity,
            correlation_id,
            seam: "resource",
            target: definition.uriNamespace,
            duration_ms: Date.now() - startedAt,
            ok,
          }),
        );
      }
    },
  );
}

/**
 * Bind every currently-contributed plugin tool and resource onto the
 * given session McpServer. Called once per session from `createServer()`.
 */
export function registerPluginContributions(server: McpServer): void {
  const telemetry = getPluginTelemetry();
  const tools = getContributedTools();
  const resources = getContributedResources();
  for (const t of tools) bindTool(server, t, telemetry);
  for (const r of resources) bindResource(server, r, telemetry);
  if (tools.length || resources.length) {
    logger.info(
      `Plugin contributions wired into session: ${tools.length} tool(s), ${resources.length} resource(s)`,
    );
  }
}
