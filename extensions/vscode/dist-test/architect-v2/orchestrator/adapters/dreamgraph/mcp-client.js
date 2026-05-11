"use strict";
// SCOPED EXCEPTION (ADR-171): this folder is the *only* place in
// architect-v2 allowed to know about DreamGraph's MCP tool surface.
// Even here we do NOT import mcp_dreamgraph_* directly — extension
// runtime invokes those through an MCP transport. We declare a tiny
// McpClient port and let 8A.5 wire the real transport.
//
// Slice 8A.3 — DreamGraph adapter MCP client port.
Object.defineProperty(exports, "__esModule", { value: true });
exports.NullMcpClient = void 0;
/**
 * Default no-op client used when no MCP transport is wired. Always
 * returns an error result so the adapter falls through to its empty
 * defaults (the orchestrator handles this gracefully via 8A.3 fallback).
 */
class NullMcpClient {
    async invoke() {
        return { kind: "error", message: "no MCP transport wired" };
    }
}
exports.NullMcpClient = NullMcpClient;
//# sourceMappingURL=mcp-client.js.map