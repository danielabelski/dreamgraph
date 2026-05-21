import type { CopilotCliRegistryPort } from "../orchestrator-ports.js";
export interface HostRegistryOptions {
    /**
     * Full URL of the architect's already-open DreamGraph MCP endpoint
     * (e.g. `http://127.0.0.1:7321/mcp`). This MUST be the same URL the
     * extension's long-running `McpClient` is connected to, so probes
     * and bridge forwards see the SAME daemon session the rest of the
     * extension operates against.
     */
    readonly hostMcpUrl: string;
    /**
     * Absolute path to the bridge entry artifact (typically
     * `<extension>/dist/copilot-cli-bridge.js`). Copilot CLI will
     * spawn `node <bridgeEntryPath>` for every MCP exchange with the
     * DreamGraph server.
     */
    readonly bridgeEntryPath: string;
    /**
     * Absolute path to `process.execPath` at the moment the orchestrator
     * was constructed. We capture it explicitly instead of resolving
     * `node` from PATH because Copilot CLI inherits no shell.
     */
    readonly nodeExecPath: string;
    /**
     * Absolute path to the directory the bridge writes audit NDJSON
     * files into. MUST be the same directory the
     * `CopilotCliMcpAuditPort` reads from (use `auditFilePathFor`).
     */
    readonly auditDirAbsPath: string;
    /**
     * Workspace root used by the bridge-local `run_command` tool. Commands
     * may choose a relative cwd, but the bridge rejects cwd escapes.
     */
    readonly workspaceRootAbsPath: string;
    /**
     * Optional extra env to merge into the bridge spawn. The orchestrator
     * already overlays `DREAMGRAPH_RUN_ID` and the resolved audit path
     * on top of whatever is returned from `describeBridgeSpawn`.
     */
    readonly extraBridgeEnv?: Readonly<Record<string, string>>;
    /**
     * Hard timeout (ms) for the one-shot `tools/list` probe. Defaults to
     * 15 s — generous enough for a slow round-trip while keeping the
     * orchestrator startup bounded.
     */
    readonly toolListTimeoutMs?: number;
}
export declare function createHostRegistry(opts: HostRegistryOptions): CopilotCliRegistryPort;
/**
 * Compute the env overlay the bridge needs for a specific run. The
 * orchestrator passes the result through `dreamgraphEnv` on the MCP
 * config artifact so Copilot writes it into `mcp-config.json` and
 * Copilot CLI propagates it to the bridge child.
 */
export declare function bridgeEnvForRun(opts: {
    auditDirAbsPath: string;
    runId: string;
}): Readonly<Record<string, string>>;
/**
 * Liveness probe used by host wiring to verify the architect's
 * DreamGraph MCP endpoint is actually serving requests before the
 * orchestrator begins a run. Throws on failure so the caller can
 * fall back to a disabled state with a clear error message instead
 * of waiting for Copilot CLI to fail mysteriously.
 */
export declare function probeDreamgraphHttpMcp(opts: {
    url: string;
    timeoutMs?: number;
}): Promise<{
    readonly toolCount: number;
}>;
//# sourceMappingURL=registry-adapter.d.ts.map