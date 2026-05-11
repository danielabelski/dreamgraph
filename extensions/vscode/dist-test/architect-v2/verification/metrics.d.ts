import type { ToolOutcome } from "../execution/index.js";
import type { CapabilityPlan } from "../capabilities/index.js";
import type { VerificationKind } from "../autonomy/index.js";
import type { CompletionMetrics, CompletionStatus, VerificationPlan } from "./types.js";
export interface ComputeMetricsInput {
    /** All tool outcomes produced this pass (mutations + verifications). */
    readonly outcomes: readonly ToolOutcome[];
    /** Slice-6 plans chosen this pass (for sparse-mode / gap counters). */
    readonly capabilityPlans: readonly CapabilityPlan[];
    /** Slice-7 verification plans produced this pass. */
    readonly verificationPlans: readonly VerificationPlan[];
    /** The final per-mutation classifications produced by classifyCompletion. */
    readonly classifications: readonly CompletionStatus[];
    /** Carry-over repair counters from prior passes on the same task. */
    readonly priorRepairAttemptsByKind: Readonly<Record<VerificationKind, number>>;
    /** Number of EnrichmentTasks the orchestrator drained this pass. */
    readonly enrichmentTasksDrained: number;
}
/**
 * Pure metrics derivation. Same input -> same `CompletionMetrics`. Used
 * by cards (Slice 5) and the orchestrator for end-of-pass reporting.
 */
export declare function computeMetrics(input: ComputeMetricsInput): CompletionMetrics;
//# sourceMappingURL=metrics.d.ts.map