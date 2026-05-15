// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — DreamGraph stdio MCP bridge entry point
// (Slice 3b).
//
// This file is BUNDLED INTO ITS OWN STANDALONE ARTIFACT and shipped
// alongside the extension at `dist/copilot-cli-bridge.js`. Copilot
// CLI spawns it (per `mcp-config.json`) when it wants to talk to the
// DreamGraph MCP server. The bridge:
//
//   1. Spawns the real DreamGraph stdio MCP server as a child.
//   2. Pipes Copilot's stdin → child stdin, child stdout → Copilot's
//      stdout, child stderr → bridge stderr (which Copilot inherits).
//   3. Sniffs the newline-delimited JSON-RPC traffic in BOTH
//      directions, pairs `tools/call` requests with their responses
//      by `id`, and appends one NDJSON record per pair to the audit
//      file (so the orchestrator's `CopilotCliMcpAuditPort` has an
//      authoritative source of truth for which tools were actually
//      served).
//
// Configuration (env, all required unless noted):
//   DREAMGRAPH_BRIDGE_TARGET_COMMAND   — absolute path to dreamgraph
//                                        (or any stdio MCP server).
//   DREAMGRAPH_BRIDGE_TARGET_ARGS_JSON — JSON-encoded string array
//                                        for the target argv. Defaults
//                                        to `[]` when unset/blank.
//   DREAMGRAPH_AUDIT_PATH              — absolute path to the NDJSON
//                                        audit file (one per run).
//                                        When unset, the bridge runs
//                                        as a transparent proxy with
//                                        no audit output.
//   DREAMGRAPH_BRIDGE_SERVER_NAME      — name to record under
//                                        `server` in audit records.
//                                        Defaults to "dreamgraph".
//
// Hard rules:
//   - The bridge is provider-agnostic: it knows nothing about Copilot,
//     Anthropic, OpenAI, etc. It only knows MCP JSON-RPC over stdio.
//   - The bridge MUST exit with the same exit code as the child so
//     Copilot CLI can react to MCP server crashes.
//   - Audit failures MUST NOT corrupt the proxied stream. We swallow
//     write errors and continue forwarding bytes verbatim.

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

interface PendingCall {
  readonly tool: string;
  readonly inputJson: string;
  readonly startedAtEpochMs: number;
}

const TARGET_COMMAND = process.env["DREAMGRAPH_BRIDGE_TARGET_COMMAND"] ?? "";
const TARGET_ARGS_JSON = process.env["DREAMGRAPH_BRIDGE_TARGET_ARGS_JSON"] ?? "";
const AUDIT_PATH = process.env["DREAMGRAPH_AUDIT_PATH"] ?? "";
const SERVER_NAME = process.env["DREAMGRAPH_BRIDGE_SERVER_NAME"] ?? "dreamgraph";

if (TARGET_COMMAND.length === 0) {
  process.stderr.write(
    "[copilot-cli-bridge] DREAMGRAPH_BRIDGE_TARGET_COMMAND is required\n",
  );
  process.exit(2);
}

let targetArgs: string[] = [];
if (TARGET_ARGS_JSON.length > 0) {
  try {
    const parsed = JSON.parse(TARGET_ARGS_JSON);
    if (!Array.isArray(parsed) || !parsed.every((s) => typeof s === "string")) {
      throw new Error("not a string[]");
    }
    targetArgs = parsed as string[];
  } catch (err) {
    process.stderr.write(
      `[copilot-cli-bridge] DREAMGRAPH_BRIDGE_TARGET_ARGS_JSON is not a JSON string array: ${
        (err as Error).message
      }\n`,
    );
    process.exit(2);
  }
}

if (AUDIT_PATH.length > 0) {
  // Pre-create the audit directory so the first appendFile call cannot
  // race on `mkdir -p`. The audit-adapter also calls mkdir on its side,
  // but we cannot assume strict ordering between extension host and
  // bridge spawn.
  try {
    mkdirSync(dirname(AUDIT_PATH), { recursive: true });
  } catch (err) {
    process.stderr.write(
      `[copilot-cli-bridge] failed to ensure audit dir: ${(err as Error).message}\n`,
    );
    // Continue without audit rather than failing the run — proxying is
    // the primary responsibility.
  }
}

const child = spawn(TARGET_COMMAND, targetArgs, {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

child.on("error", (err) => {
  process.stderr.write(
    `[copilot-cli-bridge] failed to spawn target: ${err.message}\n`,
  );
  process.exit(127);
});

// ---------------------------------------------------------------------------
// Stdin (Copilot → bridge → child) — sniff requests, then forward verbatim.
// ---------------------------------------------------------------------------

const pending = new Map<string | number, PendingCall>();

const stdinSniffer = makeNdjsonSniffer((msg) => {
  // tools/call request: capture id, tool name, input JSON.
  if (
    typeof msg !== "object" ||
    msg === null ||
    !("method" in msg) ||
    msg["method"] !== "tools/call"
  ) {
    return;
  }
  const id = (msg as { id?: unknown }).id;
  if (typeof id !== "string" && typeof id !== "number") return;
  const params = (msg as { params?: unknown }).params;
  if (typeof params !== "object" || params === null) return;
  const tool = (params as { name?: unknown }).name;
  if (typeof tool !== "string") return;
  const args = (params as { arguments?: unknown }).arguments;
  pending.set(id, {
    tool,
    inputJson: safeStringify(args ?? {}),
    startedAtEpochMs: Date.now(),
  });
});

process.stdin.on("data", (chunk: Buffer) => {
  // Forward to child first to minimize latency, then sniff.
  try {
    child.stdin.write(chunk);
  } catch {
    /* child died; the close handler will exit */
  }
  if (AUDIT_PATH.length > 0) {
    stdinSniffer.feed(chunk);
  }
});
process.stdin.on("end", () => {
  try {
    child.stdin.end();
  } catch {
    /* ignore */
  }
});

// ---------------------------------------------------------------------------
// Stdout (child → bridge → Copilot) — sniff responses, then forward verbatim.
// ---------------------------------------------------------------------------

const stdoutSniffer = makeNdjsonSniffer((msg) => {
  if (typeof msg !== "object" || msg === null) return;
  const id = (msg as { id?: unknown }).id;
  if (typeof id !== "string" && typeof id !== "number") return;
  const pendingCall = pending.get(id);
  if (!pendingCall) return;
  pending.delete(id);

  const isError = "error" in msg
    || (typeof (msg as { result?: unknown }).result === "object"
        && (msg as { result: { isError?: unknown } }).result !== null
        && (msg as { result: { isError?: unknown } }).result.isError === true);

  let resultJson: string;
  if ("error" in msg) {
    resultJson = safeStringify((msg as { error: unknown }).error);
  } else {
    resultJson = safeStringify((msg as { result?: unknown }).result ?? null);
  }

  appendAudit({
    server: SERVER_NAME,
    tool: pendingCall.tool,
    inputJson: pendingCall.inputJson,
    resultJson,
    isError,
    durationMs: Math.max(0, Date.now() - pendingCall.startedAtEpochMs),
    startedAtEpochMs: pendingCall.startedAtEpochMs,
  });
});

child.stdout.on("data", (chunk: Buffer) => {
  try {
    process.stdout.write(chunk);
  } catch {
    /* parent stdout closed; nothing useful to do */
  }
  if (AUDIT_PATH.length > 0) {
    stdoutSniffer.feed(chunk);
  }
});

child.stderr.on("data", (chunk: Buffer) => {
  try {
    process.stderr.write(chunk);
  } catch {
    /* ignore */
  }
});

child.on("close", (code, signal) => {
  if (typeof code === "number") {
    process.exit(code);
  }
  if (signal) {
    process.stderr.write(`[copilot-cli-bridge] target killed by ${signal}\n`);
    process.exit(128);
  }
  process.exit(0);
});

// Forward fatal signals to the child so cleanup is symmetric.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    try {
      child.kill(sig);
    } catch {
      /* ignore */
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface NdjsonSniffer {
  feed(chunk: Buffer): void;
}

/**
 * Newline-delimited JSON sniffer. MCP stdio uses one JSON object per
 * line (terminated by `\n`). We accumulate bytes until we see a
 * newline, parse the line as JSON, and call `onMessage`. Bytes are
 * NEVER mutated, dropped, or re-emitted — sniffing is a read-only
 * side effect of the proxy.
 */
function makeNdjsonSniffer(onMessage: (msg: unknown) => void): NdjsonSniffer {
  let buf = "";
  return {
    feed(chunk) {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line.length === 0) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          // Non-JSON line. MCP stdio shouldn't produce these but a
          // malformed server might; ignore and keep proxying.
          continue;
        }
        try {
          onMessage(parsed);
        } catch {
          // Sniffer callbacks must never crash the bridge.
        }
      }
    },
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value));
  }
}

function appendAudit(record: {
  server: string;
  tool: string;
  inputJson: string;
  resultJson: string;
  isError: boolean;
  durationMs: number;
  startedAtEpochMs: number;
}): void {
  if (AUDIT_PATH.length === 0) return;
  try {
    appendFileSync(AUDIT_PATH, `${JSON.stringify(record)}\n`, { encoding: "utf8" });
  } catch (err) {
    process.stderr.write(
      `[copilot-cli-bridge] failed to write audit record: ${(err as Error).message}\n`,
    );
  }
}
