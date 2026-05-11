/**
 * DreamGraph Context Inspector — Layer 1 (VS Code Integration).
 *
 * Provides an Output Channel ("DreamGraph Context") that shows the current
 * EditorContextEnvelope for debugging and transparency.
 *
 * Also manages the "DreamGraph: Instance Status" output channel for the
 * showStatus command.
 *
 * @see TDD §3.6 (Context Inspector), §2.6.1 (showStatus)
 */
import * as vscode from "vscode";
import type { EditorContextEnvelope, HealthState, ResolvedInstance } from "./types.js";
export declare class ContextInspector implements vscode.Disposable {
    private readonly _contextChannel;
    private readonly _statusChannel;
    constructor();
    logContextRequestBoundary(event: {
        instanceId?: string;
        intentMode?: string;
    }): void;
    /**
     * Log a context envelope to the output channel.
     */
    logEnvelope(envelope: EditorContextEnvelope): void;
    logReasoningPacket(packet: import("./types.js").ReasoningPacket): void;
    logTimeoutDiagnostics(event: {
        provider: string;
        model?: string;
        mode: 'stream' | 'tool';
        timeoutMs: number;
        recoveryAttempted: boolean;
        recovered: boolean;
        toolCount?: number;
        usedReducedContext?: boolean;
        errorMessage: string;
    }): void;
    /**
     * Show and focus the context output channel.
     */
    showContextChannel(): void;
    clearContextChannel(): void;
    /**
     * Append a one-off informational line to the DreamGraph Context channel.
     * Used for ad-hoc diagnostics like tool-selection rationale.
     */
    appendContextLine(line: string): void;
    /**
     * Log a structured LLM request-budget summary to the DreamGraph Context channel.
     * Called from the architect-llm budget guard before every outbound LLM call.
     */
    logRequestBudget(summary: {
        callsite: string;
        model: string;
        inputChars: number;
        approxTokens: number;
        sections: Array<{
            name: string;
            chars: number;
            approxTokens: number;
        }>;
        warn?: boolean;
    }): void;
    /**
     * Format and display full instance status in the status output channel.
     */
    showInstanceStatus(instance: ResolvedInstance | null, health: HealthState): void;
    /**
     * Show raw text output in the context channel (used for Architect responses
     * when the chat panel is not visible).
     */
    showRawOutput(text: string): void;
    private _formatCounts;
    dispose(): void;
}
//# sourceMappingURL=context-inspector.d.ts.map