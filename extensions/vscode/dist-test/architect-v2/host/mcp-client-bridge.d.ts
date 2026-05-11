import type { McpClient as ArchitectV2McpClient } from "../orchestrator/index.js";
/**
 * Minimal shape of the v1 McpClient we depend on. Declared as an
 * interface (not an import) so this host file does not pull v1 types
 * into the architect-v2 module graph at type-check time.
 */
export interface V1McpClientLike {
    callTool(name: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
    listTools?(): Promise<Array<{
        name: string;
        description?: string;
        inputSchema?: unknown;
    }>>;
    /**
     * Optional connection state probe. When present, the bridge exposes
     * it via `isConnected` so callers (e.g. the panel's host cache) can
     * detect "daemon not yet ready" and rebuild the host once it is.
     */
    readonly isConnected?: boolean;
}
export declare class V1McpClientBridge implements ArchitectV2McpClient {
    private readonly v1;
    constructor(v1: V1McpClientLike);
    callTool(name: string, args: Readonly<Record<string, unknown>>): Promise<unknown>;
    listTools(): Promise<readonly string[]>;
}
//# sourceMappingURL=mcp-client-bridge.d.ts.map