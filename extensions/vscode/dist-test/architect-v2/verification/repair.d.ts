import type { Blocker, ContinuationNeed, VerificationKind } from "../autonomy/index.js";
import type { VerificationStep } from "./types.js";
export declare const DEFAULT_REPAIR_BUDGET_PER_KIND = 1;
export interface AutonomyBudgetView {
    /** Continuations the orchestrator may still issue this task. */
    readonly continuationsRemaining: number;
}
export type RepairDecision = {
    readonly kind: "repair_with_continuation";
    readonly failedStep: VerificationStep;
    readonly continuation: ContinuationNeed;
} | {
    readonly kind: "escalate_to_blocker";
    readonly failedStep: VerificationStep;
    readonly blocker: Blocker;
} | {
    readonly kind: "skip_repair";
    readonly failedStep: VerificationStep;
    readonly reason: "non_actionable";
};
export interface PlanRepairInput {
    readonly failedStep: VerificationStep;
    readonly repairAttemptsByKind: Readonly<Record<VerificationKind, number>>;
    readonly autonomyBudget: AutonomyBudgetView;
    /**
     * Caller marks failures it considers non-actionable (flaky tests,
     * external infra blips). Defaults to false.
     */
    readonly nonActionable?: boolean;
    /** Per-kind override; falls back to DEFAULT_REPAIR_BUDGET_PER_KIND. */
    readonly maxAttemptsPerKind?: number;
}
/**
 * Pure repair planner. Same input -> same RepairDecision.
 *
 * The continuation prompt embeds the verification tool name verbatim, as
 * required by ADR-154 (the `createContinuationNeed` constructor enforces).
 */
export declare function planRepair(input: PlanRepairInput): RepairDecision;
//# sourceMappingURL=repair.d.ts.map