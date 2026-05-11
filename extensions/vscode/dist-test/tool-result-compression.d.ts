/**
 * Phase 4 of NEVER_FAIL_BUDGET_DEBT_PLAN — multi-tier tool-result compression.
 *
 * Replaces the previous opt-in `truncateToolResult` hard char cap with a
 * pressure-aware policy driven by the per-turn `BudgetCoordinator`. The
 * coordinator owns all pressure decisions (Plan §4.0); this module only
 * reads `getPressure()` / `getRemainingTargetTokens()` and reports back via
 * `recordCompression(...)`.
 *
 * Policy (Plan §4.3):
 *  - pressure ≤ 0           → verbatim
 *  - 0 < pressure ≤ 0.5     → mild head/tail trim, only if content > expected slice
 *  - pressure > 0.5         → aggressive head/tail trim
 *  - server-side oversized envelopes (already self-marked with a truncation
 *    marker) are passed through verbatim — their pivot hint is more valuable
 *    than the raw bytes.
 *
 * Never refuses, never throws.
 */
/**
 * Compression mode names match those defined in `budget-coordinator.ts` so the
 * coordinator's compression history stays type-aligned end-to-end.
 */
export type CompressionMode = 'verbatim' | 'expected' | 'debt-repay' | 'envelope-preserved';
/**
 * Minimal duck-typed coordinator contract for the tool-result layer. The
 * full `BudgetCoordinator` satisfies this; tests can supply a stub.
 */
export interface ToolCompressionCoordinator {
    getPressure(): number;
    getRemainingTargetTokens?(): number;
    recordCompression?(component: string, originalTokens: number, finalTokens: number, mode: CompressionMode): void;
}
export interface CompressToolResultOptions {
    /**
     * Per-tool slice budget in tokens. Defaults to 4 000 (~ ¼ of a 16 k turn).
     * The mild tier kicks in only when content exceeds this slice.
     */
    expectedSliceTokens?: number;
}
export interface CompressToolResultResult {
    content: string;
    originalChars: number;
    finalChars: number;
    mode: CompressionMode;
}
/**
 * Phase 4 entry point. Replaces `truncateToolResult(content, limit)`.
 */
export declare function compressToolResult(content: string, coordinator: ToolCompressionCoordinator, toolName: string, options?: CompressToolResultOptions): CompressToolResultResult;
//# sourceMappingURL=tool-result-compression.d.ts.map