// SCOPED EXCEPTION (ADR-171): this folder is the *only* place in
// architect-v2 allowed to know about DreamGraph's MCP tool surface.
// Even here we do NOT import mcp_dreamgraph_* directly — extension
// runtime invokes those through an MCP transport. We declare a tiny
// McpClient port and let 8A.5 wire the real transport.
//
// Slice 8A.3 — DreamGraph adapter MCP client port.

export interface McpInvokeInput {
  readonly tool: string;
  readonly args?: Readonly<Record<string, unknown>>;
}

export type McpInvokeResult =
  | { readonly kind: "ok"; readonly data: unknown }
  | { readonly kind: "error"; readonly message: string };

export interface McpClient {
  invoke(input: McpInvokeInput): Promise<McpInvokeResult>;
}

/**
 * Default no-op client used when no MCP transport is wired. Always
 * returns an error result so the adapter falls through to its empty
 * defaults (the orchestrator handles this gracefully via 8A.3 fallback).
 */
export class NullMcpClient implements McpClient {
  async invoke(): Promise<McpInvokeResult> {
    return { kind: "error", message: "no MCP transport wired" };
  }
}
