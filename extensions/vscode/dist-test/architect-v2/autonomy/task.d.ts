import type { PassBudget, TimeBudget } from "./budget";
import type { ModeProfile, AutonomyMode } from "./modes";
import type { Blocker, VerificationFailure } from "./signals";
/**
 * Minimal lifecycle states. The decision engine only reads `status`; it does
 * not transition it. Status transitions are owned by the orchestrator
 * (later slice) acting on `DecisionResult`.
 */
export type TaskStatus = "running" | "paused_for_user" | "stopped";
/**
 * Snapshot of an artifact at a point in time. Used by the no-progress
 * detector: two consecutive `PassRecord`s whose `endingArtifacts` hash
 * the same way means the pass produced no observable change, regardless of
 * whether tools were called or text was generated.
 *
 * (Replaces v1 `consecutiveEmptyPasses` heuristic per Slice 3 directive 3.D —
 * artifact deltas are explicit and auditable; "did the model say anything?"
 * is not.)
 */
export interface ArtifactSnapshot {
    readonly kind: "file" | "mcp_entity" | "verification";
    readonly id: string;
    /** Opaque content fingerprint. Comparison is equality-only. */
    readonly hash: string;
    readonly observedAtEpochMs: number;
}
/**
 * Per-pass record. Built by the orchestrator at the END of each pass and
 * appended to `TaskState.passes`. The decision engine reads only the most
 * recent one or two records.
 */
export interface PassRecord {
    readonly index: number;
    readonly startedAtEpochMs: number;
    readonly finishedAtEpochMs: number;
    /** Action that this pass attempted, if any. */
    readonly actionAttemptedId?: string;
    /** Free-form one-line summary of what changed. UI only. */
    readonly deltaSummary: string;
    /** Snapshot of the artifacts the pass touched, end-of-pass. */
    readonly endingArtifacts: ArtifactSnapshot[];
    /** True if a verification step ran on this pass. */
    readonly hadVerification: boolean;
    /** Populated only if the verification step on this pass FAILED. */
    readonly verificationFailure?: VerificationFailure;
    /** True if the pass concluded the task's goal is sufficiently reached. */
    readonly goalReached: boolean;
}
/**
 * The full state the decision engine consumes. Treated as immutable by
 * `deriveNextAction()`; the orchestrator constructs the next `TaskState`
 * after each pass.
 */
export interface TaskState {
    readonly id: string;
    readonly goal: string;
    readonly mode: AutonomyMode;
    readonly profile: ModeProfile;
    readonly passBudget: PassBudget;
    readonly timeBudget: TimeBudget;
    /** Append-only history. Most recent pass is the last element. */
    readonly passes: readonly PassRecord[];
    /** Blockers accumulated across the run, NOT cleared between passes. */
    readonly blockers: readonly Blocker[];
    readonly status: TaskStatus;
}
//# sourceMappingURL=task.d.ts.map