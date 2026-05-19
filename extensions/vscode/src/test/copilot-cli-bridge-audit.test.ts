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

test("createHostAudit: missing file â†’ empty array, no throw", async () => {
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

test("createHostAudit: finishRecording without startRecording â†’ empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dg-audit-no-start-"));
  try {
    const audit = createHostAudit({ auditDirAbsPath: dir });
    const result = await audit.finishRecording("never-started");
    assert.deepEqual([...result], []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createHostAudit: second finishRecording for same runId â†’ empty", async () => {
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

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

interface UpstreamHandle {
  url: string;
  close: () => Promise<void>;
}

/**
 * Boot a real, in-process HTTP MCP server backed by the SDK. The
 * caller supplies `toolHandler(name, args)` which is invoked on
 * every tools/call; throwing inside it propagates as a JSON-RPC
 * error response â€” exactly what the bridge should record as
 * `isError: true`.
 */
async function startUpstreamHttpMcp(opts: {
  toolHandler: (name: string, args: Record<string, unknown>) => unknown;
}): Promise<UpstreamHandle> {
  function buildServer(): McpServer {
    const server = new McpServer(
      { name: "test-upstream", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({
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
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const out = opts.toolHandler(
        req.params.name,
        (req.params.arguments ?? {}) as Record<string, unknown>,
      );
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
  const sessions = new Map<
    string,
    { server: McpServer; transport: StreamableHTTPServerTransport }
  >();

  const http: HttpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (body += c));
    req.on("end", () => {
      void (async () => {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        const parsed = body.length > 0 ? safeJson(body) : undefined;
        if (sessionId && sessions.has(sessionId)) {
          await sessions.get(sessionId)!.transport.handleRequest(req, res, parsed);
          return;
        }
        if (req.method === "POST") {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (id) => {
              sessions.set(id, { server, transport });
            },
          });
          transport.onclose = () => {
            const id = transport.sessionId;
            if (id) sessions.delete(id);
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
  await new Promise<void>((res) => http.listen(0, "127.0.0.1", res));
  const addr = http.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}/mcp`;
  return {
    url,
    close: async () => {
      for (const { server, transport } of sessions.values()) {
        try {
          await transport.close();
        } catch {
          /* ignore */
        }
        try {
          await server.close();
        } catch {
          /* ignore */
        }
      }
      sessions.clear();
      await new Promise<void>((res) => http.close(() => res()));
    },
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

interface BridgeClientHandle {
  client: Client;
  close: () => Promise<void>;
  auditPath: string;
}

async function startBridgeClient(opts: {
  hostMcpUrl: string;
  withAudit: boolean;
}): Promise<BridgeClientHandle> {
  const dir = await mkdtemp(join(tmpdir(), "dg-bridge-"));
  const auditPath = join(dir, "calls.ndjson");
  const env: Record<string, string> = {
    ...filteredProcEnv(),
    DREAMGRAPH_HOST_MCP_URL: opts.hostMcpUrl,
    DREAMGRAPH_BRIDGE_SERVER_NAME: "dreamgraph",
  };
  if (opts.withAudit) env["DREAMGRAPH_AUDIT_PATH"] = auditPath;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BRIDGE_PATH],
    env,
    stderr: "pipe",
  });
  const client = new Client(
    { name: "test-driver", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return {
    client,
    auditPath,
    close: async () => {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
      try {
        await transport.close();
      } catch {
        /* ignore */
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function filteredProcEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") out[k] = v;
  }
  // Strip any pre-existing bridge config so tests are deterministic.
  delete out["DREAMGRAPH_HOST_MCP_URL"];
  delete out["DREAMGRAPH_AUDIT_PATH"];
  delete out["DREAMGRAPH_BRIDGE_SERVER_NAME"];
  return out;
}

async function readAuditLines(path: string): Promise<string[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw.split(/\r?\n/).filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

test("bridge: forwards tools/list to the HTTP upstream", async () => {
  const upstream = await startUpstreamHttpMcp({
    toolHandler: () => "ok",
  });
  const bridge = await startBridgeClient({ hostMcpUrl: upstream.url, withAudit: false });
  try {
    const result = await bridge.client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["boom", "list_directory", "query_resource"]);
    const lines = await readAuditLines(bridge.auditPath);
    assert.equal(lines.length, 0);
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test("bridge: forwards tools/call and writes one NDJSON audit record per call", async () => {
  let lastArgs: Record<string, unknown> | null = null;
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
    assert.deepEqual(lastArgs, { uri: "system://overview" });
    assert.equal(
      ((r1.content as Array<{ type: string; text: string }>)[0] ?? {}).text,
      "ok-query_resource",
    );

    const r2 = await bridge.client.callTool({
      name: "list_directory",
      arguments: { repo: "dreamgraph" },
    });
    assert.equal(
      ((r2.content as Array<{ type: string; text: string }>)[0] ?? {}).text,
      "ok-list_directory",
    );

    const lines = await readAuditLines(bridge.auditPath);
    assert.equal(lines.length, 2);
    const a = JSON.parse(lines[0]!);
    const b = JSON.parse(lines[1]!);
    assert.equal(a.server, "dreamgraph");
    assert.equal(a.tool, "query_resource");
    assert.equal(a.isError, false);
    assert.equal(typeof a.durationMs, "number");
    assert.ok(a.durationMs >= 0);
    assert.equal(typeof a.startedAtEpochMs, "number");
    assert.match(a.inputJson, /system:\/\/overview/);
    assert.match(a.resultJson, /ok-query_resource/);
    assert.equal(b.tool, "list_directory");
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test("bridge: marks JSON-RPC error responses with isError=true", async () => {
  const upstream = await startUpstreamHttpMcp({
    toolHandler: (name) => {
      if (name === "boom") throw new Error("boom failed");
      return "ok";
    },
  });
  const bridge = await startBridgeClient({ hostMcpUrl: upstream.url, withAudit: true });
  try {
    await assert.rejects(
      bridge.client.callTool({ name: "boom", arguments: {} }),
      /boom failed/,
    );
    const lines = await readAuditLines(bridge.auditPath);
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]!);
    assert.equal(rec.tool, "boom");
    assert.equal(rec.isError, true);
    assert.match(rec.resultJson, /boom failed/);
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test("bridge: only tools/call generates audit records (tools/list does not)", async () => {
  const upstream = await startUpstreamHttpMcp({
    toolHandler: () => "ok",
  });
  const bridge = await startBridgeClient({ hostMcpUrl: upstream.url, withAudit: true });
  try {
    await bridge.client.listTools();
    await bridge.client.callTool({ name: "query_resource", arguments: {} });
    const lines = await readAuditLines(bridge.auditPath);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]!).tool, "query_resource");
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test("bridge: fails fast (exit 2) when DREAMGRAPH_HOST_MCP_URL is unset", async () => {
  const env = filteredProcEnv();
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
  assert.match(stderr, /DREAMGRAPH_HOST_MCP_URL/);
});

test("bridge: fails fast (exit 2) when DREAMGRAPH_HOST_MCP_URL is malformed", async () => {
  const env = filteredProcEnv();
  env["DREAMGRAPH_HOST_MCP_URL"] = "not-a-url";
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
  assert.match(stderr, /not a valid URL/);
});

test("bridge: fails closed when upstream is unreachable", async () => {
  // Listen-only socket on an ephemeral port, then close it so the
  // port is "addressable but nobody's home". The bridge should
  // exit non-zero with a clear stderr message.
  const placeholder = createServer();
  await new Promise<void>((res) => placeholder.listen(0, "127.0.0.1", res));
  const addr = placeholder.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}/mcp`;
  await new Promise<void>((res) => placeholder.close(() => res()));

  const env = filteredProcEnv();
  env["DREAMGRAPH_HOST_MCP_URL"] = url;
  env["DREAMGRAPH_BRIDGE_HEALTH_TIMEOUT_MS"] = "2000";
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
  assert.notEqual(code, 0);
  assert.match(stderr, /failed to connect to architect MCP/);
});
