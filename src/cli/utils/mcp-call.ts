/**
 * DreamGraph CLI — MCP tool call helper.
 *
 * Connects to a running DreamGraph daemon via Streamable HTTP transport,
 * calls one MCP tool, and disconnects.  Used by CLI commands that need
 * to invoke server-side tools (e.g. `dg scan`, `dg schedule`).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CLI_VERSION } from "../version.js";

export interface McpCallResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export interface McpCallProgress {
  progress: number;
  total?: number;
  message?: string;
}

/**
 * Call a single MCP tool on a running DreamGraph daemon.
 *
 * @param port    The daemon HTTP port.
 * @param tool    MCP tool name (e.g. "scan_project").
 * @param args    Tool input arguments.
 * @param timeoutMs  Inactivity timeout (default: 5 minutes). Progress resets it.
 * @param onProgress Optional progress observer.
 * @returns       The tool result content array.
 */
export async function mcpCallTool(
  port: number,
  tool: string,
  args: Record<string, unknown> = {},
  timeoutMs = 300_000,
  onProgress?: (progress: McpCallProgress) => void,
): Promise<McpCallResult> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
  );

  const client = new Client({
    name: "dreamgraph-cli",
    version: CLI_VERSION,
  });

  try {
    await client.connect(transport);

    // Supplying onprogress is what causes the MCP SDK to attach a progress
    // token to the request. Without it, resetTimeoutOnProgress is inert and a
    // healthy multi-hour scan is indistinguishable from a stalled request.
    const result = await client.callTool(
      { name: tool, arguments: args },
      undefined,
      {
        timeout: timeoutMs,
        resetTimeoutOnProgress: true,
        onprogress: (progress) => onProgress?.(progress as McpCallProgress),
      },
    );

    return result as McpCallResult;
  } finally {
    try {
      await client.close();
    } catch {
      // Ignore close errors — the connection may already be closed
    }
  }
}

/**
 * List all available MCP tools on a running daemon.
 */
export async function mcpListTools(
  port: number,
): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
  );

  const client = new Client({
    name: "dreamgraph-cli",
    version: CLI_VERSION,
  });

  try {
    await client.connect(transport);
    const result = await client.listTools();
    return result.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  } finally {
    try {
      await client.close();
    } catch {
      // Ignore
    }
  }
}
