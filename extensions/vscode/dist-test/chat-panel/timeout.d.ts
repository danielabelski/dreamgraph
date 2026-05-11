/**
 * Pure timeout / recovery helpers extracted from chat-panel.ts.
 *
 * These are stateless utilities — no `this`, no I/O, no dependencies on the
 * VS Code extension host. They cover:
 *   - per-provider request budgets ({@link getLlmTimeoutMs})
 *   - timeout-error sniffing ({@link isTimeoutError})
 *   - recovery prompt construction ({@link buildTimeoutRecoveryPrompt})
 *   - the AbortSignal helper that wires a request-level timeout into a
 *     parent abort controller ({@link createTimeoutAbortSignal})
 *
 * The high-level orchestration (streaming the recovery turn, persisting the
 * recovered message) stays in chat-panel.ts because it touches webview state.
 *
 * Part of F-06 sub-batch 3b/3 (chat-panel.ts split).
 */
/** Hard timeout per LLM provider request (ms). Prevents infinite hangs. */
export declare const REQUEST_TIMEOUT_MS = 90000;
export type LlmTimeoutMode = 'stream' | 'tool';
export interface LlmTimeoutOptions {
    mode: LlmTimeoutMode;
    /** Optional provider key. Defaults to 'anthropic' when omitted. */
    provider?: string;
    /** When set and > 12, an extra 30s is added. */
    toolCount?: number;
    /** When true, the budget is reduced (used for the recovery retry). */
    reducedContext?: boolean;
}
/**
 * Compute the per-request LLM timeout budget for the given mode + provider.
 *
 * Identical math to the previous `ChatPanel._getLlmTimeoutMs` but pure: the
 * provider is passed in instead of being read from `this.architectLlm`.
 */
export declare function getLlmTimeoutMs(options: LlmTimeoutOptions): number;
/** True when the error message looks like an LLM request timeout. */
export declare function isTimeoutError(err: unknown): boolean;
/**
 * Build the recovery prompt that the agent retries with after a timeout.
 *
 * The string format is part of the contract — do not change without updating
 * the matching test in `extensions/vscode/src/test/timeout-recovery.test.ts`.
 */
export declare function buildTimeoutRecoveryPrompt(originalText: string): string;
export interface TimeoutAbortHandle {
    signal: AbortSignal;
    /** MUST be called when the request completes — clears the timer + listener. */
    dispose: () => void;
}
/**
 * Create a child AbortSignal that aborts on EITHER:
 *   - the parent signal aborting (user clicked Stop), OR
 *   - the timeout firing.
 *
 * The returned `dispose()` clears the timer and detaches the parent listener
 * so the controller can be GC'd promptly. Always call it in a `finally` block.
 *
 * Pure with respect to chat-panel state: the parent abort controller is
 * passed in instead of read from `this.abortController`.
 */
export declare function createTimeoutAbortSignal(parent: AbortController | null | undefined, timeoutMs?: number): TimeoutAbortHandle;
//# sourceMappingURL=timeout.d.ts.map