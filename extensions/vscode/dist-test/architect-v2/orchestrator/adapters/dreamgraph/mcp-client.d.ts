export interface McpInvokeInput {
    readonly tool: string;
    readonly args?: Readonly<Record<string, unknown>>;
}
export type McpInvokeResult = {
    readonly kind: "ok";
    readonly data: unknown;
} | {
    readonly kind: "error";
    readonly message: string;
};
export interface McpClient {
    invoke(input: McpInvokeInput): Promise<McpInvokeResult>;
}
/**
 * Default no-op client used when no MCP transport is wired. Always
 * returns an error result so the adapter falls through to its empty
 * defaults (the orchestrator handles this gracefully via 8A.3 fallback).
 */
export declare class NullMcpClient implements McpClient {
    invoke(): Promise<McpInvokeResult>;
}
//# sourceMappingURL=mcp-client.d.ts.map