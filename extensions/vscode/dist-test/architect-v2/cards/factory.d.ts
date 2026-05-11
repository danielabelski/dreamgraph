import { type BlockerCard, type CompletionCard, type ContextCard, type DecisionCard, type EditCard, type FallbackCard, type GoalCard, type NextStepCard, type OutcomeCard, type PlanCard, type PlanStep, type VerificationCard, type ArtifactRef, type ContinuationNeed, type ExecutionPlan, type FallbackJustification, type ToolOutcome, type VerificationEvidence } from './types.js';
import { type ComputePillsInput, type PillSet } from './pills.js';
export interface CardCommon {
    readonly id: string;
    readonly taskId: string;
    readonly nowEpochMs: number;
    readonly parentCardId?: string;
    readonly pills: PillSet;
}
export declare function createGoalCard(c: CardCommon, body: GoalCard['body']): GoalCard;
export declare function createPlanCard(c: CardCommon, steps: readonly PlanStep[]): PlanCard;
export declare function createContextCard(c: CardCommon, body: {
    sources: readonly ArtifactRef[];
    summary: string;
}): ContextCard;
export declare function createDecisionCard(c: CardCommon, body: DecisionCard['body']): DecisionCard;
export declare function createEditCard(c: CardCommon, body: {
    artifacts: readonly ArtifactRef[];
    diffSummary: string;
}): EditCard;
export declare function createVerificationCard(c: CardCommon, evidence: VerificationEvidence): VerificationCard;
export declare function createBlockerCard(c: CardCommon, body: BlockerCard['body']): BlockerCard;
export declare function createCompletionCard(c: CardCommon, body: {
    summary: string;
    artifacts: readonly ArtifactRef[];
}): CompletionCard;
/**
 * `next-step` card embeds the `ContinuationNeed` verbatim — toolName, args,
 * and reason are preserved (Slice 3 ADR-154 invariant).
 */
export declare function createNextStepCard(c: CardCommon, continuation: ContinuationNeed): NextStepCard;
/**
 * Fallback card — derives `pills.fallbackReason` from the justification so
 * renderers never see a null reason on a fallback card.
 */
export declare function createFallbackCard(c: Omit<CardCommon, 'pills'>, pillsInput: Omit<ComputePillsInput, 'plan'>, plan: ExecutionPlan, justification: FallbackJustification): FallbackCard;
/**
 * Outcome card — derives `pills.tier` and `pills.verificationStatus` from the
 * outcome so callers don't have to plumb both.
 */
export declare function createOutcomeCard(c: Omit<CardCommon, 'pills'>, pillsInput: Omit<ComputePillsInput, 'outcome' | 'evidence'>, outcome: ToolOutcome): OutcomeCard;
//# sourceMappingURL=factory.d.ts.map