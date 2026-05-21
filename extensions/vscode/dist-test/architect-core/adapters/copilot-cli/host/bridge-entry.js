"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — DreamGraph MCP inheritance bridge.
//
// This file is BUNDLED INTO ITS OWN STANDALONE ARTIFACT and shipped
// alongside the extension at `dist/copilot-cli-bridge.js`. Copilot
// CLI spawns it (per `mcp-config.json`) when it wants to talk to the
// DreamGraph MCP server.
//
// CRITICAL DESIGN POINT (and the difference from a "spawn a second
// dreamgraph child" naive proxy): the architect (extension host)
// already maintains a live MCP connection to the user's DreamGraph
// daemon over HTTP (Streamable HTTP at `<baseUrl>/mcp`). Spawning a
// fresh stdio dreamgraph child here would be wrong for three reasons:
//   1. It bypasses the architect's session/instance scoping — the
//      Copilot CLI would see a different graph than the architect
//      that called it.
//   2. It silently doubles resource usage and contention on the
//      JSON stores.
//   3. It can hide reachability failures from the architect's UX —
//      we want the SAME upstream health to dictate whether Copilot
//      CLI runs at all.
//
// So this bridge ACTS AS a stdio MCP server towards Copilot CLI, but
// every request is forwarded to the architect's already-open daemon
// session over HTTP. If the upstream is unreachable, the bridge
// FAILS CLOSED before MCP initialize completes, so Copilot CLI sees
// the server as "failed to load" and the orchestrator's fail-fast
// path in `provider-port.ts` aborts the run.
//
// Configuration (env, all read at process start):
//   DREAMGRAPH_HOST_MCP_URL          — required; full URL to the
//                                       architect's MCP endpoint
//                                       (e.g. `http://127.0.0.1:7321/mcp`).
//   DREAMGRAPH_AUDIT_PATH            — optional; absolute path to an
//                                       NDJSON file the bridge appends
//                                       one record per `tools/call`
//                                       to. When unset, the bridge
//                                       runs without audit output.
//   DREAMGRAPH_BRIDGE_SERVER_NAME    — optional; name recorded under
//                                       `server` in audit records.
//                                       Defaults to "dreamgraph".
//   DREAMGRAPH_BRIDGE_HEALTH_TIMEOUT_MS — optional; ms budget for the
//                                       initial upstream `tools/list`
//                                       health probe. Defaults to
//                                       15000.
//
// Hard rules:
//   - Provider-agnostic: knows nothing about Copilot, Anthropic, etc.
//     Only knows stdio MCP server <-> HTTP MCP client forwarding.
//   - FAIL CLOSED on upstream errors. Never serve stale or fabricated
//     results. If we cannot reach the daemon, exit non-zero so the
//     CLI reports the server failed.
Object.defineProperty(exports, "__esModule", { value: true });
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const index_js_1 = require("@modelcontextprotocol/sdk/client/index.js");
const streamableHttp_js_1 = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const index_js_2 = require("@modelcontextprotocol/sdk/server/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const HOST_MCP_URL = process.env["DREAMGRAPH_HOST_MCP_URL"] ?? "";
const AUDIT_DIR = process.env["DREAMGRAPH_BRIDGE_AUDIT_DIR"] ?? "";
const RUN_ID = process.env["DREAMGRAPH_RUN_ID"] ?? "";
const AUDIT_PATH = process.env["DREAMGRAPH_AUDIT_PATH"]
    ?? (AUDIT_DIR.length > 0 && RUN_ID.length > 0
        ? (0, node_path_1.join)(AUDIT_DIR, `${RUN_ID.replace(/[^A-Za-z0-9._-]/g, "_")}.ndjson`)
        : "");
const SERVER_NAME = process.env["DREAMGRAPH_BRIDGE_SERVER_NAME"] ?? "dreamgraph";
const WORKSPACE_ROOT = process.env["DREAMGRAPH_WORKSPACE_ROOT"] ?? process.cwd();
const HEALTH_TIMEOUT_MS = Number.parseInt(process.env["DREAMGRAPH_BRIDGE_HEALTH_TIMEOUT_MS"] ?? "", 10);
const HEALTH_BUDGET_MS = Number.isFinite(HEALTH_TIMEOUT_MS) && HEALTH_TIMEOUT_MS > 0
    ? HEALTH_TIMEOUT_MS
    : 15_000;
function bail(code, msg) {
    try {
        process.stderr.write(`[copilot-cli-bridge] ${msg}\n`);
    }
    catch {
        /* ignore */
    }
    process.exit(code);
}
if (HOST_MCP_URL.length === 0) {
    bail(2, "DREAMGRAPH_HOST_MCP_URL is required (the architect's MCP endpoint URL, e.g. http://127.0.0.1:<port>/mcp). Refusing to start.");
}
let upstreamUrl;
try {
    upstreamUrl = new URL(HOST_MCP_URL);
}
catch (err) {
    bail(2, `DREAMGRAPH_HOST_MCP_URL is not a valid URL: ${err.message}`);
}
if (AUDIT_PATH.length > 0) {
    try {
        (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(AUDIT_PATH), { recursive: true });
    }
    catch (err) {
        process.stderr.write(`[copilot-cli-bridge] failed to ensure audit dir: ${err.message}\n`);
        // Continue without audit rather than failing the run — proxying
        // is the primary responsibility, audit is a secondary signal.
    }
}
// ---------------------------------------------------------------------------
// Upstream: open Streamable HTTP client to the architect's daemon.
// FAIL CLOSED if we cannot connect or list tools within the health
// budget. This is the boundary the user demanded: "fail closed before
// model execution if the proxy cannot confirm upstream health".
// ---------------------------------------------------------------------------
const upstream = new index_js_1.Client({ name: "dreamgraph-copilot-cli-bridge", version: "1.0.0" }, { capabilities: {} });
const upstreamTransport = new streamableHttp_js_1.StreamableHTTPClientTransport(upstreamUrl);
async function withTimeout(p, ms, label) {
    let handle = null;
    const timeout = new Promise((_, reject) => {
        handle = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        handle.unref?.();
    });
    try {
        return await Promise.race([p, timeout]);
    }
    finally {
        if (handle)
            clearTimeout(handle);
    }
}
async function main() {
    // During startup, an upstream close means we never finished health
    // probing — surface it as a fail-closed bail, not a clean shutdown.
    let started = false;
    upstreamTransport.onclose = () => {
        if (!started) {
            bail(3, `failed to connect to architect MCP at ${HOST_MCP_URL}: upstream transport closed before initialize completed. ` +
                `Ensure the DreamGraph daemon is running and the extension is connected before invoking Copilot CLI.`);
        }
        process.stderr.write(`[copilot-cli-bridge] upstream MCP transport closed; shutting down.\n`);
        void shutdown(0);
    };
    try {
        await withTimeout(upstream.connect(upstreamTransport), HEALTH_BUDGET_MS, "upstream MCP connect");
    }
    catch (err) {
        bail(3, `failed to connect to architect MCP at ${HOST_MCP_URL}: ${err.message}. ` +
            `Ensure the DreamGraph daemon is running and the extension is connected before invoking Copilot CLI.`);
    }
    // Health probe — proves the upstream is actually responsive, not
    // just TCP-reachable. tools/list is the cheapest authoritative call.
    try {
        await withTimeout(upstream.listTools(), HEALTH_BUDGET_MS, "upstream tools/list probe");
    }
    catch (err) {
        bail(3, `upstream MCP health probe failed: ${err.message}. ` +
            `The architect's DreamGraph session at ${HOST_MCP_URL} is not serving requests.`);
    }
    started = true;
    // Mirror the upstream's capabilities so the CLI sees the same
    // feature set the architect already negotiated.
    const upstreamCaps = upstream.getServerCapabilities() ?? {};
    const upstreamInstructions = upstream.getInstructions();
    const server = new index_js_2.Server({ name: SERVER_NAME, version: "1.0.0" }, {
        capabilities: upstreamCaps,
        ...(upstreamInstructions !== undefined ? { instructions: upstreamInstructions } : {}),
    });
    // tools/list — upstream DreamGraph tools plus bridge-local support tools.
    server.setRequestHandler(types_js_1.ListToolsRequestSchema, async (req) => {
        const result = await upstream.listTools(req.params);
        if (result.tools.some((tool) => tool.name === RUN_COMMAND_TOOL.name)) {
            return result;
        }
        return {
            ...result,
            tools: [...result.tools, RUN_COMMAND_TOOL],
        };
    });
    // tools/call — bridge-local support tools or upstream forward + audit.
    // Audit failures must not corrupt the proxied response, so we wrap
    // appendAudit in try/catch.
    server.setRequestHandler(types_js_1.CallToolRequestSchema, async (req) => {
        const startedAtEpochMs = Date.now();
        const inputJson = safeStringify(req.params.arguments ?? {});
        try {
            const result = req.params.name === RUN_COMMAND_TOOL.name
                ? await runLocalCommand(req.params.arguments ?? {})
                : await upstream.callTool(req.params);
            auditCallResult({
                tool: req.params.name,
                inputJson,
                resultJson: safeStringify(result),
                isError: Boolean(result.isError),
                durationMs: Math.max(0, Date.now() - startedAtEpochMs),
                startedAtEpochMs,
            });
            return result;
        }
        catch (err) {
            auditCallResult({
                tool: req.params.name,
                inputJson,
                resultJson: safeStringify({ message: err.message }),
                isError: true,
                durationMs: Math.max(0, Date.now() - startedAtEpochMs),
                startedAtEpochMs,
            });
            throw err;
        }
    });
    // resources/list, resources/templates/list, resources/read — pure
    // forwards. Guarded by upstream capability advertisement: if the
    // upstream did not advertise `resources`, the SDK won't even
    // dispatch these to us.
    if (upstreamCaps.resources) {
        server.setRequestHandler(types_js_1.ListResourcesRequestSchema, async (req) => {
            return upstream.listResources(req.params);
        });
        server.setRequestHandler(types_js_1.ListResourceTemplatesRequestSchema, async (req) => {
            return upstream.listResourceTemplates(req.params);
        });
        server.setRequestHandler(types_js_1.ReadResourceRequestSchema, async (req) => {
            return upstream.readResource(req.params);
        });
    }
    // prompts/list, prompts/get — same pattern.
    if (upstreamCaps.prompts) {
        server.setRequestHandler(types_js_1.ListPromptsRequestSchema, async (req) => {
            return upstream.listPrompts(req.params);
        });
        server.setRequestHandler(types_js_1.GetPromptRequestSchema, async (req) => {
            return upstream.getPrompt(req.params);
        });
    }
    const transport = new stdio_js_1.StdioServerTransport();
    transport.onclose = () => {
        void shutdown(0);
    };
    await server.connect(transport);
}
// ---------------------------------------------------------------------------
// Lifecycle — keep the bridge alive until upstream/stdio closes.
// ---------------------------------------------------------------------------
async function shutdown(code) {
    try {
        await upstream.close();
    }
    catch {
        /* ignore */
    }
    process.exit(code);
}
for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
        void shutdown(0);
    });
}
main().catch((err) => {
    bail(1, `bridge fatal error: ${err.message}`);
});
// ---------------------------------------------------------------------------
// Audit helpers (single-record-per-tool-call NDJSON, same schema the
// orchestrator's `CopilotCliMcpAuditPort` already consumes).
// ---------------------------------------------------------------------------
function safeStringify(value) {
    try {
        return JSON.stringify(value);
    }
    catch {
        return JSON.stringify(String(value));
    }
}
const RUN_COMMAND_TOOL = Object.freeze({
    name: "run_command",
    description: "[DreamGraph bridge support tool] Execute a shell command inside the workspace for build/test/verification tasks. " +
        "Use this instead of provider-inline shell tools; cwd is constrained to the workspace root.",
    inputSchema: {
        type: "object",
        properties: {
            command: {
                type: "string",
                description: "Shell command to execute, for example npm run build.",
            },
            cwd: {
                type: "string",
                description: "Working directory, relative to the workspace root. Defaults to the workspace root.",
            },
            timeoutMs: {
                type: "number",
                description: "Timeout in milliseconds. Defaults to 60000, capped at 300000.",
            },
        },
        required: ["command"],
    },
});
const RUN_COMMAND_DEFAULT_TIMEOUT_MS = 60_000;
const RUN_COMMAND_MAX_TIMEOUT_MS = 300_000;
const RUN_COMMAND_OUTPUT_LIMIT = 64 * 1024;
async function runLocalCommand(args) {
    const input = args && typeof args === "object" && !Array.isArray(args)
        ? args
        : {};
    const command = typeof input["command"] === "string" ? input["command"].trim() : "";
    if (command.length === 0) {
        return localTextResult({ error: "run_command requires a non-empty command" }, true);
    }
    const cwd = resolveWorkspaceCwd(input["cwd"]);
    const requestedTimeout = typeof input["timeoutMs"] === "number" && Number.isFinite(input["timeoutMs"])
        ? input["timeoutMs"]
        : RUN_COMMAND_DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.min(RUN_COMMAND_MAX_TIMEOUT_MS, Math.max(1_000, Math.trunc(requestedTimeout)));
    const startedAt = Date.now();
    const result = await spawnShellCommand(command, cwd, timeoutMs);
    return localTextResult({
        command,
        cwd,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        durationMs: Math.max(0, Date.now() - startedAt),
        stdout: result.stdout,
        stderr: result.stderr,
    }, result.timedOut || result.exitCode !== 0);
}
function resolveWorkspaceCwd(value) {
    const root = (0, node_path_1.resolve)(WORKSPACE_ROOT);
    const requested = typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : ".";
    const abs = (0, node_path_1.isAbsolute)(requested) ? (0, node_path_1.resolve)(requested) : (0, node_path_1.resolve)(root, requested);
    const rel = (0, node_path_1.relative)(root, abs);
    if (rel === "" || (!rel.startsWith("..") && !(0, node_path_1.isAbsolute)(rel))) {
        return abs;
    }
    throw new Error(`run_command cwd must stay inside workspace root ${root}`);
}
function spawnShellCommand(command, cwd, timeoutMs) {
    return new Promise((resolvePromise, reject) => {
        const isWin = process.platform === "win32";
        // On Windows, cmd.exe /S /C strips one outer pair of quotes from the
        // command tail. If the user's command itself begins and ends with a
        // quoted token (e.g. a quoted path to node.exe), cmd will strip THOSE
        // quotes and break the call. Wrapping the entire command in an extra
        // outer pair preserves user-supplied quoting verbatim.
        const child = isWin
            ? (0, node_child_process_1.spawn)(process.env["ComSpec"] ?? "cmd.exe", ["/d", "/s", "/c", `"${command}"`], {
                cwd,
                env: process.env,
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
                windowsVerbatimArguments: true,
            })
            : (0, node_child_process_1.spawn)(process.env["SHELL"] ?? "/bin/sh", ["-lc", command], {
                cwd,
                env: process.env,
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
            });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
        }, timeoutMs);
        timer.unref?.();
        child.stdout.on("data", (chunk) => {
            stdout = appendLimited(stdout, String(chunk));
        });
        child.stderr.on("data", (chunk) => {
            stderr = appendLimited(stderr, String(chunk));
        });
        child.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
        });
        child.on("close", (exitCode, signal) => {
            clearTimeout(timer);
            resolvePromise({ stdout, stderr, exitCode, signal, timedOut });
        });
    });
}
function appendLimited(current, next) {
    const combined = current + next;
    if (combined.length <= RUN_COMMAND_OUTPUT_LIMIT)
        return combined;
    return combined.slice(0, RUN_COMMAND_OUTPUT_LIMIT) + "\n[output truncated]";
}
function localTextResult(value, isError) {
    return {
        content: [{ type: "text", text: `${JSON.stringify(value, null, 2)}\n` }],
        ...(isError ? { isError: true } : {}),
    };
}
function auditCallResult(rec) {
    if (AUDIT_PATH.length === 0)
        return;
    try {
        (0, node_fs_1.appendFileSync)(AUDIT_PATH, `${JSON.stringify({ server: SERVER_NAME, ...rec })}\n`, { encoding: "utf8" });
    }
    catch (err) {
        process.stderr.write(`[copilot-cli-bridge] failed to write audit record: ${err.message}\n`);
    }
}
//# sourceMappingURL=bridge-entry.js.map