"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter â€” Slice 3b tests for the audit adapter + bridge.
//
// 1. `createHostAudit` is exercised against real `node:fs` operations
//    (mkdtemp, NDJSON read-back, malformed-line skipping, missing-file
//    quiet path).
// 2. `dist/copilot-cli-bridge.js` is launched as a real child process
//    against a Node-based fake stdio MCP server. We feed JSON-RPC into
//    the bridge's stdin, observe verbatim forwarding on stdout, and
//    verify the bridge wrote the expected NDJSON audit records to the
//    file pointed at by `DREAMGRAPH_AUDIT_PATH`.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const node_child_process_1 = require("node:child_process");
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const index_js_1 = require("../architect-core/adapters/copilot-cli/host/index.js");
// Resolve the standalone bridge bundle. Tests run after `npm run build`
// so this path is guaranteed to exist; if it does not, the failing
// assertion below tells the developer to rebuild.
const BRIDGE_PATH = (0, node_path_1.resolve)(__dirname, "..", "..", "dist", "copilot-cli-bridge.js");
// ---------------------------------------------------------------------------
// audit-adapter
// ---------------------------------------------------------------------------
(0, node_test_1.default)("auditFilePathFor: composes a deterministic path under the dir", () => {
    const p = (0, index_js_1.auditFilePathFor)("/tmp/audit", "run-abc-123");
    strict_1.default.equal(p, (0, node_path_1.join)("/tmp/audit", "run-abc-123.ndjson"));
});
(0, node_test_1.default)("auditFilePathFor: rejects empty inputs", () => {
    strict_1.default.throws(() => (0, index_js_1.auditFilePathFor)("", "x"));
    strict_1.default.throws(() => (0, index_js_1.auditFilePathFor)("/x", ""));
});
(0, node_test_1.default)("auditFilePathFor: sanitizes unsafe runId characters", () => {
    const p = (0, index_js_1.auditFilePathFor)("/tmp/audit", "run/with..slashes");
    strict_1.default.equal(p, (0, node_path_1.join)("/tmp/audit", "run_with..slashes.ndjson"));
});
(0, node_test_1.default)("createHostAudit: rejects empty auditDirAbsPath", () => {
    // @ts-expect-error testing invalid input
    strict_1.default.throws(() => (0, index_js_1.createHostAudit)({}));
    strict_1.default.throws(() => (0, index_js_1.createHostAudit)({ auditDirAbsPath: "" }));
});
(0, node_test_1.default)("createHostAudit: missing file â†’ empty array, no throw", async () => {
    const dir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "dg-audit-missing-"));
    try {
        const audit = (0, index_js_1.createHostAudit)({ auditDirAbsPath: dir });
        await audit.startRecording("run-no-calls");
        const result = await audit.finishRecording("run-no-calls");
        strict_1.default.deepEqual([...result], []);
    }
    finally {
        await (0, promises_1.rm)(dir, { recursive: true, force: true });
    }
});
(0, node_test_1.default)("createHostAudit: parses NDJSON, drops malformed lines, deletes file", async () => {
    const dir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "dg-audit-parse-"));
    try {
        const audit = (0, index_js_1.createHostAudit)({ auditDirAbsPath: dir });
        await audit.startRecording("run-mixed");
        const path = (0, index_js_1.auditFilePathFor)(dir, "run-mixed");
        const goodA = JSON.stringify({
            server: "dreamgraph",
            tool: "query_resource",
            inputJson: "{\"uri\":\"system://overview\"}",
            resultJson: "{\"ok\":true}",
            isError: false,
            durationMs: 12,
            startedAtEpochMs: 1_700_000_000_000,
        });
        const goodB = JSON.stringify({
            server: "dreamgraph",
            tool: "list_directory",
            inputJson: "{\"repo\":\"dreamgraph\"}",
            resultJson: "{\"entries\":[]}",
            isError: true,
            durationMs: 3,
            startedAtEpochMs: 1_700_000_000_500,
        });
        // Mix in a malformed JSON line and a wrong-shape line.
        const malformed = "{not json";
        const wrongShape = JSON.stringify({ server: "dreamgraph", tool: 42 });
        await (0, promises_1.writeFile)(path, `${goodA}\n${malformed}\n${wrongShape}\n${goodB}\n`, "utf8");
        const result = await audit.finishRecording("run-mixed");
        strict_1.default.equal(result.length, 2);
        strict_1.default.equal(result[0].tool, "query_resource");
        strict_1.default.equal(result[0].isError, false);
        strict_1.default.equal(result[1].tool, "list_directory");
        strict_1.default.equal(result[1].isError, true);
        // File deleted after read.
        await strict_1.default.rejects((0, promises_1.readFile)(path, "utf8"));
    }
    finally {
        await (0, promises_1.rm)(dir, { recursive: true, force: true });
    }
});
(0, node_test_1.default)("createHostAudit: finishRecording without startRecording â†’ empty", async () => {
    const dir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "dg-audit-no-start-"));
    try {
        const audit = (0, index_js_1.createHostAudit)({ auditDirAbsPath: dir });
        const result = await audit.finishRecording("never-started");
        strict_1.default.deepEqual([...result], []);
    }
    finally {
        await (0, promises_1.rm)(dir, { recursive: true, force: true });
    }
});
(0, node_test_1.default)("createHostAudit: second finishRecording for same runId â†’ empty", async () => {
    const dir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "dg-audit-twice-"));
    try {
        const audit = (0, index_js_1.createHostAudit)({ auditDirAbsPath: dir });
        await audit.startRecording("run-twice");
        const path = (0, index_js_1.auditFilePathFor)(dir, "run-twice");
        await (0, promises_1.writeFile)(path, `${JSON.stringify({
            server: "dreamgraph",
            tool: "query_resource",
            inputJson: "{}",
            resultJson: "{}",
            isError: false,
            durationMs: 1,
            startedAtEpochMs: 1,
        })}\n`, "utf8");
        const first = await audit.finishRecording("run-twice");
        strict_1.default.equal(first.length, 1);
        const second = await audit.finishRecording("run-twice");
        strict_1.default.equal(second.length, 0);
    }
    finally {
        await (0, promises_1.rm)(dir, { recursive: true, force: true });
    }
});
// ---------------------------------------------------------------------------
// bridge-entry (HTTP MCP inheritance proxy)
// ---------------------------------------------------------------------------
//
// After the v10.0.x bridge redesign, the bridge no longer spawns a
// stdio dreamgraph child. It opens a Streamable HTTP MCP client to
// the architect's already-running daemon (`DREAMGRAPH_HOST_MCP_URL`)
// and forwards every inbound stdio MCP request.
//
// Test strategy:
//   1. Stand up an in-process HTTP MCP server using the official SDK
//      (`Server` + `StreamableHTTPServerTransport`). This is the
//      "upstream daemon" stand-in.
//   2. Spawn the bridge bundle via `StdioClientTransport`, passing
//      `DREAMGRAPH_HOST_MCP_URL` pointing at our stand-in.
//   3. Drive the bridge as a real MCP client. Verify forwarding +
//      audit NDJSON contents + fail-closed behaviour.
const node_http_1 = require("node:http");
const index_js_2 = require("@modelcontextprotocol/sdk/client/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/client/stdio.js");
const index_js_3 = require("@modelcontextprotocol/sdk/server/index.js");
const streamableHttp_js_1 = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
/**
 * Boot a real, in-process HTTP MCP server backed by the SDK. The
 * caller supplies `toolHandler(name, args)` which is invoked on
 * every tools/call; throwing inside it propagates as a JSON-RPC
 * error response â€” exactly what the bridge should record as
 * `isError: true`.
 */
async function startUpstreamHttpMcp(opts) {
    function buildServer() {
        const server = new index_js_3.Server({ name: "test-upstream", version: "1.0.0" }, { capabilities: { tools: {} } });
        server.setRequestHandler(types_js_1.ListToolsRequestSchema, () => ({
            tools: [
                {
                    name: "query_resource",
                    description: "test tool",
                    inputSchema: { type: "object", properties: {}, additionalProperties: true },
                },
                {
                    name: "list_directory",
                    description: "test tool",
                    inputSchema: { type: "object", properties: {}, additionalProperties: true },
                },
                {
                    name: "boom",
                    description: "test tool that throws",
                    inputSchema: { type: "object", properties: {}, additionalProperties: true },
                },
            ],
        }));
        server.setRequestHandler(types_js_1.CallToolRequestSchema, async (req) => {
            const out = opts.toolHandler(req.params.name, (req.params.arguments ?? {}));
            return {
                content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out) }],
                isError: false,
            };
        });
        return server;
    }
    // Mirror the real daemon: session-id based routing, one McpServer +
    // transport per session, created lazily on POST initialize.
    const crypto = await import("node:crypto");
    const sessions = new Map();
    const http = (0, node_http_1.createServer)((req, res) => {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            void (async () => {
                const sessionId = req.headers["mcp-session-id"];
                const parsed = body.length > 0 ? safeJson(body) : undefined;
                if (sessionId && sessions.has(sessionId)) {
                    await sessions.get(sessionId).transport.handleRequest(req, res, parsed);
                    return;
                }
                if (req.method === "POST") {
                    const transport = new streamableHttp_js_1.StreamableHTTPServerTransport({
                        sessionIdGenerator: () => crypto.randomUUID(),
                        onsessioninitialized: (id) => {
                            sessions.set(id, { server, transport });
                        },
                    });
                    transport.onclose = () => {
                        const id = transport.sessionId;
                        if (id)
                            sessions.delete(id);
                    };
                    const server = buildServer();
                    await server.connect(transport);
                    await transport.handleRequest(req, res, parsed);
                    return;
                }
                res.writeHead(400);
                res.end();
            })();
        });
    });
    await new Promise((res) => http.listen(0, "127.0.0.1", res));
    const addr = http.address();
    const url = `http://127.0.0.1:${addr.port}/mcp`;
    return {
        url,
        close: async () => {
            for (const { server, transport } of sessions.values()) {
                try {
                    await transport.close();
                }
                catch {
                    /* ignore */
                }
                try {
                    await server.close();
                }
                catch {
                    /* ignore */
                }
            }
            sessions.clear();
            await new Promise((res) => http.close(() => res()));
        },
    };
}
function safeJson(s) {
    try {
        return JSON.parse(s);
    }
    catch {
        return undefined;
    }
}
async function startBridgeClient(opts) {
    const dir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "dg-bridge-"));
    const auditPath = (0, node_path_1.join)(dir, "calls.ndjson");
    const env = {
        ...filteredProcEnv(),
        DREAMGRAPH_HOST_MCP_URL: opts.hostMcpUrl,
        DREAMGRAPH_BRIDGE_SERVER_NAME: "dreamgraph",
    };
    if (opts.withAudit)
        env["DREAMGRAPH_AUDIT_PATH"] = auditPath;
    const transport = new stdio_js_1.StdioClientTransport({
        command: process.execPath,
        args: [BRIDGE_PATH],
        env,
        stderr: "pipe",
    });
    const client = new index_js_2.Client({ name: "test-driver", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    return {
        client,
        auditPath,
        close: async () => {
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
            await (0, promises_1.rm)(dir, { recursive: true, force: true });
        },
    };
}
function filteredProcEnv() {
    const out = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === "string")
            out[k] = v;
    }
    // Strip any pre-existing bridge config so tests are deterministic.
    delete out["DREAMGRAPH_HOST_MCP_URL"];
    delete out["DREAMGRAPH_AUDIT_PATH"];
    delete out["DREAMGRAPH_BRIDGE_SERVER_NAME"];
    return out;
}
async function readAuditLines(path) {
    try {
        const raw = await (0, promises_1.readFile)(path, "utf8");
        return raw.split(/\r?\n/).filter((l) => l.length > 0);
    }
    catch {
        return [];
    }
}
(0, node_test_1.default)("bridge: forwards tools/list to the HTTP upstream", async () => {
    const upstream = await startUpstreamHttpMcp({
        toolHandler: () => "ok",
    });
    const bridge = await startBridgeClient({ hostMcpUrl: upstream.url, withAudit: false });
    try {
        const result = await bridge.client.listTools();
        const names = result.tools.map((t) => t.name).sort();
        strict_1.default.deepEqual(names, ["boom", "list_directory", "query_resource", "run_command"]);
        const lines = await readAuditLines(bridge.auditPath);
        strict_1.default.equal(lines.length, 0);
    }
    finally {
        await bridge.close();
        await upstream.close();
    }
});
(0, node_test_1.default)("bridge: run_command is bridge-local and does not call the upstream handler", async () => {
    let upstreamCalls = 0;
    const upstream = await startUpstreamHttpMcp({
        toolHandler: () => {
            upstreamCalls += 1;
            return "unexpected-upstream";
        },
    });
    const bridge = await startBridgeClient({ hostMcpUrl: upstream.url, withAudit: true });
    try {
        const command = `${JSON.stringify(process.execPath)} -e "process.stdout.write('bridge-local-ok')"`;
        const result = await bridge.client.callTool({
            name: "run_command",
            arguments: { command, cwd: "." },
        });
        const text = (result.content[0] ?? {}).text;
        strict_1.default.match(text, /bridge-local-ok/);
        strict_1.default.equal(upstreamCalls, 0);
        const lines = await readAuditLines(bridge.auditPath);
        strict_1.default.equal(lines.length, 1);
        const rec = JSON.parse(lines[0]);
        strict_1.default.equal(rec.server, "dreamgraph");
        strict_1.default.equal(rec.tool, "run_command");
        strict_1.default.equal(rec.isError, false);
    }
    finally {
        await bridge.close();
        await upstream.close();
    }
});
(0, node_test_1.default)("bridge: forwards tools/call and writes one NDJSON audit record per call", async () => {
    let lastArgs = null;
    const upstream = await startUpstreamHttpMcp({
        toolHandler: (name, args) => {
            lastArgs = args;
            return `ok-${name}`;
        },
    });
    const bridge = await startBridgeClient({ hostMcpUrl: upstream.url, withAudit: true });
    try {
        const r1 = await bridge.client.callTool({
            name: "query_resource",
            arguments: { uri: "system://overview" },
        });
        strict_1.default.deepEqual(lastArgs, { uri: "system://overview" });
        strict_1.default.equal((r1.content[0] ?? {}).text, "ok-query_resource");
        const r2 = await bridge.client.callTool({
            name: "list_directory",
            arguments: { repo: "dreamgraph" },
        });
        strict_1.default.equal((r2.content[0] ?? {}).text, "ok-list_directory");
        const lines = await readAuditLines(bridge.auditPath);
        strict_1.default.equal(lines.length, 2);
        const a = JSON.parse(lines[0]);
        const b = JSON.parse(lines[1]);
        strict_1.default.equal(a.server, "dreamgraph");
        strict_1.default.equal(a.tool, "query_resource");
        strict_1.default.equal(a.isError, false);
        strict_1.default.equal(typeof a.durationMs, "number");
        strict_1.default.ok(a.durationMs >= 0);
        strict_1.default.equal(typeof a.startedAtEpochMs, "number");
        strict_1.default.match(a.inputJson, /system:\/\/overview/);
        strict_1.default.match(a.resultJson, /ok-query_resource/);
        strict_1.default.equal(b.tool, "list_directory");
    }
    finally {
        await bridge.close();
        await upstream.close();
    }
});
(0, node_test_1.default)("bridge: marks JSON-RPC error responses with isError=true", async () => {
    const upstream = await startUpstreamHttpMcp({
        toolHandler: (name) => {
            if (name === "boom")
                throw new Error("boom failed");
            return "ok";
        },
    });
    const bridge = await startBridgeClient({ hostMcpUrl: upstream.url, withAudit: true });
    try {
        await strict_1.default.rejects(bridge.client.callTool({ name: "boom", arguments: {} }), /boom failed/);
        const lines = await readAuditLines(bridge.auditPath);
        strict_1.default.equal(lines.length, 1);
        const rec = JSON.parse(lines[0]);
        strict_1.default.equal(rec.tool, "boom");
        strict_1.default.equal(rec.isError, true);
        strict_1.default.match(rec.resultJson, /boom failed/);
    }
    finally {
        await bridge.close();
        await upstream.close();
    }
});
(0, node_test_1.default)("bridge: only tools/call generates audit records (tools/list does not)", async () => {
    const upstream = await startUpstreamHttpMcp({
        toolHandler: () => "ok",
    });
    const bridge = await startBridgeClient({ hostMcpUrl: upstream.url, withAudit: true });
    try {
        await bridge.client.listTools();
        await bridge.client.callTool({ name: "query_resource", arguments: {} });
        const lines = await readAuditLines(bridge.auditPath);
        strict_1.default.equal(lines.length, 1);
        strict_1.default.equal(JSON.parse(lines[0]).tool, "query_resource");
    }
    finally {
        await bridge.close();
        await upstream.close();
    }
});
(0, node_test_1.default)("bridge: fails fast (exit 2) when DREAMGRAPH_HOST_MCP_URL is unset", async () => {
    const env = filteredProcEnv();
    const child = (0, node_child_process_1.spawn)(process.execPath, [BRIDGE_PATH], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
    });
    child.stdin.end();
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => (stderr += c));
    const code = await new Promise((res) => {
        child.on("close", (c) => res(typeof c === "number" ? c : null));
    });
    strict_1.default.equal(code, 2);
    strict_1.default.match(stderr, /DREAMGRAPH_HOST_MCP_URL/);
});
(0, node_test_1.default)("bridge: fails fast (exit 2) when DREAMGRAPH_HOST_MCP_URL is malformed", async () => {
    const env = filteredProcEnv();
    env["DREAMGRAPH_HOST_MCP_URL"] = "not-a-url";
    const child = (0, node_child_process_1.spawn)(process.execPath, [BRIDGE_PATH], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
    });
    child.stdin.end();
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => (stderr += c));
    const code = await new Promise((res) => {
        child.on("close", (c) => res(typeof c === "number" ? c : null));
    });
    strict_1.default.equal(code, 2);
    strict_1.default.match(stderr, /not a valid URL/);
});
(0, node_test_1.default)("bridge: fails closed when upstream is unreachable", async () => {
    // Listen-only socket on an ephemeral port, then close it so the
    // port is "addressable but nobody's home". The bridge should
    // exit non-zero with a clear stderr message.
    const placeholder = (0, node_http_1.createServer)();
    await new Promise((res) => placeholder.listen(0, "127.0.0.1", res));
    const addr = placeholder.address();
    const url = `http://127.0.0.1:${addr.port}/mcp`;
    await new Promise((res) => placeholder.close(() => res()));
    const env = filteredProcEnv();
    env["DREAMGRAPH_HOST_MCP_URL"] = url;
    env["DREAMGRAPH_BRIDGE_HEALTH_TIMEOUT_MS"] = "2000";
    const child = (0, node_child_process_1.spawn)(process.execPath, [BRIDGE_PATH], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
    });
    child.stdin.end();
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => (stderr += c));
    const code = await new Promise((res) => {
        child.on("close", (c) => res(typeof c === "number" ? c : null));
    });
    strict_1.default.notEqual(code, 0);
    strict_1.default.match(stderr, /failed to connect to architect MCP/);
});
//# sourceMappingURL=copilot-cli-bridge-audit.test.js.map