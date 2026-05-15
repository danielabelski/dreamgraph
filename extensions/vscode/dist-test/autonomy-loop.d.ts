import { type AutonomyState, type ContinuationDecision, type PassOutcomeSignal, type RecommendedAction, type RecommendedActionSet } from './autonomy.js';
import type { StructuredPassEnvelope } from './autonomy-structured.js';
export interface PassAnalysisInput {
    /** Assistant text from the pass. May be undefined when the model emitted
     * only tool calls or when the response was aborted. */
    content: string | undefined;
    actions?: RecommendedAction[];
    /** Structured envelope parsed from the LLM response. When present its fields
     * are authoritative over prose-regex-derived equivalents. */
    envelope?: StructuredPassEnvelope;
    /** Number of tool calls the model issued during this pass. Used by the
     * empty-pass detector to break out of counter-spam loops. */
    toolCallCount?: number;
    /** Number of files actually edited/created during this pass. */
    fileEditCount?: number;
    /** Names of every tool invoked this pass (in call order). Used to detect
     * "pure read" passes that should count as non-progress once a patch
     * anchor has already been established. */
    toolNames?: string[];
}
export declare function isReadOnlyTool(toolName: string): boolean;
/**
 * Extract concrete file paths the architect named on the same line as an
 * edit verb. Empty array means no prose anchor was detected. The result is
 * deduplicated, lower-cased only for paths that look case-insensitive (we
 * preserve original casing in the returned set so equality comparison across
 * passes is exact). Order is the order of first occurrence.
 */
export declare function extractProseAnchorPaths(content: string | undefined): string[];
declare function setEqualsPaths(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean;
export { setEqualsPaths };
export interface PassAnalysisResult {
    signal: PassOutcomeSignal;
    actionSet: RecommendedActionSet;
    selectedActionId?: string;
    decision: ContinuationDecision;
    nextPrompt?: string;
    /** Sticky flag carried into the next pass: once the architect has a
     * concrete patch anchor (write tool ran, file edited, next-step bound
     * to a write tool, or a prose anchor — concrete file path co-occurring
     * with an edit verb in the assistant text), pure-read passes after
     * this point count as non-progress. Persisted via
     * advanceAutonomyStateIfContinued. */
    patchAnchorEstablished?: boolean;
    /** Concrete file paths the architect named on the same line as an edit
     * verb during this pass. Empty when no prose anchor was detected.
     * Persisted into AutonomyState.lastAnchorPaths and compared by the
     * two-strike token-economy stop rule to distinguish legitimate
     * re-anchoring (anchor moved → continue) from waste (same anchor twice
     * with no writes → stop). */
    anchorPaths?: readonly string[];
    /** True when this pass executed only read tool calls and made no file
     * edits. Persisted into AutonomyState.lastPassWasLocateOnly so the
     * next pass's two-strike rule can compare locate-only history. */
    isLocateOnlyThisPass?: boolean;
}
export declare function inferPassOutcomeSignal(content: string | undefined): PassOutcomeSignal;
/**
 * Options for the continuation prompt builder.
 *
 * `patchAnchorEstablished` is the sticky autonomy-state flag carried into the
 * about-to-start pass. When true, the model has already named a concrete patch
 * site in a prior pass; the prompt grows a hard "do NOT re-locate" line so the
 * next pass writes or stops, rather than re-reading the same files.
 */
export interface ContinuationPromptOptions {
    readonly patchAnchorEstablished?: boolean;
}
export declare function buildContinuationPrompt(selectedAction?: RecommendedAction, options?: ContinuationPromptOptions): string;
export declare function analyzePass(state: AutonomyState, input: PassAnalysisInput): PassAnalysisResult;
export declare function advanceAutonomyStateIfContinued(state: AutonomyState, decision: ContinuationDecision, signal?: PassOutcomeSignal, patchAnchorEstablished?: boolean, anchorPaths?: readonly string[], isLocateOnlyThisPass?: boolean): AutonomyState;
//# sourceMappingURL=autonomy-loop.d.ts.map