import { type CodexArgvPlan, type CodexCliErrorCode, type CodexCliProviderId, type CodexCliTranscript, type CodexHelpSurface, type CodexMcpConfigArtifact, type ToolCallClass } from "./types.js";
import type { CodexCliClockPort, CodexCliCryptoPort, CodexCliFsPort, CodexCliMcpAuditPort, CodexCliProcessPort, CodexCliRegistryPort, CodexCliSpawnResult, RecordedMcpToolCall } from "./orchestrator-ports.js";
export interface CodexCliRunInput {
    readonly prompt: string;
    readonly invocationCwd: string;
    readonly timeoutMs: number;
    readonly idleTimeoutMs?: number;
    readonly model?: string;
    readonly profile?: string;
    readonly configOverrides?: readonly {
        readonly key: string;
        readonly value: string | number | boolean;
    }[];
    readonly baseEnv: Readonly<Record<string, string | undefined>>;
    readonly binaryName?: string;
    readonly abortSignal?: AbortSignal;
    readonly onRunIdAssigned?: (runId: string) => void;
    readonly onStdoutChunk?: (chunk: string) => void;
    readonly onStderrChunk?: (chunk: string) => void;
}
export interface CodexCliDeps {
    readonly fs: CodexCliFsPort;
    readonly process: CodexCliProcessPort;
    readonly crypto: CodexCliCryptoPort;
    readonly clock: CodexCliClockPort;
    readonly registry: CodexCliRegistryPort;
    readonly mcpAudit: CodexCliMcpAuditPort;
}
export interface ClassifiedToolCall {
    readonly call: RecordedMcpToolCall;
    readonly classification: ToolCallClass;
}
export interface CodexCliRecoveryAction {
    readonly kind: "codex-login";
    readonly label: "Run codex login";
    readonly command: "codex login";
}
export interface CodexCliFailure {
    readonly code: CodexCliErrorCode;
    readonly message: string;
    readonly preSpawn: boolean;
    readonly cause: "missing-binary" | "unsupported-help" | "not-logged-in" | "mcp-load-failed" | "registry-mismatch" | "user-cancelled" | "wall-timeout" | "idle-timeout" | "spawn-error" | "process-signal" | "nonzero-exit";
    readonly recoveryAction?: CodexCliRecoveryAction;
}
export interface CodexCliRunResult {
    readonly provider: CodexCliProviderId;
    readonly runId: string;
    readonly startedAtEpochMs: number;
    readonly endedAtEpochMs: number;
    readonly totalDurationMs: number;
    readonly ok: boolean;
    readonly failure?: CodexCliFailure;
    readonly helpSurface?: CodexHelpSurface;
    readonly argvPlan?: CodexArgvPlan;
    readonly mcpConfig?: CodexMcpConfigArtifact;
    readonly spawn?: CodexCliSpawnResult;
    readonly transcript?: CodexCliTranscript;
    readonly toolCalls: readonly ClassifiedToolCall[];
}
export declare function runCodexCli(input: CodexCliRunInput, deps: CodexCliDeps): Promise<CodexCliRunResult>;
//# sourceMappingURL=orchestrator.d.ts.map