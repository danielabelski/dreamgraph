// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — `ProviderPort` wrapper (Slice 4).
//
// `createCopilotCliProviderPort` plugs the Slice 2 orchestrator into
// the architect-core `ProviderPort` seam so the chat-panel pass driver
// can route a turn to the Copilot CLI surface without knowing anything
// about `child_process`, `--prompt`, or run directories.
//
// Wire shape:
//
//   pass.ts → ports.provider.callProvider(input)
//        ↓
//     serialize `input.prompt.conversation` to a single prompt string
//        ↓
//     runCopilotCli({ prompt, model, invocationCwd, timeoutMs, … }, deps)
//        ↓
//     project `CopilotCliRunResult` → `ProviderProposal`
//
// IMPORTANT design choices:
//
//  * The CLI surface executes its own tools in-process via the
//    DreamGraph stdio MCP bridge. By the time `runCopilotCli` returns,
//    every tool call the model wanted to make has already happened. We
//    therefore set `proposal.toolCalls = []` and `stopReason = "end_turn"`
//    — there are no pending `ToolUseRequest`s for the pass driver to
//    dispatch. The classified tool-call audit lives on the
//    `CopilotCliRunResult` and is surfaced via the `onRunResult` hook.
//
//  * `ProviderPort.llm` is a non-optional reference to an `ArchitectLlm`
//    instance (escape hatch for adapters). Per the binding rule against
//    empty stubs, we do NOT fabricate one. The factory takes the host's
//    existing `ArchitectLlm` reference as a dependency and exposes it
//    verbatim. The pass driver itself does not consume `port.llm`.
//
//  * Failures from the orchestrator are surfaced as thrown `Error`s
//    annotated with the Copilot-CLI failure code. The pass driver
//    treats provider errors as recoverable and surfaces them to the
//    chat panel; this matches v1 `ArchitectLlm` behavior.
//
//  * `getCapabilities()` exposes text and image attachments. The host
//    normalizes them into the CLI conversation payload before this
//    adapter serializes the prompt.
//
//  * `onStreamChunk`, when supplied, receives the full assistant text
//    once at the end of the run. The CLI does not stream tokens to
//    stdout the way the OpenAI / Anthropic streaming endpoints do;
//    forwarding raw stdout chunks would leak ANSI escapes and partial
//    UI-control bytes into the chat bubble. We deliver the cleaned
//    transcript as a single chunk so the renderer behavior remains
//    provider-agnostic.

import type { ArchitectLlm, ArchitectToolResponse } from "../../../architect-llm.js";
import type {
  CallProviderInput,
  ProviderPort,
} from "../../ports.js";
import type { ProviderProposal } from "../../types.js";

import {
  runCopilotCli,
  type ClassifiedToolCall,
  type CopilotCliDeps,
  type CopilotCliRunResult,
} from "./orchestrator.js";
import { buildAuthoritativeAllowlist } from "./allowlist.js";
import { COPILOT_NATIVE_COMMAND_TOOLS } from "./types.js";
import type {
  CliJsonEvent,
  CliJsonToolStartEvent,
} from "./event-stream.js";
import type {
  CopilotCliMcpAuditLivePort,
  CopilotCliMcpAuditLiveSubscription,
  RecordedMcpToolCall,
} from "./orchestrator-ports.js";
import {
  serializeConversationForCopilotCli,
  type CliToolsManifest,
} from "./prompt-serializer.js";

/**
 * Tool names the model sometimes hallucinates from training memory
 * of older Copilot CLI builds. The current CLI does not expose any
 * of these — calls fail in milliseconds with "tool not found". They
 * carry no signal worth surfacing to the chat trace or verdict, so
 * the provider-port drops their failed-completion events. Compared
 * lowercase, against the resolved tool name (no `cli:` prefix).
 */
const PHANTOM_CLI_SHELL_TOOLS: ReadonlySet<string> = new Set([
  "powershell",
  "pwsh",
  "bash",
  "cmd",
  "zsh",
  "sh",
  "exec",
  "run",
]);

export interface CopilotCliProviderPortOptions {
  /**
   * Reference to the host's `ArchitectLlm`. Exposed verbatim through
   * `port.llm` to satisfy the architect-core port contract. Not used
   * for any wire calls; the CLI surface owns its own model selection.
   */
  readonly hostLlm: ArchitectLlm;
  /**
   * Working directory passed to every `runCopilotCli` invocation.
   * Typically the workspace root; the orchestrator never writes here.
   */
  readonly invocationCwd: string;
  /**
   * Hard wall-clock cap per turn, in milliseconds. Required (no
   * implicit infinite runs).
   */
  readonly timeoutMs: number;
  /**
   * Optional idle-output cap per turn, in milliseconds. When > 0,
   * the run is killed if no stdout/stderr chunk has been observed
   * for this long; each chunk (tool event, assistant delta, etc.)
   * resets the window. Lets a long pass with many sequential tool
   * calls keep running past `timeoutMs` as long as it is still
   * producing output. Omit / 0 disables idle-based termination.
   */
  readonly idleTimeoutMs?: number;
  /**
   * Base process environment. Forwarded to the orchestrator, which
   * overlays `COPILOT_HOME` and the per-run MCP token without
   * mutating the input map.
   */
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  /**
   * Optional model selector forwarded as `--model <model>` when set.
   */
  readonly model?: string;
  /**
   * Optional override of the binary name. Defaults to `"copilot"`.
   * Useful in tests and when packagers ship a renamed binary.
   */
  readonly binaryName?: string;
  /**
   * Effectful ports the orchestrator depends on. Production code
   * supplies `HOST_FS`, `HOST_PROCESS`, `HOST_CRYPTO`, `HOST_CLOCK`
   * plus `createHostRegistry` / `createHostAudit`. Tests inject fakes.
   */
  readonly deps: CopilotCliDeps;
  /**
   * Observer hook invoked once per provider call with the full
   * `CopilotCliRunResult`. The chat panel uses this to mirror tool-
   * call audit entries into its tool-trace channel and to surface
   * diagnostics. The provider port itself never inspects the result
   * past projecting the `ProviderProposal`.
   */
  readonly onRunResult?: (result: CopilotCliRunResult) => void;
  /**
   * Optional live audit port. When supplied alongside `onToolCall`,
   * the provider-port subscribes to the per-run audit NDJSON tail as
   * soon as the orchestrator mints a run id, forwarding each raw
   * `RecordedMcpToolCall` to `onToolCall`. Subscription is torn down
   * unconditionally after the run completes (success or failure).
   * `onRunResult` remains the authoritative reconciliation point.
   */
  readonly auditLive?: CopilotCliMcpAuditLivePort;
  /**
   * Per-call hook invoked with the raw `RecordedMcpToolCall` parsed
   * from the audit tail. Receives the `runId` so the chat panel can
   * key its dedup map. Handler exceptions are swallowed.
   */
  readonly onToolCall?: (runId: string, call: RecordedMcpToolCall) => void;
  /**
   * Maximum number of NON-system messages forwarded to the CLI's
   * single-shot prompt file. Older non-system turns are dropped
   * (system messages always retained). Single-shot CLI runs read
   * the full conversation as one prompt, so long histories increase
   * the chance the model picks up a stale `[user]` block; cap is
   * the cheapest mitigation.
   */
  readonly historyKeepLast?: number;
  /**
   * When true (recommended for CLI runs) the final user turn in the
   * serialized prompt is wrapped with `CURRENT TURN` markers so the
   * model cannot mistake an older `[user]` block for the active
   * request. Default `true`.
   */
  readonly markCurrentTurn?: boolean;
  /**
   * MCP server + tools to advertise inside the system block of the
   * serialized prompt, with a directive telling the model to prefer
   * those tools over its inline native tools for repo/graph queries.
   * Omit to keep the system block untouched.
   */
  readonly cliToolsManifest?: CliToolsManifest;
  /**
   * Observer invoked once per turn with diagnostics suitable for the
   * chat panel's context-inspector channel. Surfaces the byte size
   * of the serialized prompt, the number of MCP tools advertised,
   * and whether the prompt overflowed to a file-redirect directive.
   * Handler exceptions are swallowed.
   */
  readonly onPromptComposed?: (info: PromptComposedInfo) => void;
  /**
   * Optional observer invoked with one-line human-readable
   * diagnostics extracted from the CLI's stdout JSON stream. Used
   * to surface MCP server load status, session.tools_updated
   * payloads, and other `session.*` / `mcp.*` events into the chat
   * panel's context-inspector channel so misconfigurations
   * (e.g. dreamgraph MCP server failed to spawn inside the CLI)
   * become visible without an ad-hoc debug toggle. Handler
   * exceptions are swallowed.
   */
  readonly onCliDiagnostic?: (line: string) => void;
}

export interface PromptComposedInfo {
  readonly promptByteLength: number;
  readonly historyMessageCount: number;
  readonly mcpToolsAdvertised: number;
  readonly mcpServerAdvertised: string | null;
  readonly markCurrentTurn: boolean;
  readonly model: string | null;
}

function validateOptions(opts: CopilotCliProviderPortOptions): void {
  if (!opts || typeof opts !== "object") {
    throw new Error("createCopilotCliProviderPort: options object is required");
  }
  if (!opts.hostLlm) {
    throw new Error("createCopilotCliProviderPort: hostLlm reference is required");
  }
  if (typeof opts.invocationCwd !== "string" || opts.invocationCwd.length === 0) {
    throw new Error("createCopilotCliProviderPort: invocationCwd must be a non-empty string");
  }
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new Error("createCopilotCliProviderPort: timeoutMs must be a positive finite number");
  }
  if (!opts.baseEnv || typeof opts.baseEnv !== "object") {
    throw new Error("createCopilotCliProviderPort: baseEnv object is required");
  }
  if (!opts.deps || typeof opts.deps !== "object") {
    throw new Error("createCopilotCliProviderPort: deps object is required");
  }
}

function buildFailureError(result: CopilotCliRunResult): Error {
  const failure = result.failure;
  const code = failure?.code ?? "COPILOT_CLI_UNKNOWN_FAILURE";
  const message = failure?.message ?? "Copilot CLI run failed without a failure descriptor";
  const err = new Error(`[${code}] ${message}`);
  (err as Error & { copilotCliFailureCode?: string }).copilotCliFailureCode = code;
  (err as Error & { copilotCliRunResult?: CopilotCliRunResult }).copilotCliRunResult = result;
  return err;
}

function projectProposal(
  result: CopilotCliRunResult,
  classifiedCalls: readonly ClassifiedToolCall[],
): ProviderProposal {
  const transcript = result.transcript;
  const content = transcript ? transcript.assistantText : "";
  const startedAt = result.startedAtEpochMs;
  const endedAt = result.endedAtEpochMs;
  const durationMs = endedAt - startedAt;

  const response: ArchitectToolResponse = {
    content,
    promptTokens: 0,
    completionTokens: 0,
    durationMs: durationMs > 0 ? durationMs : 0,
    toolCalls: [],
    stopReason: "end_turn",
  };

  // The proposal carries no pending tool calls — the CLI executed all
  // of them in-process. Surface the audit through `onRunResult`.
  void classifiedCalls;

  return Object.freeze({
    response,
    toolCalls: Object.freeze([]) as readonly never[],
  });
}

async function resolveLiveToolsManifest(
  options: CopilotCliProviderPortOptions,
): Promise<CliToolsManifest> {
  const manifest = options.cliToolsManifest;
  if (!manifest) {
    throw new Error("resolveLiveToolsManifest: cliToolsManifest is required");
  }
  const liveToolNames = await options.deps.registry.listAuthoritativeToolNames();
  const allowlist = buildAuthoritativeAllowlist(liveToolNames);
  const live = new Set(allowlist.tools);
  // `run_command` is served by the Copilot bridge, not the upstream daemon;
  // keep it visible in the prompt manifest even when the daemon tool list is read-only.
  live.add("run_command");
  return {
    server: manifest.server,
    tools: Object.freeze(manifest.tools.filter((tool) => live.has(tool))),
    nativeCommandTools: Object.freeze([...COPILOT_NATIVE_COMMAND_TOOLS]),
  };
}

export function createCopilotCliProviderPort(
  options: CopilotCliProviderPortOptions,
): ProviderPort {
  validateOptions(options);

  return Object.freeze({
    llm: options.hostLlm,

    getCapabilities(): { readonly textAttachments: boolean; readonly imageAttachments: boolean } {
      return Object.freeze({ textAttachments: true, imageAttachments: true });
    },

    async callProvider(input: CallProviderInput): Promise<ProviderProposal> {
      const cliToolsManifest = options.cliToolsManifest
        ? await resolveLiveToolsManifest(options)
        : undefined;
      const promptText = serializeConversationForCopilotCli(input.prompt.conversation, {
        ...(options.historyKeepLast !== undefined
          ? { historyKeepLast: options.historyKeepLast }
          : {}),
        markCurrentTurn: options.markCurrentTurn ?? true,
        ...(cliToolsManifest ? { cliToolsManifest } : {}),
      });
      if (options.onPromptComposed) {
        try {
          options.onPromptComposed({
            promptByteLength: Buffer.byteLength(promptText, "utf8"),
            historyMessageCount: input.prompt.conversation.length,
            mcpToolsAdvertised: cliToolsManifest?.tools.length ?? 0,
            mcpServerAdvertised: cliToolsManifest?.server ?? null,
            markCurrentTurn: options.markCurrentTurn ?? true,
            model: options.model ?? null,
          });
        } catch {
          // observer failures must not break the run
        }
      }

      const liveEnabled = Boolean(options.auditLive && options.onToolCall);
      const subHolder: { current: CopilotCliMcpAuditLiveSubscription | null } = { current: null };

      const onRunIdAssigned = liveEnabled
        ? (runId: string): void => {
            // Fire-and-forget: subscribe asynchronously; orchestrator
            // does not await this. Errors are swallowed so a broken
            // live tail can never break the run itself.
            const live = options.auditLive!;
            const handler = options.onToolCall!;
            void live
              .subscribe(runId, (call) => {
                try {
                  handler(runId, call);
                } catch {
                  // handler failures must not break the live tail
                }
              })
              .then((sub) => {
                subHolder.current = sub;
              })
              .catch(() => {
                // subscription failures degrade silently to post-run reconciliation
              });
          }
        : undefined;

      // --------------------------------------------------------------
      // Stdout JSON event handler — AUTHORITATIVE live UX source.
      //
      // Pairs `tool.execution_start` with the matching
      // `tool.execution_complete` (keyed by `toolCallId`) and
      // synthesizes a `RecordedMcpToolCall` for the host's existing
      // `onToolCall(runId, call)` wire. CLI-native tools (no
      // `mcpServerName`) are labelled with the synthetic server
      // `"cli"` so the chat-panel displays them as e.g.
      // `cli:powershell`; real MCP calls retain their explicit
      // `mcpServerName` / `mcpToolName` so e.g.
      // `dreamgraph:query_resource` round-trips verbatim.
      //
      // `assistant.message_delta.deltaContent` is forwarded to
      // `input.onStreamChunk` for real per-token streaming. When
      // any deltas were forwarded the final "full transcript as one
      // chunk" fallback at the end of this method is suppressed to
      // avoid double-rendering the same message body.
      // --------------------------------------------------------------
      const startsByCallId = new Map<string, CliJsonToolStartEvent>();
      let activeRunId: string | null = null;
      let deltasStreamed = false;
      // Track the assistant `messageId` currently being streamed so we
      // can prepend a paragraph break when the model rolls to a new
      // message within the same turn (mirrors the same boundary
      // handling in `event-stream.ts.snapshotAssistantText`). Without
      // this the live chat bubble shows run-on prose like
      // "...contents.The prompt is larger..." when the CLI emits each
      // "thought" as a distinct message.
      let lastStreamedMessageId: string | null = null;
      // When the CLI reports the dreamgraph MCP server failed to load
      // we abort the run via this internal controller. Continuing
      // would let the model answer repo questions with zero graph
      // grounding (manifests as hallucinated ADR numbers, fabricated
      // file paths, etc.) which is a hard authority violation:
      // dreamgraph is the authoritative context source for this
      // surface.
      let mcpFailureReason: string | null = null;
      const internalAbort = new AbortController();
      const externalSignal = input.abortSignal;
      if (externalSignal) {
        if (externalSignal.aborted) internalAbort.abort();
        else externalSignal.addEventListener("abort", () => internalAbort.abort(), { once: true });
      }
      const composedOnRunIdAssigned = (runId: string): void => {
        activeRunId = runId;
        if (onRunIdAssigned) onRunIdAssigned(runId);
      };
      const onCliEvent = (event: CliJsonEvent): void => {
        // After abort, drop every CLI event silently. The child is
        // being killed by the process adapter; any tool-call or
        // assistant-delta the host still emits while it dies must
        // not be surfaced to the chat panel (would render as a
        // ghost reply after the user pressed stop) or to the tool
        // trace (would record activity past the cancellation point).
        if (internalAbort.signal.aborted) return;
        if (event.type === "tool.execution_start") {
          startsByCallId.set(event.toolCallId, event);
          return;
        }
        if (event.type === "tool.execution_complete") {
          const start = startsByCallId.get(event.toolCallId);
          startsByCallId.delete(event.toolCallId);
          if (!options.onToolCall || activeRunId === null) return;
          const startedAtEpochMs = start ? safeParseTimestamp(start.timestamp) : Date.now();
          const endedAtEpochMs = safeParseTimestamp(event.timestamp);
          const durationMs = Math.max(0, endedAtEpochMs - startedAtEpochMs);
          const server = start?.mcpServerName ?? "cli";
          // Prefer the start event's `toolName` because some CLI
          // versions omit it on the complete event (the pairing key
          // is `toolCallId`, not the name). Falls back to the
          // complete event's name and finally to "unknown" so the
          // chat trace never renders an empty `cli:` label.
          const tool = start?.mcpToolName ?? start?.toolName ?? event.toolName ?? "unknown";
          // Drop phantom CLI shell-tool failures. The model
          // sometimes hallucinates tool names like `powershell`,
          // `bash`, `cmd`, `pwsh`, etc. from its training memory of
          // older Copilot CLI builds. Current CLI rejects them in
          // milliseconds (no such tool). They never produced useful
          // output, the model has already seen the failure in its
          // own message history, and forwarding them only pollutes
          // the chat trace and verdict ("N tool calls failed").
          if (
            !event.success &&
            start?.mcpServerName == null &&
            PHANTOM_CLI_SHELL_TOOLS.has(tool.toLowerCase())
          ) {
            return;
          }
          const call: RecordedMcpToolCall = {
            server,
            tool,
            inputJson: safeJsonStringify(start?.arguments ?? null),
            resultJson: safeJsonStringify(event.result ?? null),
            isError: !event.success,
            durationMs,
            startedAtEpochMs,
          };
          try {
            options.onToolCall(activeRunId, call);
          } catch {
            // handler exceptions must not break the spawn
          }
          return;
        }
        if (event.type === "assistant.message_delta" && input.onStreamChunk) {
          try {
            const mid = event.messageId ?? null;
            let chunk = event.deltaContent;
            if (
              lastStreamedMessageId !== null &&
              mid !== null &&
              mid !== lastStreamedMessageId
            ) {
              chunk = `\n\n${chunk}`;
            }
            lastStreamedMessageId = mid;
            input.onStreamChunk(chunk);
            deltasStreamed = true;
          } catch {
            // observer failures must not break the spawn
          }
          return;
        }
        if (event.type === "_other" && options.onCliDiagnostic) {
          // Forward `session.*` / `mcp.*` envelopes verbatim so the
          // context inspector can show whether the CLI loaded our
          // dreamgraph MCP server, what tool set it surfaced to the
          // model, and any per-session warnings.
          const raw = event.rawType;
          if (raw.startsWith("session.") || raw.startsWith("mcp.")) {
            try {
              options.onCliDiagnostic(
                `[copilot-cli] ${raw}: ${safeJsonStringify(event.data ?? null)}`,
              );
            } catch {
              // observer failures must not break the spawn
            }
          }
        }
        // Fail-fast on dreamgraph MCP load failure. Inspect both
        // shapes the CLI emits: a per-server status change and the
        // aggregate `mcp_servers_loaded` snapshot. We only react to
        // the dreamgraph server — other MCP servers failing is the
        // user's call to make (e.g. optional github-mcp).
        if (event.type === "_other" && mcpFailureReason === null) {
          const raw = event.rawType;
          const data = event.data as Record<string, unknown> | undefined;
          if (raw === "session.mcp_server_status_changed" && data) {
            const name = typeof data["serverName"] === "string" ? (data["serverName"] as string) : "";
            const status = typeof data["status"] === "string" ? (data["status"] as string) : "";
            if (name === "dreamgraph" && status === "failed") {
              const err = typeof data["error"] === "string" ? (data["error"] as string) : "unknown error";
              mcpFailureReason = err;
              internalAbort.abort();
            }
          } else if (raw === "session.mcp_servers_loaded" && data) {
            const servers = Array.isArray(data["servers"]) ? (data["servers"] as Array<Record<string, unknown>>) : [];
            const dg = servers.find((s) => s && s["name"] === "dreamgraph");
            if (dg && dg["status"] === "failed") {
              const err = typeof dg["error"] === "string" ? (dg["error"] as string) : "unknown error";
              mcpFailureReason = err;
              internalAbort.abort();
            }
          }
        }
      };

      let result: CopilotCliRunResult;
      try {
        result = await runCopilotCli(
          {
            prompt: promptText,
            model: options.model,
            invocationCwd: options.invocationCwd,
            timeoutMs: options.timeoutMs,
            ...(typeof options.idleTimeoutMs === "number" && options.idleTimeoutMs > 0
              ? { idleTimeoutMs: options.idleTimeoutMs }
              : {}),
            abortSignal: internalAbort.signal,
            baseEnv: options.baseEnv,
            binaryName: options.binaryName,
            onRunIdAssigned: composedOnRunIdAssigned,
            onCliEvent,
            // Note: stdout/stderr chunk listeners are intentionally NOT
            // forwarded. The CLI's JSON output is consumed structurally
            // via `onCliEvent`; raw stdout would only leak NDJSON
            // envelopes into the chat bubble.
          },
          options.deps,
        );
      } finally {
        const sub = subHolder.current;
        if (sub) {
          try {
            await sub.close();
          } catch {
            // teardown failures must not propagate
          }
        }
      }

      if (options.onRunResult) {
        try {
          options.onRunResult(result);
        } catch {
          // Observer failures must not crash the pass driver.
        }
      }

      // Authoritative-mode invariant: the dreamgraph MCP server MUST
      // be reachable inside the CLI for grounded answers. If the CLI
      // emitted a `mcp_servers_loaded` (or per-server status_changed)
      // event marking dreamgraph as failed we aborted the run above
      // — surface a specific error so the chat panel doesn't render
      // a hallucinated half-answer.
      if (mcpFailureReason !== null) {
        const err = new Error(
          "[COPILOT_CLI_DREAMGRAPH_MCP_FAILED] Copilot CLI could not load the dreamgraph MCP server: " +
            mcpFailureReason +
            ". The run was aborted because graph-grounded answers are not possible without it. Common cause: the dreamgraph daemon the extension is connected to became unreachable, or the bridge could not reach the architect's MCP endpoint. Open the DreamGraph status bar to confirm the daemon is running.",
        );
        (err as Error & { copilotCliFailureCode?: string }).copilotCliFailureCode =
          "COPILOT_CLI_DREAMGRAPH_MCP_FAILED";
        throw err;
      }

      // User cancellation takes precedence over any other failure.
      // Throw a typed AbortError so the pass driver / chat panel can
      // distinguish "user pressed stop" from "Copilot CLI exited
      // non-zero" and skip ordinary result normalization.
      //
      // Attribution: prefer the EXTERNAL signal's reason (set by the
      // chat-panel: either the user clicking Stop, or the wrapper
      // watchdog timing out). The internal `result.failure?.code ===
      // "CANCELLED"` path covers spawn-side aborts that never carried
      // an external reason (rare; mostly host-driven teardown).
      if (internalAbort.signal.aborted || (!result.ok && result.failure?.code === "CANCELLED")) {
        const externalAborted = externalSignal?.aborted === true;
        const externalReason = externalSignal?.reason;
        let humanMessage: string;
        let code: string;
        if (externalAborted) {
          const reasonText =
            externalReason instanceof Error
              ? externalReason.message
              : typeof externalReason === "string"
                ? externalReason
                : "";
          if (/timed out|timeout/i.test(reasonText)) {
            humanMessage = `Copilot CLI run aborted by the chat-panel watchdog (${reasonText}). The model did not finish before the wrapper's wall-clock budget expired.`;
            code = "CHAT_WRAPPER_TIMEOUT";
          } else {
            humanMessage = "Copilot CLI run cancelled by user.";
            code = "USER_CANCELLED";
          }
        } else if (!result.ok && result.failure?.code === "CANCELLED") {
          humanMessage = `Copilot CLI run cancelled by the orchestrator: ${result.failure.message}`;
          code = "HOST_ABORTED";
        } else {
          humanMessage = "Copilot CLI run cancelled (cause unknown).";
          code = "CANCELLED";
        }
        const cancelErr = new Error(humanMessage) as Error & {
          name: string;
          copilotCliFailureCode?: string;
        };
        cancelErr.name = "AbortError";
        cancelErr.copilotCliFailureCode = code;
        throw cancelErr;
      }

      if (!result.ok) {
        throw buildFailureError(result);
      }

      const proposal = projectProposal(result, result.toolCalls);

      // Only emit the full-transcript chunk when NO per-token deltas
      // were streamed AND the run was not cancelled. With
      // `--output-format json` the deltas cover the entire message;
      // emitting again would duplicate it in the chat bubble.
      if (
        !deltasStreamed &&
        !internalAbort.signal.aborted &&
        input.onStreamChunk &&
        proposal.response.content.length > 0
      ) {
        input.onStreamChunk(proposal.response.content);
      }

      return proposal;
    },
  });
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "null";
  }
}

function safeParseTimestamp(ts: string): number {
  if (typeof ts !== "string" || ts.length === 0) return Date.now();
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : Date.now();
}
