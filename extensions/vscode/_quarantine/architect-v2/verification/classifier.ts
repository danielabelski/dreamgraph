// STRICT ISOLATION (ADR-140): no import from v1.
// Slice 7 — Completion classifier.
//
// `classifyCompletion` is a pure function that maps
//   (mutation outcome, verification plan, verification evidence, repair budget)
// to one of 6 documented `CompletionStatus` kinds (Slice 7 plan §3).
//
// Exhaustiveness is enforced via `assertNeverStatus` (Slice 7 types.ts).
// The classifier never throws on missing toolchain; that becomes
// `failed_verification { reason: 'verification_unavailable' }`.

import type { ToolOutcome, VerificationEvidence } from "../execution/index.js";
import { planRepair, type AutonomyBudgetView } from "./repair.js";
import type {
  CompletionStatus,
  VerificationPlan,
  VerificationStep,
} from "./types.js";
import type { VerificationKind } from "../autonomy/index.js";

export interface ClassifyInput {
  readonly mutationOutcome: ToolOutcome;
  readonly plan: VerificationPlan;
  /**
   * Evidence collected from running each step. Keyed by VerificationKind.
   * Missing keys mean the step was attempted but the toolchain was
   * unavailable (e.g. no test runner installed).
   */
  readonly evidence: Readonly<Partial<Record<VerificationKind, VerificationEvidence>>>;
  readonly repairAttemptsByKind: Readonly<Record<VerificationKind, number>>;
  readonly autonomyBudget: AutonomyBudgetView;
}

/**
 * Pure classification of a single capability invocation's completion
 * status. Same input -> same status forever.
 */
export function classifyCompletion(input: ClassifyInput): CompletionStatus {
  const { mutationOutcome, plan, evidence, repairAttemptsByKind, autonomyBudget } =
    input;

  // 1. Mutation never produced an artifact -> mutation_failed.
  if (mutationOutcome.kind === "failure") {
    return Object.freeze({
      kind: "mutation_failed" as const,
      reason: "mutation_failed" as const,
      description: mutationOutcome.failureReason,
    });
  }

  // 2. No verification required (read-only, env-IO, capability succeeded).
  if (plan.steps.length === 0) {
    return Object.freeze({
      kind: "completed_no_verification_needed" as const,
    });
  }

  // 3. Partition steps by what the evidence tells us.
  const failedSteps: VerificationStep[] = [];
  const missingKinds: VerificationKind[] = [];
  const passedEvidence: VerificationEvidence[] = [];

  for (const step of plan.steps) {
    const ev = evidence[step.kind];
    if (!ev) {
      missingKinds.push(step.kind);
      continue;
    }
    if (ev.passed) {
      passedEvidence.push(ev);
    } else {
      failedSteps.push(step);
    }
  }

  // 4. Toolchain unavailable for one or more required steps -> failed_verification.
  //    This is a status, not an error. The orchestrator surfaces it as a blocker
  //    with reason 'verification_unavailable' so the user sees the precise gap.
  if (missingKinds.length > 0 && failedSteps.length === 0) {
    return Object.freeze({
      kind: "failed_verification" as const,
      reason: "verification_unavailable" as const,
      missingKinds: Object.freeze([...missingKinds]) as readonly VerificationKind[],
    });
  }

  // 5. All required verifications passed -> completed.
  if (failedSteps.length === 0 && missingKinds.length === 0) {
    return Object.freeze({
      kind: "completed" as const,
      evidence: Object.freeze([...passedEvidence]) as readonly VerificationEvidence[],
    });
  }

  // 6. At least one verification failed -> consult repair planner for the
  //    first failed step (others are surfaced via metrics).
  const first = failedSteps[0]!;
  const repair = planRepair({
    failedStep: first,
    repairAttemptsByKind,
    autonomyBudget,
  });

  if (repair.kind === "repair_with_continuation") {
    return Object.freeze({
      kind: "repair_recommended" as const,
      failedSteps: Object.freeze([...failedSteps]) as readonly VerificationStep[],
      continuation: repair.continuation,
    });
  }

  // skip_repair or escalate_to_blocker => blocked status carrying a Blocker.
  if (repair.kind === "escalate_to_blocker") {
    return Object.freeze({
      kind: "blocked" as const,
      blocker: repair.blocker,
    });
  }

  // skip_repair (non_actionable) is treated as blocked with a soft blocker
  // so the user sees the gap; the run does not silently complete on a
  // failed-but-skipped verification.
  return Object.freeze({
    kind: "blocked" as const,
    blocker: Object.freeze({
      kind: "soft" as const,
      description: `Verification ${first.kind} failed and was marked non-actionable; skipped repair.`,
      requiredCapability: first.performedBy,
    }),
  });
}
