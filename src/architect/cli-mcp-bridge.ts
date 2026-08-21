import { spawn as spawnChild } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type ServerCapabilities,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

const HOST_MCP_URL = process.env.DREAMGRAPH_HOST_MCP_URL ?? "";
const AUDIT_DIR = process.env.DREAMGRAPH_BRIDGE_AUDIT_DIR ?? "";
const RUN_ID = process.env.DREAMGRAPH_RUN_ID ?? "";
const AUDIT_PATH = process.env.DREAMGRAPH_AUDIT_PATH
  ?? (AUDIT_DIR.length > 0 && RUN_ID.length > 0
    ? join(AUDIT_DIR, `${RUN_ID.replace(/[^A-Za-z0-9._-]/g, "_")}.ndjson`)
    : "");
const SERVER_NAME = process.env.DREAMGRAPH_BRIDGE_SERVER_NAME ?? "dreamgraph";
const WORKSPACE_ROOT = process.env.DREAMGRAPH_WORKSPACE_ROOT ?? process.cwd();
const HEALTH_TIMEOUT_MS = Number.parseInt(process.env.DREAMGRAPH_BRIDGE_HEALTH_TIMEOUT_MS ?? "", 10);
const HEALTH_BUDGET_MS = Number.isFinite(HEALTH_TIMEOUT_MS) && HEALTH_TIMEOUT_MS > 0
  ? HEALTH_TIMEOUT_MS
  : 15_000;
const AUDIT_BODY_LIMIT = 16 * 1024;
const AUDIT_QUEUE_LIMIT = 256;
const AUDIT_SHUTDOWN_BUDGET_MS = 2_000;

function bail(code: number, message: string): never {
  try {
    process.stderr.write(`[architect-cli-mcp-bridge] ${message}\n`);
  } catch {
    // ignore stderr failures during shutdown
  }
  process.exit(code);
}

if (HOST_MCP_URL.length === 0) {
  bail(2, "DREAMGRAPH_HOST_MCP_URL is required; refusing to start without an upstream DreamGraph MCP endpoint.");
}

let upstreamUrl: URL;
try {
  upstreamUrl = new URL(HOST_MCP_URL);
} catch (error) {
  bail(2, `DREAMGRAPH_HOST_MCP_URL is not a valid URL: ${(error as Error).message}`);
}

if (AUDIT_PATH.length > 0) {
  try {
    mkdirSync(dirname(AUDIT_PATH), { recursive: true });
  } catch (error) {
    process.stderr.write(`[architect-cli-mcp-bridge] failed to ensure audit dir: ${(error as Error).message}\n`);
  }
}

const upstream = new Client(
  { name: "dreamgraph-architect-cli-mcp-bridge", version: "1.0.0" },
  { capabilities: {} },
);
const upstreamTransport = new StreamableHTTPClientTransport(upstreamUrl);

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    handle.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (handle) clearTimeout(handle);
  }
}

async function main(): Promise<void> {
  let started = false;
  upstreamTransport.onclose = () => {
    if (!started) {
      bail(3, `upstream MCP transport closed before initialize completed: ${HOST_MCP_URL}`);
    }
    void shutdown(0);
  };

  try {
    await withTimeout(upstream.connect(upstreamTransport), HEALTH_BUDGET_MS, "upstream MCP connect");
  } catch (error) {
    bail(3, `failed to connect to upstream DreamGraph MCP at ${HOST_MCP_URL}: ${(error as Error).message}`);
  }

  started = true;
  const upstreamCaps: ServerCapabilities = upstream.getServerCapabilities() ?? {};
  const upstreamInstructions = upstream.getInstructions();
  const server = new Server(
    { name: SERVER_NAME, version: "1.0.0" },
    {
      capabilities: upstreamCaps,
      ...(upstreamInstructions !== undefined ? { instructions: upstreamInstructions } : {}),
    },
  );

  let toolListPromise: ReturnType<typeof upstream.listTools> | undefined;
  server.setRequestHandler(ListToolsRequestSchema, async (req) => {
    toolListPromise ??= upstream.listTools(req.params);
    let result;
    try {
      result = await toolListPromise;
    } catch (error) {
      toolListPromise = undefined;
      throw error;
    }
    if (result.tools.some((tool) => tool.name === RUN_COMMAND_TOOL.name)) return result;
    return { ...result, tools: [...result.tools, RUN_COMMAND_TOOL] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const startedAtEpochMs = Date.now();
    const correlationId = randomUUID();
    const inputJson = safeStringify(req.params.arguments ?? {});
    auditCallResult({
      tool: req.params.name,
      inputJson,
      resultJson: "",
      isError: false,
      status: "running",
      durationMs: 0,
      startedAtEpochMs,
      correlationId,
    });
    try {
      const result = req.params.name === RUN_COMMAND_TOOL.name
        ? await runLocalCommand(req.params.arguments ?? {})
        : await upstream.callTool(req.params);
      const isError = Boolean((result as { isError?: unknown }).isError);
      auditCallResult({
        tool: req.params.name,
        inputJson,
        resultJson: safeStringify(result),
        isError,
        status: isError ? "failed" : "completed",
        durationMs: Math.max(0, Date.now() - startedAtEpochMs),
        startedAtEpochMs,
        correlationId,
      });
      return result;
    } catch (error) {
      auditCallResult({
        tool: req.params.name,
        inputJson,
        resultJson: safeStringify({ message: (error as Error).message }),
        isError: true,
        status: "failed",
        durationMs: Math.max(0, Date.now() - startedAtEpochMs),
        startedAtEpochMs,
        correlationId,
      });
      throw error;
    }
  });

  if (upstreamCaps.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, async (req) => upstream.listResources(req.params));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async (req) => upstream.listResourceTemplates(req.params));
    server.setRequestHandler(ReadResourceRequestSchema, async (req) => upstream.readResource(req.params));
  }

  if (upstreamCaps.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, async (req) => upstream.listPrompts(req.params));
    server.setRequestHandler(GetPromptRequestSchema, async (req) => upstream.getPrompt(req.params));
  }

  const transport = new StdioServerTransport();
  transport.onclose = () => {
    void shutdown(0);
  };
  await server.connect(transport);
}

async function shutdown(code: number): Promise<void> {
  try {
    await upstream.close();
  } catch {
    // ignore shutdown failures
  }
  await withTimeout(flushAuditQueue(), AUDIT_SHUTDOWN_BUDGET_MS, "bridge audit flush").catch((error) => {
    process.stderr.write(`[architect-cli-mcp-bridge] audit flush incomplete: ${(error as Error).message}\n`);
  });
  process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(0);
  });
}

main().catch((error) => {
  bail(1, `bridge fatal error: ${(error as Error).message}`);
});

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value));
  }
}

const RUN_COMMAND_TOOL: Tool = Object.freeze({
  name: "run_command",
  description:
    "[DreamGraph bridge support tool] Execute a shell command inside the workspace for build/test/verification tasks. " +
    "Use this instead of provider-inline shell tools; cwd is constrained to the workspace root.",
  inputSchema: {
    type: "object" as const,
    properties: {
      command: { type: "string", description: "Shell command to execute, for example npm run build." },
      cwd: { type: "string", description: "Working directory, relative to the workspace root. Defaults to the workspace root." },
      timeoutMs: { type: "number", description: "Timeout in milliseconds. Defaults to 60000, capped at 300000." },
    },
    required: ["command"],
  },
});

const RUN_COMMAND_DEFAULT_TIMEOUT_MS = 60_000;
const RUN_COMMAND_MAX_TIMEOUT_MS = 300_000;
const RUN_COMMAND_OUTPUT_LIMIT = 64 * 1024;

type LocalToolResult = CallToolResult;

async function runLocalCommand(args: unknown): Promise<LocalToolResult> {
  const input = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (command.length === 0) {
    return localTextResult({ error: "run_command requires a non-empty command" }, true);
  }

  const cwd = resolveWorkspaceCwd(input.cwd);
  const requestedTimeout = typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
    ? input.timeoutMs
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

function resolveWorkspaceCwd(value: unknown): string {
  const root = resolve(WORKSPACE_ROOT);
  const requested = typeof value === "string" && value.trim().length > 0 ? value.trim() : ".";
  const abs = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
  const rel = relative(root, abs);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return abs;
  }
  throw new Error(`run_command cwd must stay inside workspace root ${root}`);
}

function spawnShellCommand(command: string, cwd: string, timeoutMs: number): Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
}> {
  return new Promise((resolvePromise, reject) => {
    const isWin = process.platform === "win32";
    const child = isWin
      ? spawnChild(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${command}"`], {
          cwd,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          windowsVerbatimArguments: true,
        })
      : spawnChild(process.env.SHELL ?? "/bin/sh", ["-lc", command], {
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
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, exitCode, signal, timedOut });
    });
  });
}

function appendLimited(current: string, next: string): string {
  const combined = current + next;
  if (combined.length <= RUN_COMMAND_OUTPUT_LIMIT) return combined;
  return `${combined.slice(0, RUN_COMMAND_OUTPUT_LIMIT)}\n[output truncated]`;
}

function localTextResult(value: unknown, isError: boolean): LocalToolResult {
  return {
    content: [{ type: "text", text: `${JSON.stringify(value, null, 2)}\n` }],
    ...(isError ? { isError: true } : {}),
  };
}

interface AuditRecord {
  tool: string;
  inputJson: string;
  resultJson: string;
  isError: boolean;
  status: "running" | "completed" | "failed";
  durationMs: number;
  startedAtEpochMs: number;
  correlationId: string;
}

const auditQueue: string[] = [];
let auditDrain: Promise<void> | undefined;

function boundedAuditBody(value: string): { body: string; bytes: number; sha256: string; truncated: boolean } {
  const bytes = Buffer.byteLength(value, "utf8");
  const sha256 = createHash("sha256").update(value).digest("hex");
  if (bytes <= AUDIT_BODY_LIMIT) return { body: value, bytes, sha256, truncated: false };
  return { body: value.slice(0, AUDIT_BODY_LIMIT), bytes, sha256, truncated: true };
}

function auditCallResult(record: AuditRecord): void {
  if (AUDIT_PATH.length === 0) return;
  const input = boundedAuditBody(record.inputJson);
  const result = boundedAuditBody(record.resultJson);
  const line = `${JSON.stringify({
    server: SERVER_NAME,
    ...record,
    inputJson: input.body,
    resultJson: result.body,
    inputBytes: input.bytes,
    resultBytes: result.bytes,
    inputSha256: input.sha256,
    resultSha256: result.sha256,
    inputTruncated: input.truncated,
    resultTruncated: result.truncated,
  })}\n`;
  if (auditQueue.length >= AUDIT_QUEUE_LIMIT) {
    const replaceable = auditQueue.findIndex((queued) => queued.includes('"status":"running"'));
    if (replaceable >= 0) auditQueue.splice(replaceable, 1);
    else {
      process.stderr.write("[architect-cli-mcp-bridge] audit queue overflow; preserving existing terminal records\n");
      return;
    }
  }
  auditQueue.push(line);
  auditDrain ??= drainAuditQueue();
}

async function drainAuditQueue(): Promise<void> {
  try {
    while (auditQueue.length > 0) {
      const line = auditQueue.shift()!;
      await new Promise<void>((resolvePromise, reject) => {
        appendFile(AUDIT_PATH, line, { encoding: "utf8" }, (error) => error ? reject(error) : resolvePromise());
      });
    }
  } catch (error) {
    process.stderr.write(`[architect-cli-mcp-bridge] failed to write audit record: ${(error as Error).message}\n`);
  } finally {
    auditDrain = undefined;
    if (auditQueue.length > 0) auditDrain = drainAuditQueue();
  }
}

async function flushAuditQueue(): Promise<void> {
  while (auditDrain || auditQueue.length > 0) {
    if (auditDrain) await auditDrain;
    else auditDrain = drainAuditQueue();
  }
}
