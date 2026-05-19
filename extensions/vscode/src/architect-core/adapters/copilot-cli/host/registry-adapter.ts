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
//      and return the names. The orchestrator uses this to verify
//      `COPILOT_REQUIRED_AUTHORITATIVE_TOOLS` is satisfied BEFORE
//      spawning Copilot CLI. Probing the SAME endpoint the bridge
//      will forward to means a green probe is a real guarantee, not
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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type {
  CopilotCliRegistryPort,
  CopilotMcpBridgeSpawn,
} from "../orchestrator-ports.js";
import { auditFilePathFor } from "./audit-adapter.js";

export interface HostRegistryOptions {
  /**
   * Full URL of the architect's already-open DreamGraph MCP endpoint
   * (e.g. `http://127.0.0.1:7321/mcp`). This MUST be the same URL the
   * extension's long-running `McpClient` is connected to, so probes
   * and bridge forwards see the SAME daemon session the rest of the
   * extension operates against.
   */
  readonly hostMcpUrl: string;
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
   * already overlays `DREAMGRAPH_RUN_ID` and the resolved audit path
   * on top of whatever is returned from `describeBridgeSpawn`.
   */
  readonly extraBridgeEnv?: Readonly<Record<string, string>>;
  /**
   * Hard timeout (ms) for the one-shot `tools/list` probe. Defaults to
   * 15 s — generous enough for a slow round-trip while keeping the
   * orchestrator startup bounded.
   */
  readonly toolListTimeoutMs?: number;
}

// The daemon answers `tools/list` over already-warm HTTP, so the
// probe budget can be tight. We pick 15 s as a safe ceiling that
// still bounds startup if the daemon is paging in from cold cache.
const DEFAULT_TOOL_LIST_TIMEOUT_MS = 15_000;

export function createHostRegistry(opts: HostRegistryOptions): CopilotCliRegistryPort {
  validate(opts);
  const toolListTimeoutMs = opts.toolListTimeoutMs ?? DEFAULT_TOOL_LIST_TIMEOUT_MS;
  const hostMcpUrl = opts.hostMcpUrl;

  return Object.freeze({
    async listAuthoritativeToolNames(): Promise<readonly string[]> {
      return Object.freeze(
        await probeHostMcpToolNames({ url: hostMcpUrl, timeoutMs: toolListTimeoutMs }),
      );
    },

    async describeBridgeSpawn(): Promise<CopilotMcpBridgeSpawn> {
      const env: Record<string, string> = {
        ...(opts.extraBridgeEnv ?? {}),
        // The single piece of state the bridge needs to inherit
        // the architect's MCP session. Everything else (audit
        // path, server name) is layered on by the orchestrator
        // per-run via `bridgeEnvForRun`.
        DREAMGRAPH_HOST_MCP_URL: hostMcpUrl,
        DREAMGRAPH_BRIDGE_AUDIT_DIR: opts.auditDirAbsPath,
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
 * Liveness probe used by host wiring to verify the architect's
 * DreamGraph MCP endpoint is actually serving requests before the
 * orchestrator begins a run. Throws on failure so the caller can
 * fall back to a disabled state with a clear error message instead
 * of waiting for Copilot CLI to fail mysteriously.
 */
export async function probeDreamgraphHttpMcp(opts: {
  url: string;
  timeoutMs?: number;
}): Promise<{ readonly toolCount: number }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TOOL_LIST_TIMEOUT_MS;
  const names = await probeHostMcpToolNames({ url: opts.url, timeoutMs });
  return Object.freeze({ toolCount: names.length });
}

async function probeHostMcpToolNames(opts: {
  url: string;
  timeoutMs: number;
}): Promise<string[]> {
  let url: URL;
  try {
    url = new URL(opts.url);
  } catch (err) {
    throw new Error(
      `probeHostMcpToolNames: invalid URL ${opts.url}: ${(err as Error).message}`,
    );
  }

  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client(
    { name: "dreamgraph-copilot-cli-registry-probe", version: "1.0.0" },
    { capabilities: {} },
  );

  const timeoutHandle: { id: NodeJS.Timeout | null } = { id: null };
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle.id = setTimeout(() => {
      reject(
        new Error(
          `probeHostMcpToolNames: ${opts.url} tools/list probe exceeded ${opts.timeoutMs}ms`,
        ),
      );
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
}

function validate(opts: HostRegistryOptions): void {
  if (!opts || typeof opts !== "object") {
    throw new Error("createHostRegistry: opts is required");
  }
  for (const key of [
    "hostMcpUrl",
    "bridgeEntryPath",
    "nodeExecPath",
    "auditDirAbsPath",
  ] as const) {
    const v = opts[key];
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`createHostRegistry: opts.${key} is required (non-empty string)`);
    }
  }
  try {
    // Throws on malformed URL. Catch -> rethrow with a clearer
    // message so the caller knows which arg is wrong.
    void new URL(opts.hostMcpUrl);
  } catch (err) {
    throw new Error(
      `createHostRegistry: opts.hostMcpUrl must be a valid URL (got ${JSON.stringify(opts.hostMcpUrl)}): ${(err as Error).message}`,
    );
  }
  if (
    opts.toolListTimeoutMs !== undefined &&
    (!Number.isFinite(opts.toolListTimeoutMs) || opts.toolListTimeoutMs <= 0)
  ) {
    throw new Error("createHostRegistry: opts.toolListTimeoutMs must be a positive finite number");
  }
}
