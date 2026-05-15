// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — real `CopilotCliRegistryPort` (Slice 3b).
//
// Two responsibilities:
//
//   1. `listAuthoritativeToolNames()` — spin up a short-lived MCP
//      client against the configured DreamGraph stdio MCP server, ask
//      `tools/list`, return the names. The orchestrator uses this to
//      verify `COPILOT_REQUIRED_AUTHORITATIVE_TOOLS` is satisfied
//      BEFORE spawning Copilot CLI, so we trade a few hundred ms of
//      one-time latency for a strong runtime sanity check.
//
//   2. `describeBridgeSpawn()` — return the concrete spawn config
//      Copilot CLI will write into `mcp-config.json` to launch the
//      DreamGraph stdio MCP bridge (the `bridge-entry.ts` artifact).
//      The bridge in turn re-spawns the real DreamGraph stdio server
//      and sniffs the JSON-RPC traffic for the audit port.
//
// This file deliberately depends on `@modelcontextprotocol/sdk` only
// for the client. The server side stays in the dreamgraph package; the
// extension only proxies to it.

import { spawn } from "node:child_process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type {
  CopilotCliRegistryPort,
  CopilotMcpBridgeSpawn,
} from "../orchestrator-ports.js";
import { auditFilePathFor } from "./audit-adapter.js";

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

const DEFAULT_DREAMGRAPH_ARGS: readonly string[] = ["--transport", "stdio"];
const DEFAULT_TOOL_LIST_TIMEOUT_MS = 8_000;

export function createHostRegistry(opts: HostRegistryOptions): CopilotCliRegistryPort {
  validate(opts);
  const dreamgraphArgs = opts.dreamgraphArgs ?? DEFAULT_DREAMGRAPH_ARGS;
  const toolListTimeoutMs = opts.toolListTimeoutMs ?? DEFAULT_TOOL_LIST_TIMEOUT_MS;

  return Object.freeze({
    async listAuthoritativeToolNames(): Promise<readonly string[]> {
      const transport = new StdioClientTransport({
        command: opts.dreamgraphCommand,
        args: [...dreamgraphArgs],
        stderr: "ignore",
      });
      const client = new Client(
        { name: "dreamgraph-copilot-cli-registry-probe", version: "1.0.0" },
        { capabilities: {} },
      );

      const timeoutHandle: { id: NodeJS.Timeout | null } = { id: null };
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle.id = setTimeout(() => {
          reject(
            new Error(
              `listAuthoritativeToolNames: dreamgraph tools/list probe exceeded ${toolListTimeoutMs}ms`,
            ),
          );
        }, toolListTimeoutMs);
        timeoutHandle.id.unref?.();
      });

      try {
        const work = (async () => {
          await client.connect(transport);
          const result = await client.listTools();
          return result.tools.map((t) => t.name);
        })();
        const names = await Promise.race([work, timeoutPromise]);
        return Object.freeze(names);
      } finally {
        if (timeoutHandle.id) clearTimeout(timeoutHandle.id);
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
      }
    },

    async describeBridgeSpawn(): Promise<CopilotMcpBridgeSpawn> {
      const env: Record<string, string> = {
        ...(opts.extraBridgeEnv ?? {}),
        DREAMGRAPH_BRIDGE_TARGET_COMMAND: opts.dreamgraphCommand,
        DREAMGRAPH_BRIDGE_TARGET_ARGS_JSON: JSON.stringify([...dreamgraphArgs]),
        DREAMGRAPH_BRIDGE_AUDIT_DIR: opts.auditDirAbsPath,
        // The bridge expects `DREAMGRAPH_AUDIT_PATH` to point at the
        // run-specific NDJSON file. The orchestrator overlays
        // `DREAMGRAPH_RUN_ID` on top of this env, but Copilot CLI does
        // not perform variable expansion — so the orchestrator MUST
        // resolve the file path itself when it knows the runId. We
        // expose the directory here and the orchestrator's caller
        // (Slice 4) is responsible for setting `DREAMGRAPH_AUDIT_PATH`
        // explicitly via `extraBridgeEnv` before each run, OR for
        // calling `bridgeEnvForRun` below.
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
export function bridgeEnvForRun(
  opts: { auditDirAbsPath: string; runId: string },
): Readonly<Record<string, string>> {
  return Object.freeze({
    DREAMGRAPH_AUDIT_PATH: auditFilePathFor(opts.auditDirAbsPath, opts.runId),
  });
}

/**
 * Quick liveness probe used by Slice 4 host wiring to verify the
 * DreamGraph stdio server actually starts before the orchestrator
 * begins a run. Throws on failure so the caller can fall back to a
 * disabled state with a clear error message instead of waiting for
 * Copilot CLI to fail mysteriously.
 */
export async function probeDreamgraphStdio(opts: {
  command: string;
  args?: readonly string[];
  timeoutMs?: number;
}): Promise<{ readonly toolCount: number }> {
  const args = opts.args ?? DEFAULT_DREAMGRAPH_ARGS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TOOL_LIST_TIMEOUT_MS;
  // Reuse the registry by constructing it with throwaway disk paths.
  // We only call `listAuthoritativeToolNames`, so the bridge fields
  // are inert.
  const probe = createHostRegistry({
    dreamgraphCommand: opts.command,
    dreamgraphArgs: args,
    bridgeEntryPath: "<unused>",
    nodeExecPath: process.execPath,
    auditDirAbsPath: process.cwd(),
    toolListTimeoutMs: timeoutMs,
  });
  const tools = await probe.listAuthoritativeToolNames();
  // Touch `spawn` so the bundler keeps the import (defensive: this
  // module imports child_process for symmetry with the bridge spawn,
  // but we do not currently call it directly here).
  void spawn;
  return Object.freeze({ toolCount: tools.length });
}

function validate(opts: HostRegistryOptions): void {
  if (!opts || typeof opts !== "object") {
    throw new Error("createHostRegistry: opts is required");
  }
  for (const key of [
    "dreamgraphCommand",
    "bridgeEntryPath",
    "nodeExecPath",
    "auditDirAbsPath",
  ] as const) {
    const v = opts[key];
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`createHostRegistry: opts.${key} is required (non-empty string)`);
    }
  }
  if (
    opts.toolListTimeoutMs !== undefined &&
    (!Number.isFinite(opts.toolListTimeoutMs) || opts.toolListTimeoutMs <= 0)
  ) {
    throw new Error("createHostRegistry: opts.toolListTimeoutMs must be a positive finite number");
  }
}
