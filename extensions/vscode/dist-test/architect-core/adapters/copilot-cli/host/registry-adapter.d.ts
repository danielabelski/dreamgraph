import type { CopilotCliRegistryPort } from "../orchestrator-ports.js";
export interface HostRegistryOptions {
    /**
     * Absolute path to the DreamGraph stdio MCP server entry point. On
     * a packaged install this is typically the `dreamgraph` binary on
     * PATH; in dev the host can point at `node <repo>/dist/index.js`.
     */
    readonly dreamgraphCommand: string;
    /**
     * Args appended after `dreamgraphCommand`. Defaults to
     * `["--transport", "stdio"]` so callers do not have to repeat it.
     */
    readonly dreamgraphArgs?: readonly string[];
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
     * Optional extra env to merge into the bridge spawn. The orchestrator
     * already overlays `DREAMGRAPH_MCP_TOKEN` and `DREAMGRAPH_RUN_ID` on
     * top of whatever is returned from `describeBridgeSpawn`.
     */
    readonly extraBridgeEnv?: Readonly<Record<string, string>>;
    /**
     * Hard timeout (ms) for the one-shot `tools/list` probe. Defaults to
     * 8 s — generous enough for a cold dreamgraph start, short enough
     * that a wedged server cannot block run startup indefinitely.
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
 * Quick liveness probe used by Slice 4 host wiring to verify the
 * DreamGraph stdio server actually starts before the orchestrator
 * begins a run. Throws on failure so the caller can fall back to a
 * disabled state with a clear error message instead of waiting for
 * Copilot CLI to fail mysteriously.
 */
export declare function probeDreamgraphStdio(opts: {
    command: string;
    args?: readonly string[];
    timeoutMs?: number;
}): Promise<{
    readonly toolCount: number;
}>;
//# sourceMappingURL=registry-adapter.d.ts.map