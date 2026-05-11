// STRICT ISOLATION (ADR-140): no import from v1.
// Slice 7 — Completion metrics.
//
// `computeMetrics` is a pure derivation from a pass's outcomes,
// capability plans, and final classifications. It exists so cards
// (Slice 5) and the orchestrator can render counters without keeping a
// parallel mutable counter store.

import type { ToolOutcome } from "../execution/index.js";
import type { CapabilityPlan } from "../capabilities/index.js";
import type { VerificationKind } from "../autonomy/index.js";
import type {
  CompletionMetrics,
  CompletionStatus,
  VerificationPlan,
} from "./types.js";

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

const ZERO_REPAIR_COUNTERS: Readonly<Record<VerificationKind, number>> = Object.freeze({
  build: 0,
  test: 0,
  type: 0,
  lint: 0,
  mcp_verify: 0,
  invariant: 0,
});

/**
 * Pure metrics derivation. Same input -> same `CompletionMetrics`. Used
 * by cards (Slice 5) and the orchestrator for end-of-pass reporting.
 */
export function computeMetrics(input: ComputeMetricsInput): CompletionMetrics {
  const {
    outcomes,
    capabilityPlans,
    verificationPlans,
    classifications,
    priorRepairAttemptsByKind,
    enrichmentTasksDrained,
  } = input;

  // Verifications attempted = sum of steps across plans.
  let verificationsAttempted = 0;
  for (const p of verificationPlans) verificationsAttempted += p.steps.length;

  // Verifications passed/failed/unavailable = scan outcomes that carry
  // a VerificationEvidence (success.kind with evidence) plus
  // classifications that flagged unavailable kinds.
  let verificationsPassed = 0;
  let verificationsFailed = 0;
  for (const o of outcomes) {
    if (o.kind === "success" && o.evidence) {
      if (o.evidence.passed) verificationsPassed++;
      else verificationsFailed++;
    }
  }

  let verificationsUnavailable = 0;
  for (const c of classifications) {
    if (c.kind === "failed_verification") {
      verificationsUnavailable += c.missingKinds.length;
    }
  }

  // Repair attempts: increment kind counters for every classification that
  // emitted repair_recommended. Uses prior counters as the carry-over base.
  const repairAttemptsByKind: Record<VerificationKind, number> = {
    ...ZERO_REPAIR_COUNTERS,
    ...priorRepairAttemptsByKind,
  };
  for (const c of classifications) {
    if (c.kind === "repair_recommended") {
      for (const step of c.failedSteps) {
        repairAttemptsByKind[step.kind] = (repairAttemptsByKind[step.kind] ?? 0) + 1;
      }
    }
  }

  // Slice-6 derived counters.
  let enrichmentTasksQueued = 0;
  let graphOnlyCapabilitiesSkipped = 0;
  for (const p of capabilityPlans) {
    if (p.kind === "sparse-mode" && p.enrichmentQueued) enrichmentTasksQueued++;
    if (p.kind === "gap") {
      graphOnlyCapabilitiesSkipped++;
      if (p.enrichmentQueued) enrichmentTasksQueued++;
    }
  }

  // Final status of the pass: prefer worst-case across classifications so
  // a single mutation_failed dominates. Order: mutation_failed >
  // failed_verification > blocked > repair_recommended > completed_no_verification_needed > completed.
  const finalStatus = aggregateFinalStatus(classifications);

  return Object.freeze({
    verificationsAttempted,
    verificationsPassed,
    verificationsFailed,
    verificationsUnavailable,
    repairAttemptsByKind: Object.freeze({ ...repairAttemptsByKind }),
    enrichmentTasksQueued,
    enrichmentTasksDrained,
    graphOnlyCapabilitiesSkipped,
    finalStatus,
  });
}

const STATUS_RANK: Record<CompletionStatus["kind"], number> = {
  mutation_failed: 5,
  failed_verification: 4,
  blocked: 3,
  repair_recommended: 2,
  completed_no_verification_needed: 1,
  completed: 0,
};

function aggregateFinalStatus(
  classifications: readonly CompletionStatus[],
): CompletionStatus["kind"] {
  if (classifications.length === 0) return "completed_no_verification_needed";
  let worst: CompletionStatus["kind"] = "completed";
  for (const c of classifications) {
    if (STATUS_RANK[c.kind] > STATUS_RANK[worst]) worst = c.kind;
  }
  return worst;
}
