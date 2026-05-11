/**
 * Pure helper functions extracted from chat-panel.ts.
 *
 * These are stateless utilities — no `this`, no I/O, no side effects beyond
 * what their inputs declare. Kept here so chat-panel.ts can stay focused on
 * webview lifecycle, streaming orchestration, and message persistence, and so
 * the helpers can be unit-tested directly without instantiating ChatPanel.
 *
 * Part of F-06 sub-batch 3b/3 (chat-panel.ts split). See
 * plans/SYSTEM_FINDINGS.md for the rationale and scope.
 */
import type { SemanticAnchor } from '../types.js';
export declare const MAX_RENDERED_MESSAGE_CHARS = 100000;
export declare const MAX_ENTITY_LINKS_PER_MESSAGE = 100;
/** Patterns used to redact secrets from any model-visible text or chunk. */
export declare const SECRET_PATTERNS: readonly RegExp[];
export interface ImplicitEntityDetectionResult {
    names: string[];
    truncated: boolean;
}
export interface VerdictBanner {
    level: 'verified' | 'partial' | 'speculative';
    summary: string;
}
export interface ToolTraceEntry {
    tool: string;
    argsSummary: string;
    filesAffected: string[];
    durationMs: number;
    status: 'completed' | 'failed';
}
export declare function summarizeToolArgs(input: unknown): string;
export declare function stringifyToolResult(result: unknown): string;
export declare function safeStringifyForOutcome(result: unknown): string;
/**
 * Derive a one-line summary for an OutcomeCard subtitle. Prefers a top-level
 * `summary`/`message`/`status` field on the parsed payload, falls back to a
 * single-line snippet of the payload text. Always returns at most 200 chars
 * with no embedded newlines so it is safe to splat onto the fence header.
 */
export declare function summarizeOutcomePayload(payloadText: string): string;
export declare function deriveVerdict(content: string | undefined, trace: ToolTraceEntry[]): VerdictBanner;
/**
 * Extract file paths referenced by tool inputs (or, if none, results).
 *
 * Two-arity signature kept compatible with the previous private method:
 * `extractFilesAffected(input, result?)` or
 * `extractFilesAffected(toolName, input, result?)` (toolName is ignored).
 */
export declare function extractFilesAffected(toolNameOrInput: unknown, inputOrResult?: unknown, maybeResult?: string): string[];
export declare function detectImplicitEntities(content: string, maxLinks?: number): ImplicitEntityDetectionResult;
export declare function formatImplicitEntityNotice(result: ImplicitEntityDetectionResult): string;
export declare function redactSecrets(content: string): string;
/**
 * Strip the structured autonomy envelope (a ```json``` fenced block containing
 * `goal_status`) so it never renders in chat. The envelope is consumed by the
 * autonomy loop instead.
 */
export declare function stripStructuredEnvelope(content: string): string;
/**
 * Format a stop-context block for injection into the next turn's system
 * prompt, so that "resume" re-enters from a known task position rather than
 * starting fresh.
 */
export declare function formatStopContextBlock(ctx: {
    summary?: string;
    nextSteps: Array<{
        label: string;
        rationale?: string;
    }>;
}): string;
export declare function formatAnchorFooterStatus(anchor: SemanticAnchor): string;
export declare function createMessageId(): string;
export declare function applyRenderLimits(content: string, maxChars?: number): {
    content: string;
    truncated: boolean;
};
/** Per-tool MCP-call timeouts (ms). Tools not listed use _default. */
export declare const TOOL_TIMEOUT_MS: Record<string, number>;
export declare function toolTimeoutMs(toolName: string): number;
//# sourceMappingURL=helpers.d.ts.map