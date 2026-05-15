import { type CopilotArgvPlan, type CopilotCliErrorCode, type CopilotCliProviderId, type CopilotHelpSurface, type CopilotMcpConfigArtifact, type ToolCallClass } from "./types.js";
import { type CopilotCliTranscript } from "./transcript.js";
import { type CopilotCliClockPort, type CopilotCliCryptoPort, type CopilotCliFsPort, type CopilotCliMcpAuditPort, type CopilotCliProcessPort, type CopilotCliRegistryPort, type CopilotCliSpawnResult, type RecordedMcpToolCall } from "./orchestrator-ports.js";
export interface CopilotCliRunInput {
    /**
     * The user-visible prompt the model will see. The orchestrator passes
     * this through `--prompt` verbatim; it MUST be pre-composed by the
     * caller (no implicit context, no implicit framing).
     */
    readonly prompt: string;
    /**
     * Optional model selector. Forwarded as `--model <model>` when set.
     * The orchestrator does not validate the value (versions evolve).
     */
    readonly model?: string;
    /**
     * Working directory for the spawned CLI. The orchestrator never
     * creates files here — only `COPILOT_HOME` receives writes.
     */
    readonly invocationCwd: string;
    /**
     * Hard wall-clock cap. Required (no implicit infinite runs).
     */
    readonly timeoutMs: number;
    /**
     * Optional cancellation signal forwarded to the spawn port.
     */
    readonly abortSignal?: AbortSignal;
    /**
     * Live stdout chunk listener. Forwarded to the spawn port unchanged.
     */
    readonly onStdoutChunk?: (chunk: string) => void;
    /**
     * Live stderr chunk listener. Forwarded to the spawn port unchanged.
     */
    readonly onStderrChunk?: (chunk: string) => void;
    /**
     * Base process environment to inherit (typically `process.env` from
     * the host). The orchestrator copies it untouched into the spawned
     * CLI's environment so the user's persistent `COPILOT_HOME` (and
     * therefore their GitHub auth tokens) flows through unchanged. The
     * adapter NEVER overrides `COPILOT_HOME` — doing so would discard
     * the auth tokens the CLI needs for its non-interactive `--prompt`
     * mode and silently exit non-zero with no output.
     */
    readonly baseEnv: Readonly<Record<string, string | undefined>>;
    /**
     * Override the binary name. Defaults to `"copilot"`. Useful in tests
     * and when packagers ship a renamed binary.
     */
    readonly binaryName?: string;
}
export interface CopilotCliDeps {
    readonly fs: CopilotCliFsPort;
    readonly process: CopilotCliProcessPort;
    readonly crypto: CopilotCliCryptoPort;
    readonly clock: CopilotCliClockPort;
    readonly registry: CopilotCliRegistryPort;
    readonly mcpAudit: CopilotCliMcpAuditPort;
}
export interface ClassifiedToolCall {
    readonly call: RecordedMcpToolCall;
    readonly classification: ToolCallClass;
}
export interface CopilotCliFailure {
    readonly code: CopilotCliErrorCode;
    readonly message: string;
    /** True when no spawn occurred (failure happened during validation). */
    readonly preSpawn: boolean;
}
export interface CopilotCliRunResult {
    /** Stable provider identifier. */
    readonly provider: CopilotCliProviderId;
    /** Run identifier minted by the crypto port. */
    readonly runId: string;
    /** Wall-clock start (epoch ms) measured by the clock port. */
    readonly startedAtEpochMs: number;
    /** Wall-clock end (epoch ms) measured by the clock port. */
    readonly endedAtEpochMs: number;
    /** Total wall-clock duration in ms (`endedAtEpochMs - startedAtEpochMs`). */
    readonly totalDurationMs: number;
    /**
     * `true` when the spawn returned exit code 0 AND validation passed.
     * `false` for any pre-spawn failure or non-zero exit.
     */
    readonly ok: boolean;
    /**
     * Populated only when `ok === false`. The orchestrator writes a
     * single failure descriptor; iteration is the caller's responsibility.
     */
    readonly failure?: CopilotCliFailure;
    /** Help-surface snapshot used for the run (when reached). */
    readonly helpSurface?: CopilotHelpSurface;
    /** Argv plan that was actually passed to spawn (when reached). */
    readonly argvPlan?: CopilotArgvPlan;
    /** MCP config artifact written to `COPILOT_HOME` (when reached). */
    readonly mcpConfig?: CopilotMcpConfigArtifact;
    /** Spawn outcome (when reached). */
    readonly spawn?: CopilotCliSpawnResult;
    /** Normalized transcript (when reached). */
    readonly transcript?: CopilotCliTranscript;
    /** Classified MCP tool calls observed during the run. */
    readonly toolCalls: readonly ClassifiedToolCall[];
}
export declare function runCopilotCli(input: CopilotCliRunInput, deps: CopilotCliDeps): Promise<CopilotCliRunResult>;
//# sourceMappingURL=orchestrator.d.ts.map