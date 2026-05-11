"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifyCompletion = classifyCompletion;
const repair_js_1 = require("./repair.js");
/**
 * Pure classification of a single capability invocation's completion
 * status. Same input -> same status forever.
 */
function classifyCompletion(input) {
    const { mutationOutcome, plan, evidence, repairAttemptsByKind, autonomyBudget } = input;
    // 1. Mutation never produced an artifact -> mutation_failed.
    if (mutationOutcome.kind === "failure") {
        return Object.freeze({
            kind: "mutation_failed",
            reason: "mutation_failed",
            description: mutationOutcome.failureReason,
        });
    }
    // 2. No verification required (read-only, env-IO, capability succeeded).
    if (plan.steps.length === 0) {
        return Object.freeze({
            kind: "completed_no_verification_needed",
        });
    }
    // 3. Partition steps by what the evidence tells us.
    const failedSteps = [];
    const missingKinds = [];
    const passedEvidence = [];
    for (const step of plan.steps) {
        const ev = evidence[step.kind];
        if (!ev) {
            missingKinds.push(step.kind);
            continue;
        }
        if (ev.passed) {
            passedEvidence.push(ev);
        }
        else {
            failedSteps.push(step);
        }
    }
    // 4. Toolchain unavailable for one or more required steps -> failed_verification.
    //    This is a status, not an error. The orchestrator surfaces it as a blocker
    //    with reason 'verification_unavailable' so the user sees the precise gap.
    if (missingKinds.length > 0 && failedSteps.length === 0) {
        return Object.freeze({
            kind: "failed_verification",
            reason: "verification_unavailable",
            missingKinds: Object.freeze([...missingKinds]),
        });
    }
    // 5. All required verifications passed -> completed.
    if (failedSteps.length === 0 && missingKinds.length === 0) {
        return Object.freeze({
            kind: "completed",
            evidence: Object.freeze([...passedEvidence]),
        });
    }
    // 6. At least one verification failed -> consult repair planner for the
    //    first failed step (others are surfaced via metrics).
    const first = failedSteps[0];
    const repair = (0, repair_js_1.planRepair)({
        failedStep: first,
        repairAttemptsByKind,
        autonomyBudget,
    });
    if (repair.kind === "repair_with_continuation") {
        return Object.freeze({
            kind: "repair_recommended",
            failedSteps: Object.freeze([...failedSteps]),
            continuation: repair.continuation,
        });
    }
    // skip_repair or escalate_to_blocker => blocked status carrying a Blocker.
    if (repair.kind === "escalate_to_blocker") {
        return Object.freeze({
            kind: "blocked",
            blocker: repair.blocker,
        });
    }
    // skip_repair (non_actionable) is treated as blocked with a soft blocker
    // so the user sees the gap; the run does not silently complete on a
    // failed-but-skipped verification.
    return Object.freeze({
        kind: "blocked",
        blocker: Object.freeze({
            kind: "soft",
            description: `Verification ${first.kind} failed and was marked non-actionable; skipped repair.`,
            requiredCapability: first.performedBy,
        }),
    });
}
//# sourceMappingURL=classifier.js.map