import type { ArchitectLlm } from "../../../architect-llm.js";
import type { ProviderPort } from "../../ports.js";
import { type CopilotCliDeps, type CopilotCliRunResult } from "./orchestrator.js";
import type { CopilotCliMcpAuditLivePort, RecordedMcpToolCall } from "./orchestrator-ports.js";
import { type CliToolsManifest } from "./prompt-serializer.js";
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
export declare function createCopilotCliProviderPort(options: CopilotCliProviderPortOptions): ProviderPort;
//# sourceMappingURL=provider-port.d.ts.map