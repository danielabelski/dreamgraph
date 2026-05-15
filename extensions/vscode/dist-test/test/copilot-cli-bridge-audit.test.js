"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — Slice 3b tests for the audit adapter + bridge.
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
(0, node_test_1.default)("createHostAudit: missing file → empty array, no throw", async () => {
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
(0, node_test_1.default)("createHostAudit: finishRecording without startRecording → empty", async () => {
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
(0, node_test_1.default)("createHostAudit: second finishRecording for same runId → empty", async () => {
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
// bridge-entry
// ---------------------------------------------------------------------------
//
// Strategy: spawn the bridge bundle with env that points it at a tiny
// inline Node "fake MCP server" launched via `node -e`. We then feed
// the bridge JSON-RPC tools/call lines on its stdin and observe both
// the stdout passthrough and the audit NDJSON file.
const FAKE_SERVER_SCRIPT = `
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg && msg.method === 'tools/call' && msg.id !== undefined) {
      const tool = msg.params && msg.params.name;
      const isError = tool === 'boom';
      const reply = isError
        ? { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'boom failed' } }
        : { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok-' + tool }], isError: false } };
      process.stdout.write(JSON.stringify(reply) + '\\n');
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;
async function runBridge(opts) {
    const dir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "dg-bridge-"));
    const auditPath = (0, node_path_1.join)(dir, "calls.ndjson");
    const env = {
        ...filteredProcEnv(),
        DREAMGRAPH_BRIDGE_TARGET_COMMAND: process.execPath,
        DREAMGRAPH_BRIDGE_TARGET_ARGS_JSON: JSON.stringify(["-e", FAKE_SERVER_SCRIPT]),
        DREAMGRAPH_BRIDGE_SERVER_NAME: "dreamgraph",
    };
    if (opts.withAudit) {
        env["DREAMGRAPH_AUDIT_PATH"] = auditPath;
    }
    const child = (0, node_child_process_1.spawn)(process.execPath, [BRIDGE_PATH], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    for (const line of opts.inputLines) {
        child.stdin.write(`${line}\n`);
    }
    child.stdin.end();
    const exitCode = await new Promise((res) => {
        child.on("close", (code) => res(typeof code === "number" ? code : null));
    });
    let auditLines = [];
    if (opts.withAudit) {
        try {
            const raw = await (0, promises_1.readFile)(auditPath, "utf8");
            auditLines = raw.split(/\r?\n/).filter((l) => l.length > 0);
        }
        catch {
            auditLines = [];
        }
    }
    await (0, promises_1.rm)(dir, { recursive: true, force: true });
    return { stdout, stderr, exitCode, auditLines };
}
function filteredProcEnv() {
    const out = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === "string")
            out[k] = v;
    }
    return out;
}
(0, node_test_1.default)("bridge: forwards stdin to child and child stdout to parent verbatim", async () => {
    const req = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "query_resource", arguments: { uri: "system://overview" } },
    });
    const r = await runBridge({ inputLines: [req], withAudit: false });
    strict_1.default.equal(r.exitCode, 0);
    strict_1.default.match(r.stdout, /"id":1/);
    strict_1.default.match(r.stdout, /ok-query_resource/);
    strict_1.default.equal(r.auditLines.length, 0);
});
(0, node_test_1.default)("bridge: writes one NDJSON audit record per request/response pair", async () => {
    const req1 = JSON.stringify({
        jsonrpc: "2.0",
        id: "a",
        method: "tools/call",
        params: { name: "query_resource", arguments: { uri: "x" } },
    });
    const req2 = JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list_directory", arguments: { repo: "dreamgraph" } },
    });
    const r = await runBridge({ inputLines: [req1, req2], withAudit: true });
    strict_1.default.equal(r.exitCode, 0);
    strict_1.default.equal(r.auditLines.length, 2);
    const a = JSON.parse(r.auditLines[0]);
    const b = JSON.parse(r.auditLines[1]);
    strict_1.default.equal(a.server, "dreamgraph");
    strict_1.default.equal(a.tool, "query_resource");
    strict_1.default.equal(a.isError, false);
    strict_1.default.equal(typeof a.durationMs, "number");
    strict_1.default.ok(a.durationMs >= 0);
    strict_1.default.equal(typeof a.startedAtEpochMs, "number");
    strict_1.default.match(a.inputJson, /system|x/);
    strict_1.default.match(a.resultJson, /ok-query_resource/);
    strict_1.default.equal(b.tool, "list_directory");
});
(0, node_test_1.default)("bridge: marks JSON-RPC error responses with isError=true", async () => {
    const req = JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "boom", arguments: {} },
    });
    const r = await runBridge({ inputLines: [req], withAudit: true });
    strict_1.default.equal(r.exitCode, 0);
    strict_1.default.equal(r.auditLines.length, 1);
    const rec = JSON.parse(r.auditLines[0]);
    strict_1.default.equal(rec.tool, "boom");
    strict_1.default.equal(rec.isError, true);
    strict_1.default.match(rec.resultJson, /boom failed/);
});
(0, node_test_1.default)("bridge: fails fast (exit 2) when DREAMGRAPH_BRIDGE_TARGET_COMMAND is unset", async () => {
    const env = filteredProcEnv();
    delete env["DREAMGRAPH_BRIDGE_TARGET_COMMAND"];
    delete env["DREAMGRAPH_AUDIT_PATH"];
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
    strict_1.default.match(stderr, /DREAMGRAPH_BRIDGE_TARGET_COMMAND/);
});
(0, node_test_1.default)("bridge: fails fast (exit 2) when DREAMGRAPH_BRIDGE_TARGET_ARGS_JSON is malformed", async () => {
    const env = filteredProcEnv();
    env["DREAMGRAPH_BRIDGE_TARGET_COMMAND"] = process.execPath;
    env["DREAMGRAPH_BRIDGE_TARGET_ARGS_JSON"] = "not-a-json-array";
    delete env["DREAMGRAPH_AUDIT_PATH"];
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
    strict_1.default.match(stderr, /DREAMGRAPH_BRIDGE_TARGET_ARGS_JSON/);
});
(0, node_test_1.default)("bridge: ignores non-tools/call traffic in audit (e.g. initialize)", async () => {
    const init = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
    });
    const call = JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "query_resource", arguments: {} },
    });
    const r = await runBridge({ inputLines: [init, call], withAudit: true });
    strict_1.default.equal(r.exitCode, 0);
    strict_1.default.equal(r.auditLines.length, 1);
    strict_1.default.equal(JSON.parse(r.auditLines[0]).tool, "query_resource");
});
//# sourceMappingURL=copilot-cli-bridge-audit.test.js.map