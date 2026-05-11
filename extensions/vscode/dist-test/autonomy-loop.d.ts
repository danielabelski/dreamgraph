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
}
export interface PassAnalysisResult {
    signal: PassOutcomeSignal;
    actionSet: RecommendedActionSet;
    selectedActionId?: string;
    decision: ContinuationDecision;
    nextPrompt?: string;
}
export declare function inferPassOutcomeSignal(content: string | undefined): PassOutcomeSignal;
export declare function buildContinuationPrompt(selectedAction?: RecommendedAction): string;
export declare function analyzePass(state: AutonomyState, input: PassAnalysisInput): PassAnalysisResult;
export declare function advanceAutonomyStateIfContinued(state: AutonomyState, decision: ContinuationDecision, signal?: PassOutcomeSignal): AutonomyState;
//# sourceMappingURL=autonomy-loop.d.ts.map