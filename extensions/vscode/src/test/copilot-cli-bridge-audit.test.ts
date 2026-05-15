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

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  auditFilePathFor,
  createHostAudit,
} from "../architect-core/adapters/copilot-cli/host/index.js";

// Resolve the standalone bridge bundle. Tests run after `npm run build`
// so this path is guaranteed to exist; if it does not, the failing
// assertion below tells the developer to rebuild.
const BRIDGE_PATH = resolve(__dirname, "..", "..", "dist", "copilot-cli-bridge.js");

// ---------------------------------------------------------------------------
// audit-adapter
// ---------------------------------------------------------------------------

test("auditFilePathFor: composes a deterministic path under the dir", () => {
  const p = auditFilePathFor("/tmp/audit", "run-abc-123");
  assert.equal(p, join("/tmp/audit", "run-abc-123.ndjson"));
});

test("auditFilePathFor: rejects empty inputs", () => {
  assert.throws(() => auditFilePathFor("", "x"));
  assert.throws(() => auditFilePathFor("/x", ""));
});

test("auditFilePathFor: sanitizes unsafe runId characters", () => {
  const p = auditFilePathFor("/tmp/audit", "run/with..slashes");
  assert.equal(p, join("/tmp/audit", "run_with..slashes.ndjson"));
});

test("createHostAudit: rejects empty auditDirAbsPath", () => {
  // @ts-expect-error testing invalid input
  assert.throws(() => createHostAudit({}));
  assert.throws(() => createHostAudit({ auditDirAbsPath: "" }));
});

test("createHostAudit: missing file → empty array, no throw", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dg-audit-missing-"));
  try {
    const audit = createHostAudit({ auditDirAbsPath: dir });
    await audit.startRecording("run-no-calls");
    const result = await audit.finishRecording("run-no-calls");
    assert.deepEqual([...result], []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createHostAudit: parses NDJSON, drops malformed lines, deletes file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dg-audit-parse-"));
  try {
    const audit = createHostAudit({ auditDirAbsPath: dir });
    await audit.startRecording("run-mixed");

    const path = auditFilePathFor(dir, "run-mixed");
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
    await writeFile(
      path,
      `${goodA}\n${malformed}\n${wrongShape}\n${goodB}\n`,
      "utf8",
    );

    const result = await audit.finishRecording("run-mixed");
    assert.equal(result.length, 2);
    assert.equal(result[0]!.tool, "query_resource");
    assert.equal(result[0]!.isError, false);
    assert.equal(result[1]!.tool, "list_directory");
    assert.equal(result[1]!.isError, true);

    // File deleted after read.
    await assert.rejects(readFile(path, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createHostAudit: finishRecording without startRecording → empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dg-audit-no-start-"));
  try {
    const audit = createHostAudit({ auditDirAbsPath: dir });
    const result = await audit.finishRecording("never-started");
    assert.deepEqual([...result], []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createHostAudit: second finishRecording for same runId → empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dg-audit-twice-"));
  try {
    const audit = createHostAudit({ auditDirAbsPath: dir });
    await audit.startRecording("run-twice");
    const path = auditFilePathFor(dir, "run-twice");
    await writeFile(
      path,
      `${JSON.stringify({
        server: "dreamgraph",
        tool: "query_resource",
        inputJson: "{}",
        resultJson: "{}",
        isError: false,
        durationMs: 1,
        startedAtEpochMs: 1,
      })}\n`,
      "utf8",
    );
    const first = await audit.finishRecording("run-twice");
    assert.equal(first.length, 1);
    const second = await audit.finishRecording("run-twice");
    assert.equal(second.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
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

interface BridgeRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  auditLines: string[];
}

async function runBridge(opts: {
  inputLines: readonly string[];
  withAudit: boolean;
}): Promise<BridgeRunResult> {
  const dir = await mkdtemp(join(tmpdir(), "dg-bridge-"));
  const auditPath = join(dir, "calls.ndjson");
  const env: Record<string, string> = {
    ...filteredProcEnv(),
    DREAMGRAPH_BRIDGE_TARGET_COMMAND: process.execPath,
    DREAMGRAPH_BRIDGE_TARGET_ARGS_JSON: JSON.stringify(["-e", FAKE_SERVER_SCRIPT]),
    DREAMGRAPH_BRIDGE_SERVER_NAME: "dreamgraph",
  };
  if (opts.withAudit) {
    env["DREAMGRAPH_AUDIT_PATH"] = auditPath;
  }

  const child = spawn(process.execPath, [BRIDGE_PATH], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (c: string) => (stdout += c));
  child.stderr!.on("data", (c: string) => (stderr += c));

  for (const line of opts.inputLines) {
    child.stdin!.write(`${line}\n`);
  }
  child.stdin!.end();

  const exitCode: number | null = await new Promise((res) => {
    child.on("close", (code) => res(typeof code === "number" ? code : null));
  });

  let auditLines: string[] = [];
  if (opts.withAudit) {
    try {
      const raw = await readFile(auditPath, "utf8");
      auditLines = raw.split(/\r?\n/).filter((l) => l.length > 0);
    } catch {
      auditLines = [];
    }
  }
  await rm(dir, { recursive: true, force: true });
  return { stdout, stderr, exitCode, auditLines };
}

function filteredProcEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

test("bridge: forwards stdin to child and child stdout to parent verbatim", async () => {
  const req = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "query_resource", arguments: { uri: "system://overview" } },
  });
  const r = await runBridge({ inputLines: [req], withAudit: false });
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /"id":1/);
  assert.match(r.stdout, /ok-query_resource/);
  assert.equal(r.auditLines.length, 0);
});

test("bridge: writes one NDJSON audit record per request/response pair", async () => {
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
  assert.equal(r.exitCode, 0);
  assert.equal(r.auditLines.length, 2);

  const a = JSON.parse(r.auditLines[0]!);
  const b = JSON.parse(r.auditLines[1]!);
  assert.equal(a.server, "dreamgraph");
  assert.equal(a.tool, "query_resource");
  assert.equal(a.isError, false);
  assert.equal(typeof a.durationMs, "number");
  assert.ok(a.durationMs >= 0);
  assert.equal(typeof a.startedAtEpochMs, "number");
  assert.match(a.inputJson, /system|x/);
  assert.match(a.resultJson, /ok-query_resource/);

  assert.equal(b.tool, "list_directory");
});

test("bridge: marks JSON-RPC error responses with isError=true", async () => {
  const req = JSON.stringify({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "boom", arguments: {} },
  });
  const r = await runBridge({ inputLines: [req], withAudit: true });
  assert.equal(r.exitCode, 0);
  assert.equal(r.auditLines.length, 1);
  const rec = JSON.parse(r.auditLines[0]!);
  assert.equal(rec.tool, "boom");
  assert.equal(rec.isError, true);
  assert.match(rec.resultJson, /boom failed/);
});

test("bridge: fails fast (exit 2) when DREAMGRAPH_BRIDGE_TARGET_COMMAND is unset", async () => {
  const env = filteredProcEnv();
  delete env["DREAMGRAPH_BRIDGE_TARGET_COMMAND"];
  delete env["DREAMGRAPH_AUDIT_PATH"];
  const child = spawn(process.execPath, [BRIDGE_PATH], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdin!.end();
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (c: string) => (stderr += c));
  const code: number | null = await new Promise((res) => {
    child.on("close", (c) => res(typeof c === "number" ? c : null));
  });
  assert.equal(code, 2);
  assert.match(stderr, /DREAMGRAPH_BRIDGE_TARGET_COMMAND/);
});

test("bridge: fails fast (exit 2) when DREAMGRAPH_BRIDGE_TARGET_ARGS_JSON is malformed", async () => {
  const env = filteredProcEnv();
  env["DREAMGRAPH_BRIDGE_TARGET_COMMAND"] = process.execPath;
  env["DREAMGRAPH_BRIDGE_TARGET_ARGS_JSON"] = "not-a-json-array";
  delete env["DREAMGRAPH_AUDIT_PATH"];
  const child = spawn(process.execPath, [BRIDGE_PATH], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdin!.end();
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (c: string) => (stderr += c));
  const code: number | null = await new Promise((res) => {
    child.on("close", (c) => res(typeof c === "number" ? c : null));
  });
  assert.equal(code, 2);
  assert.match(stderr, /DREAMGRAPH_BRIDGE_TARGET_ARGS_JSON/);
});

test("bridge: ignores non-tools/call traffic in audit (e.g. initialize)", async () => {
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
  assert.equal(r.exitCode, 0);
  assert.equal(r.auditLines.length, 1);
  assert.equal(JSON.parse(r.auditLines[0]!).tool, "query_resource");
});
