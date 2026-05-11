// Slice 8A.5 — Bridge from existing v1 McpClient to architect-v2 McpClient port.
//
// SCOPED EXCEPTION (ADR-171): host/ is a wiring layer, not a cognition
// layer. It MAY import the existing extension McpClient (v1) so the
// adapter under orchestrator/adapters/dreamgraph/ can talk to a real
// transport. The architect-v2 cognition surfaces still see only the
// thin McpClient port \u2014 v1 stays behind this seam.

import type { McpClient as ArchitectV2McpClient } from "../orchestrator/index.js";

/**
 * Minimal shape of the v1 McpClient we depend on. Declared as an
 * interface (not an import) so this host file does not pull v1 types
 * into the architect-v2 module graph at type-check time.
 */
export interface V1McpClientLike {
  callTool(
    name: string,
    args?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown>;
  listTools?(): Promise<
    Array<{ name: string; description?: string; inputSchema?: unknown }>
  >;
  /**
   * Optional connection state probe. When present, the bridge exposes
   * it via `isConnected` so callers (e.g. the panel's host cache) can
   * detect "daemon not yet ready" and rebuild the host once it is.
   */
  readonly isConnected?: boolean;
}

/**
 * The DreamGraph MCP server exposes BARE tool names (e.g. `query_resource`,
 * `graph_rag_retrieve`). The architect-v2 catalog and the names advertised
 * to the LLM use the VS Code LM convention with the `mcp_dreamgraph_` prefix
 * (e.g. `mcp_dreamgraph_query_resource`). This bridge owns the namespace
 * translation in BOTH directions:
 *   - callTool: strip the prefix before dispatching to the daemon.
 *   - listTools: re-prefix server names so the catalog roster lookups match.
 * The architect-v2 cognition surfaces never see the bare names.
 */
const MCP_PREFIX = "mcp_dreamgraph_";

function toServerName(name: string): string {
  return name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name;
}

function toCatalogName(name: string): string {
  return name.startsWith(MCP_PREFIX) ? name : MCP_PREFIX + name;
}

export class V1McpClientBridge implements ArchitectV2McpClient {
  constructor(private readonly v1: V1McpClientLike) {}
  async callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    return this.v1.callTool(toServerName(name), args as Record<string, unknown>);
  }
  async listTools(): Promise<readonly string[]> {
    if (typeof this.v1.listTools !== "function") return [];
    try {
      const tools = await this.v1.listTools();
      const names = tools
        .map((t) => (typeof t?.name === "string" ? toCatalogName(t.name) : null))
        .filter((n): n is string => typeof n === "string" && n.length > 0);
      console.log(`[architect-v2] mcp listTools -> ${names.length} tools`);
      return names;
    } catch (err) {
      // Surface the failure: silently returning [] used to leave the
      // executor with a zero-tool catalog and the model with nothing to
      // call, producing "no tool inventory was exposed to me" replies.
      console.warn(
        "[architect-v2] mcp listTools failed:",
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }
  }
}
