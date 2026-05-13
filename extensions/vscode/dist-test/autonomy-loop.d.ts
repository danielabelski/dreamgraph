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
export interface PassAnalysisResult {
    signal: PassOutcomeSignal;
    actionSet: RecommendedActionSet;
    selectedActionId?: string;
    decision: ContinuationDecision;
    nextPrompt?: string;
    /** Sticky flag carried into the next pass: once the architect has a
     * concrete patch anchor (write tool ran, file edited, or next-step bound
     * to a write tool), pure-read passes after this point count as
     * non-progress. Persisted via advanceAutonomyStateIfContinued. */
    patchAnchorEstablished?: boolean;
}
export declare function inferPassOutcomeSignal(content: string | undefined): PassOutcomeSignal;
export declare function buildContinuationPrompt(selectedAction?: RecommendedAction): string;
export declare function analyzePass(state: AutonomyState, input: PassAnalysisInput): PassAnalysisResult;
export declare function advanceAutonomyStateIfContinued(state: AutonomyState, decision: ContinuationDecision, signal?: PassOutcomeSignal, patchAnchorEstablished?: boolean): AutonomyState;
//# sourceMappingURL=autonomy-loop.d.ts.map