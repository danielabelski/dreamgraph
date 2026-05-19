// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — live tail of the per-run MCP audit NDJSON.
//
// Sibling to `audit-adapter.ts`: where that file does ONE batch read
// at `finishRecording`, this file watches the same file for appends
// while the bridge is still writing and emits each new
// `RecordedMcpToolCall` to a handler in append order.
//
// Used purely for UX (the chat-panel status strip ticks per tool call
// instead of waiting for the run to finish). The post-run batch read
// remains the authoritative source of truth — see the
// `CopilotCliMcpAuditLivePort` doc-comment in `orchestrator-ports.ts`.
//
// Hard rules respected:
//   - Bounded memory: we never buffer more than one partial trailing
//     line per subscription.
//   - Idempotent close: second `close()` resolves immediately.
//   - Crash containment: watcher errors and handler exceptions are
//     logged and swallowed. The UX channel must never fail the run.
//   - Per-call truncation: `resultJson` payloads larger than
//     `MAX_LIVE_RESULT_JSON_BYTES` are truncated for the live channel
//     only (the batch reader still gets the full payload).
//   - Windows-friendly tail: `fs.watch` events are unreliable when the
//     bridge holds the file in append mode. A `setInterval` heartbeat
//     (default 250 ms) re-stats the file and drains any missed bytes.

import { open, stat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";

import type {
  CopilotCliMcpAuditLivePort,
  CopilotCliMcpAuditLiveSubscription,
  RecordedMcpToolCall,
} from "../orchestrator-ports.js";

import { auditFilePathFor, parseRecordOrNull } from "./audit-adapter.js";

/** Live `resultJson` size cap. Post-run batch is unaffected. */
export const MAX_LIVE_RESULT_JSON_BYTES = 4 * 1024;

/** Default heartbeat interval. See class doc on Windows reliability. */
const DEFAULT_HEARTBEAT_MS = 250;

export interface HostAuditLiveOptions {
  /** Same dir the orchestrator passes to {@link createHostAudit}. */
  readonly auditDirAbsPath: string;
  /**
   * Stat-heartbeat interval in ms. Defaults to 250. Exposed for
   * profiling only — production callers should rely on the default.
   * Values <= 0 disable the heartbeat (fs.watch only).
   */
  readonly heartbeatMs?: number;
}

export function createHostAuditLive(opts: HostAuditLiveOptions): CopilotCliMcpAuditLivePort {
  if (!opts || typeof opts.auditDirAbsPath !== "string" || opts.auditDirAbsPath.length === 0) {
    throw new Error("createHostAuditLive: auditDirAbsPath is required");
  }
  const heartbeatMs =
    typeof opts.heartbeatMs === "number" && Number.isFinite(opts.heartbeatMs)
      ? opts.heartbeatMs
      : DEFAULT_HEARTBEAT_MS;

  return Object.freeze({
    async subscribe(
      runId: string,
      handler: (call: RecordedMcpToolCall) => void,
    ): Promise<CopilotCliMcpAuditLiveSubscription> {
      if (!runId || runId.length === 0) {
        throw new Error("subscribe: runId is required");
      }
      if (typeof handler !== "function") {
        throw new Error("subscribe: handler is required");
      }
      const path = auditFilePathFor(opts.auditDirAbsPath, runId);
      return startTail({ path, handler, heartbeatMs });
    },
  });
}

interface TailContext {
  readonly path: string;
  readonly handler: (call: RecordedMcpToolCall) => void;
  readonly heartbeatMs: number;
}

async function startTail(ctx: TailContext): Promise<CopilotCliMcpAuditLiveSubscription> {
  let offset = 0;
  let carry = "";
  let closed = false;
  let watcher: FSWatcher | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let draining = false;
  let pendingDrain = false;
  const handler = ctx.handler;

  /**
   * Drain newly-appended bytes from `offset` to EOF. Re-entrancy safe:
   * if a drain is in flight when a new fs.watch event arrives, the
   * arrival is coalesced into one follow-up pass.
   */
  const drain = async (): Promise<void> => {
    if (closed) return;
    if (draining) {
      pendingDrain = true;
      return;
    }
    draining = true;
    try {
      do {
        pendingDrain = false;
        let st;
        try {
          st = await stat(ctx.path);
        } catch {
          // File doesn't exist yet — bridge hasn't started writing.
          // Heartbeat / fs.watch will fire again when it does.
          continue;
        }
        if (st.size < offset) {
          // File was truncated or replaced. Reset and re-read from 0.
          offset = 0;
          carry = "";
        }
        if (st.size === offset) continue;
        const length = st.size - offset;
        let fh;
        try {
          fh = await open(ctx.path, "r");
        } catch {
          continue;
        }
        try {
          const buf = Buffer.alloc(length);
          const { bytesRead } = await fh.read(buf, 0, length, offset);
          offset += bytesRead;
          const chunk = buf.subarray(0, bytesRead).toString("utf8");
          const combined = carry + chunk;
          const lines = combined.split(/\r?\n/);
          // Last element is the partial trailing line (possibly "").
          carry = lines.pop() ?? "";
          for (const raw of lines) {
            if (closed) return;
            const line = raw.trim();
            if (line.length === 0) continue;
            const parsed = parseRecordOrNull(line);
            if (parsed === null) {
              // eslint-disable-next-line no-console
              console.warn(
                `[copilot-cli audit-live] skipped malformed record at ${ctx.path}`,
              );
              continue;
            }
            const truncated = truncateForLive(parsed);
            try {
              handler(truncated);
            } catch (err) {
              // eslint-disable-next-line no-console
              console.warn(
                "[copilot-cli audit-live] handler threw; subsequent events will still deliver:",
                err instanceof Error ? err.message : String(err),
              );
            }
          }
        } finally {
          await fh.close().catch(() => undefined);
        }
      } while (pendingDrain && !closed);
    } finally {
      draining = false;
    }
  };

  // Initial catch-up: replay any records the bridge wrote between
  // `startRecording` and `subscribe`.
  await drain();

  // Arm fs.watch on the parent directory. Watching the file directly
  // is unreliable on Windows when the bridge holds it in append mode.
  if (!closed) {
    try {
      // Watching the file is generally fine on Linux/macOS; on Windows
      // the directory-level watch is more reliable, but for the audit
      // dir we already have one file per runId so a file-level watch
      // works on all platforms when supplemented by the heartbeat.
      watcher = watch(ctx.path, { persistent: false }, () => {
        void drain();
      });
      watcher.on("error", (err) => {
        // eslint-disable-next-line no-console
        console.warn(
          "[copilot-cli audit-live] watcher error (heartbeat will take over):",
          err instanceof Error ? err.message : String(err),
        );
      });
    } catch {
      // File doesn't exist yet → fall back to heartbeat-only until it
      // appears, then we'll arm the watcher lazily on the next drain.
    }
  }

  if (!closed && ctx.heartbeatMs > 0) {
    heartbeat = setInterval(() => {
      // If the watcher couldn't arm (file missing), try again now.
      if (watcher === null) {
        try {
          watcher = watch(ctx.path, { persistent: false }, () => {
            void drain();
          });
          watcher.on("error", () => undefined);
        } catch {
          /* still no file — keep heartbeating */
        }
      }
      void drain();
    }, ctx.heartbeatMs);
    // Don't keep the event loop alive purely for a UX tail.
    if (typeof heartbeat.unref === "function") heartbeat.unref();
  }

  return Object.freeze({
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      if (watcher) {
        try {
          watcher.close();
        } catch {
          /* ignore */
        }
        watcher = null;
      }
      // Best-effort final drain so the user sees any last-second calls.
      await drain().catch(() => undefined);
    },
  });
}

function truncateForLive(call: RecordedMcpToolCall): RecordedMcpToolCall {
  if (call.resultJson.length <= MAX_LIVE_RESULT_JSON_BYTES) return call;
  const head = call.resultJson.slice(0, MAX_LIVE_RESULT_JSON_BYTES);
  const truncatedJson = JSON.stringify({
    truncated: true,
    truncatedAtBytes: MAX_LIVE_RESULT_JSON_BYTES,
    originalBytes: call.resultJson.length,
    head,
  });
  return Object.freeze({
    server: call.server,
    tool: call.tool,
    inputJson: call.inputJson,
    resultJson: truncatedJson,
    isError: call.isError,
    durationMs: call.durationMs,
    startedAtEpochMs: call.startedAtEpochMs,
  });
}
