import type { Blocker, ContinuationNeed, VerificationKind } from "../autonomy/index.js";
import type { VerificationEvidence } from "../execution/index.js";
import type { CapabilityId } from "../capabilities/index.js";
export type { VerificationKind } from "../autonomy/index.js";
/** Reason a verification step is required for a particular capability invocation. */
export type VerificationReason = "mutation_compile_check" | "mutation_behavior_check" | "graph_invariant_check" | "markdown_structure_check" | "user_marked_mutating";
/** A single verification the harness wants performed before completion. */
export interface VerificationStep {
    readonly kind: VerificationKind;
    readonly reason: VerificationReason;
    /** The Slice-6 capability that performs this verification. */
    readonly performedBy: CapabilityId;
}
/** Output of `planVerifications` for one source-capability invocation. */
export interface VerificationPlan {
    readonly sourceCapability: CapabilityId;
    readonly steps: readonly VerificationStep[];
}
/**
 * Discriminated union of completion statuses. `assertNeverStatus` enforces
 * exhaustiveness across the harness.
 */
export type CompletionStatus = {
    readonly kind: "completed";
    readonly evidence: readonly VerificationEvidence[];
} | {
    readonly kind: "completed_no_verification_needed";
} | {
    readonly kind: "repair_recommended";
    readonly failedSteps: readonly VerificationStep[];
    readonly continuation: ContinuationNeed;
} | {
    readonly kind: "blocked";
    readonly blocker: Blocker;
} | {
    readonly kind: "failed_verification";
    readonly reason: "verification_unavailable";
    readonly missingKinds: readonly VerificationKind[];
} | {
    readonly kind: "mutation_failed";
    readonly reason: "mutation_failed";
    readonly description: string;
};
export declare function assertNeverStatus(s: never): never;
/** Per-task counters; pure derivation from outcomes (Slice 7 plan §5). */
export interface CompletionMetrics {
    readonly verificationsAttempted: number;
    readonly verificationsPassed: number;
    readonly verificationsFailed: number;
    readonly verificationsUnavailable: number;
    readonly repairAttemptsByKind: Readonly<Record<VerificationKind, number>>;
    readonly enrichmentTasksQueued: number;
    readonly enrichmentTasksDrained: number;
    readonly graphOnlyCapabilitiesSkipped: number;
    readonly finalStatus: CompletionStatus["kind"];
}
//# sourceMappingURL=types.d.ts.map