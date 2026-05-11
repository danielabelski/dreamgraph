import type { CapabilityInventory } from "./capability";
import { type ActionCandidate, type DecisionResult, type RankedActions } from "./signals";
import type { PassRecord, TaskState } from "./task";
/**
 * (Preserved concept from v1 `rankRecommendedActions` — but reduced. v1
 * sorted by `priority` field with mutex/batch logic; v2 sorts by self-reported
 * `confidence` descending, ties broken by label. Eligibility filtering is
 * caller's responsibility (see `filterByCapability`).)
 */
export declare function rankActions(candidates: readonly ActionCandidate[]): RankedActions;
export declare function filterByCapability(candidates: readonly ActionCandidate[], inventory: CapabilityInventory): ActionCandidate[];
/**
 * No-progress = the last two passes ended with the same artifact-snapshot
 * fingerprint. Replaces v1's `consecutiveEmptyPasses` heuristic with an
 * observation grounded in actual artifact state.
 */
export declare function detectNoProgress(passes: readonly PassRecord[]): {
    noProgress: boolean;
    passesWithoutDelta: number;
};
/**
 * Builds a continuation prompt that embeds the selected action's exact tool
 * name plus a brief mention of considered alternatives. The tool-name embed
 * is the ADR-154 invariant; `createContinuationNeed()` re-checks it as a
 * defense in depth.
 */
export declare function buildContinuationPrompt(top: ActionCandidate, alternatives: readonly ActionCandidate[]): string;
export interface DeriveNextActionInput {
    readonly taskState: TaskState;
    readonly inventory: CapabilityInventory;
    readonly candidates: readonly ActionCandidate[];
    readonly nowEpochMs: number;
}
export declare function deriveNextAction(input: DeriveNextActionInput): DecisionResult;
//# sourceMappingURL=decision.d.ts.map