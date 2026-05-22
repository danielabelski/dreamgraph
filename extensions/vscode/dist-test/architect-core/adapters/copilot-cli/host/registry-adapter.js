"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — real `CopilotCliRegistryPort`.
//
// After the v10.0.x inheritance-bridge redesign, this module's two
// responsibilities are:
//
//   1. `listAuthoritativeToolNames()` — open a short-lived MCP
//      client against the architect's already-running DreamGraph
//      daemon (Streamable HTTP at `<hostMcpUrl>`), ask `tools/list`,
//      add bridge-local support tools, and return the names. The
//      orchestrator uses this to verify the minimum grounding tools are
//      satisfied BEFORE spawning Copilot CLI. Probing the SAME endpoint
//      the bridge will forward to means a green probe is a real guarantee, not
//      a "different process happens to work" coincidence.
//
//   2. `describeBridgeSpawn()` — return the concrete spawn config
//      Copilot CLI will write into `mcp-config.json` to launch the
//      DreamGraph stdio MCP bridge (`bridge-entry.ts`). The bridge
//      runs as a stdio MCP server for Copilot CLI and forwards
//      every request to the architect's daemon over HTTP. See the
//      header of `bridge-entry.ts` for the rationale — short
//      version: spawning a fresh dreamgraph child here would create
//      a SECOND, unrelated graph session, which is exactly the
//      class of bug v10.0.x was created to prevent.
Object.defineProperty(exports, "__esModule", { value: true });
exports.createHostRegistry = createHostRegistry;
exports.bridgeEnvForRun = bridgeEnvForRun;
exports.probeDreamgraphHttpMcp = probeDreamgraphHttpMcp;
const index_js_1 = require("@modelcontextprotocol/sdk/client/index.js");
const streamableHttp_js_1 = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const audit_adapter_js_1 = require("./audit-adapter.js");
// The daemon answers `tools/list` over already-warm HTTP, so the
// probe budget can be tight. We pick 15 s as a safe ceiling that
// still bounds startup if the daemon is paging in from cold cache.
const DEFAULT_TOOL_LIST_TIMEOUT_MS = 15_000;
function createHostRegistry(opts) {
    validate(opts);
    const toolListTimeoutMs = opts.toolListTimeoutMs ?? DEFAULT_TOOL_LIST_TIMEOUT_MS;
    const hostMcpUrl = opts.hostMcpUrl;
    return Object.freeze({
        async listAuthoritativeToolNames() {
            const upstreamNames = await probeHostMcpToolNames({
                url: hostMcpUrl,
                timeoutMs: toolListTimeoutMs,
            });
            return Object.freeze(includeBridgeLocalToolNames(upstreamNames));
        },
        async describeBridgeSpawn() {
            const env = {
                ...(opts.extraBridgeEnv ?? {}),
                // The single piece of state the bridge needs to inherit
                // the architect's MCP session. Everything else (audit
                // path, server name) is layered on by the orchestrator
                // per-run via `bridgeEnvForRun`.
                DREAMGRAPH_HOST_MCP_URL: hostMcpUrl,
                DREAMGRAPH_BRIDGE_AUDIT_DIR: opts.auditDirAbsPath,
                DREAMGRAPH_WORKSPACE_ROOT: opts.workspaceRootAbsPath,
                // When the architect is running inside VS Code, `nodeExecPath`
                // is `process.execPath` of the Electron host (e.g. `Code.exe`),
                // not a plain Node binary. Without this flag the spawned
                // Electron process starts as a GUI app, never executes the
                // bridge .js as a script, and closes stdio immediately — which
                // the CLI then reports as "handshaking with MCP server failed:
                // connection closed: initialize response". Setting the flag is
                // a no-op for real Node binaries (they ignore unknown env vars),
                // so it's safe to set unconditionally.
                ELECTRON_RUN_AS_NODE: "1",
            };
            return Object.freeze({
                command: opts.nodeExecPath,
                args: Object.freeze([opts.bridgeEntryPath]),
                env: Object.freeze(env),
            });
        },
    });
}
/**
 * Compute the env overlay the bridge needs for a specific run. The
 * orchestrator passes the result through `dreamgraphEnv` on the MCP
 * config artifact so Copilot writes it into `mcp-config.json` and
 * Copilot CLI propagates it to the bridge child.
 */
function bridgeEnvForRun(opts) {
    return Object.freeze({
        DREAMGRAPH_AUDIT_PATH: (0, audit_adapter_js_1.auditFilePathFor)(opts.auditDirAbsPath, opts.runId),
    });
}
/**
 * Liveness probe used by host wiring to verify the architect's
 * DreamGraph MCP endpoint is actually serving requests before the
 * orchestrator begins a run. Throws on failure so the caller can
 * fall back to a disabled state with a clear error message instead
 * of waiting for Copilot CLI to fail mysteriously.
 */
async function probeDreamgraphHttpMcp(opts) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TOOL_LIST_TIMEOUT_MS;
    const names = await probeHostMcpToolNames({ url: opts.url, timeoutMs });
    return Object.freeze({ toolCount: names.length });
}
function includeBridgeLocalToolNames(upstreamNames) {
    const names = [...upstreamNames];
    if (!names.includes("run_command")) {
        names.push("run_command");
    }
    return names;
}
async function probeHostMcpToolNames(opts) {
    let url;
    try {
        url = new URL(opts.url);
    }
    catch (err) {
        throw new Error(`probeHostMcpToolNames: invalid URL ${opts.url}: ${err.message}`);
    }
    const transport = new streamableHttp_js_1.StreamableHTTPClientTransport(url);
    const client = new index_js_1.Client({ name: "dreamgraph-copilot-cli-registry-probe", version: "1.0.0" }, { capabilities: {} });
    const timeoutHandle = { id: null };
    const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle.id = setTimeout(() => {
            reject(new Error(`probeHostMcpToolNames: ${opts.url} tools/list probe exceeded ${opts.timeoutMs}ms`));
        }, opts.timeoutMs);
        timeoutHandle.id.unref?.();
    });
    try {
        const work = (async () => {
            await client.connect(transport);
            const result = await client.listTools();
            return result.tools.map((t) => t.name);
        })();
        return await Promise.race([work, timeoutPromise]);
    }
    finally {
        if (timeoutHandle.id)
            clearTimeout(timeoutHandle.id);
        try {
            await client.close();
        }
        catch {
            /* ignore */
        }
        try {
            await transport.close();
        }
        catch {
            /* ignore */
        }
    }
}
function validate(opts) {
    if (!opts || typeof opts !== "object") {
        throw new Error("createHostRegistry: opts is required");
    }
    for (const key of [
        "hostMcpUrl",
        "bridgeEntryPath",
        "nodeExecPath",
        "auditDirAbsPath",
        "workspaceRootAbsPath",
    ]) {
        const v = opts[key];
        if (typeof v !== "string" || v.length === 0) {
            throw new Error(`createHostRegistry: opts.${key} is required (non-empty string)`);
        }
    }
    try {
        // Throws on malformed URL. Catch -> rethrow with a clearer
        // message so the caller knows which arg is wrong.
        void new URL(opts.hostMcpUrl);
    }
    catch (err) {
        throw new Error(`createHostRegistry: opts.hostMcpUrl must be a valid URL (got ${JSON.stringify(opts.hostMcpUrl)}): ${err.message}`);
    }
    if (opts.toolListTimeoutMs !== undefined &&
        (!Number.isFinite(opts.toolListTimeoutMs) || opts.toolListTimeoutMs <= 0)) {
        throw new Error("createHostRegistry: opts.toolListTimeoutMs must be a positive finite number");
    }
}
//# sourceMappingURL=registry-adapter.js.map