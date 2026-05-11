import type { CapabilityId } from "../capabilities/index.js";
import type { ToolOutcome } from "../execution/index.js";
import type { VerificationKind, VerificationPlan, VerificationReason } from "./types.js";
/**
 * Slice-7 mapping: which VerificationKind is performed by which Slice-6
 * capability. Used to turn the abstract "this needs a build check" into
 * a concrete capability the orchestrator can route through Slice 6.
 */
export declare const VERIFICATION_PERFORMED_BY: Readonly<Record<VerificationKind, CapabilityId>>;
interface PlanEntry {
    readonly kinds: readonly VerificationKind[];
    readonly reason: VerificationReason;
}
/**
 * Frozen lookup from CapabilityId -> required verification kinds.
 * Mirrors Slice 7 plan §1 table 1:1. Read-only / cognition / env-IO
 * capabilities map to NONE.
 */
export declare const VERIFICATION_PLAN_TABLE: Readonly<Record<CapabilityId, PlanEntry>>;
/**
 * Plan the verifications required for one source-capability invocation.
 * Pure: same `(capabilityId, mutationOutcome)` always returns the same
 * `VerificationPlan`.
 *
 * `mutationOutcome` is currently consumed only to early-exit on
 * non-success outcomes (no point planning verification for a mutation
 * that never produced an artifact). The orchestrator calls
 * `classifyCompletion` with `mutation_failed` in that case.
 */
export declare function planVerifications(capabilityId: CapabilityId, mutationOutcome: ToolOutcome): VerificationPlan;
export {};
//# sourceMappingURL=planner.d.ts.map