"use strict";
// STRICT ISOLATION (ADR-140): no import from v1.
// Slice 7 — Repair planning.
//
// `planRepair` is a pure function that decides what to do when a
// verification step has failed. It either issues a `ContinuationNeed`
// (Slice 3 ADR-154) bound to the verification tool, or escalates to a
// typed `Blocker`, or skips repair when the failure is non-actionable.
//
// Default repair budget: 1 attempt per VerificationKind per task
// (Slice 7 plan §4). The orchestrator owns the persistent counter and
// passes it in via `repairAttemptsByKind`.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_REPAIR_BUDGET_PER_KIND = void 0;
exports.planRepair = planRepair;
const index_js_1 = require("../autonomy/index.js");
exports.DEFAULT_REPAIR_BUDGET_PER_KIND = 1;
/**
 * Pure repair planner. Same input -> same RepairDecision.
 *
 * The continuation prompt embeds the verification tool name verbatim, as
 * required by ADR-154 (the `createContinuationNeed` constructor enforces).
 */
function planRepair(input) {
    const { failedStep, repairAttemptsByKind, autonomyBudget, nonActionable = false, maxAttemptsPerKind = exports.DEFAULT_REPAIR_BUDGET_PER_KIND, } = input;
    if (nonActionable) {
        return Object.freeze({
            kind: "skip_repair",
            failedStep,
            reason: "non_actionable",
        });
    }
    const attempts = repairAttemptsByKind[failedStep.kind] ?? 0;
    const repairBudgetExhausted = attempts >= maxAttemptsPerKind;
    const autonomyExhausted = autonomyBudget.continuationsRemaining <= 0;
    if (repairBudgetExhausted || autonomyExhausted) {
        const blocker = Object.freeze({
            kind: "hard",
            description: repairBudgetExhausted
                ? `Repair budget exhausted for ${failedStep.kind} verification (attempts=${attempts}, max=${maxAttemptsPerKind})`
                : `Autonomy budget exhausted; cannot issue repair continuation for ${failedStep.kind}`,
            requiredCapability: failedStep.performedBy,
        });
        return Object.freeze({
            kind: "escalate_to_blocker",
            failedStep,
            blocker,
        });
    }
    // Issue a continuation that re-runs the verification tool. ADR-154
    // requires the tool name to be embedded in continuationPrompt; the
    // constructor throws if it isn't.
    const toolName = failedStep.performedBy;
    const continuation = (0, index_js_1.createContinuationNeed)({
        selectedAction: {
            id: `repair:${failedStep.kind}:${attempts + 1}`,
            label: `Repair ${failedStep.kind} verification`,
            rationale: `Verification ${failedStep.kind} failed (${failedStep.reason}); re-run after diagnosing cause.`,
            tool: toolName,
            requiresCapabilities: [failedStep.performedBy],
            confidence: 0.7,
        },
        continuationPrompt: `Re-run ${toolName} to confirm the repair fixed the ${failedStep.kind} failure (attempt ${attempts + 1} of ${maxAttemptsPerKind}).`,
        reasoningTrace: `${failedStep.kind} verification failed; repair budget remains (${attempts}/${maxAttemptsPerKind}); autonomy budget allows ${autonomyBudget.continuationsRemaining} more continuation(s).`,
        alternativesConsidered: [],
    });
    return Object.freeze({
        kind: "repair_with_continuation",
        failedStep,
        continuation,
    });
}
//# sourceMappingURL=repair.js.map