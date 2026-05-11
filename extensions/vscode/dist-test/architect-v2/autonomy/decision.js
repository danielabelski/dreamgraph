"use strict";
// architect-v2/autonomy/decision.ts
// Slice 3 — Pure decision engine.
//
// STRICT ISOLATION (ADR-140): no import from v1.
//
// `deriveNextAction(taskState, capabilityInventory, candidates, now)` is the
// one seam later slices depend on. It is a pure function over its inputs.
// Same inputs always produce the same `DecisionResult`. No I/O, no global
// state, no provider calls.
Object.defineProperty(exports, "__esModule", { value: true });
exports.rankActions = rankActions;
exports.filterByCapability = filterByCapability;
exports.detectNoProgress = detectNoProgress;
exports.buildContinuationPrompt = buildContinuationPrompt;
exports.deriveNextAction = deriveNextAction;
const budget_1 = require("./budget");
const signals_1 = require("./signals");
// ---------------------------------------------------------------------------
// Action ranking
// ---------------------------------------------------------------------------
/**
 * (Preserved concept from v1 `rankRecommendedActions` — but reduced. v1
 * sorted by `priority` field with mutex/batch logic; v2 sorts by self-reported
 * `confidence` descending, ties broken by label. Eligibility filtering is
 * caller's responsibility (see `filterByCapability`).)
 */
function rankActions(candidates) {
    const sorted = [...candidates].sort((a, b) => {
        const byConfidence = b.confidence - a.confidence;
        if (byConfidence !== 0)
            return byConfidence;
        return a.label.localeCompare(b.label);
    });
    return {
        ranked: sorted,
        top: sorted[0],
        alternatives: sorted.slice(1),
    };
}
function filterByCapability(candidates, inventory) {
    return candidates.filter((c) => c.requiresCapabilities.every((cap) => inventory.has(cap)));
}
// ---------------------------------------------------------------------------
// No-progress detection
// ---------------------------------------------------------------------------
/**
 * No-progress = the last two passes ended with the same artifact-snapshot
 * fingerprint. Replaces v1's `consecutiveEmptyPasses` heuristic with an
 * observation grounded in actual artifact state.
 */
function detectNoProgress(passes) {
    if (passes.length < 2)
        return { noProgress: false, passesWithoutDelta: 0 };
    const last = passes[passes.length - 1];
    const prev = passes[passes.length - 2];
    const lastFp = fingerprint(last.endingArtifacts);
    const prevFp = fingerprint(prev.endingArtifacts);
    if (lastFp !== prevFp)
        return { noProgress: false, passesWithoutDelta: 0 };
    // Walk backwards to count how many consecutive passes share the fingerprint.
    let count = 2;
    for (let i = passes.length - 3; i >= 0; i--) {
        if (fingerprint(passes[i].endingArtifacts) === lastFp)
            count++;
        else
            break;
    }
    return { noProgress: true, passesWithoutDelta: count };
}
function fingerprint(snapshots) {
    if (snapshots.length === 0)
        return "∅";
    return [...snapshots]
        .map((s) => `${s.id}:${s.hash}`)
        .sort()
        .join("|");
}
// ---------------------------------------------------------------------------
// Continuation prompt builder (ADR-154 enforcement boundary)
// ---------------------------------------------------------------------------
/**
 * Builds a continuation prompt that embeds the selected action's exact tool
 * name plus a brief mention of considered alternatives. The tool-name embed
 * is the ADR-154 invariant; `createContinuationNeed()` re-checks it as a
 * defense in depth.
 */
function buildContinuationPrompt(top, alternatives) {
    const altList = alternatives.length === 0
        ? "(none considered)"
        : alternatives
            .slice(0, 3)
            .map((a) => `${a.label} via \`${a.tool}\``)
            .join("; ");
    return [
        `Continue with the selected next action: ${top.label}.`,
        `Use the tool \`${top.tool}\` to perform it.`,
        `Rationale: ${top.rationale}`,
        `Alternatives considered: ${altList}.`,
        `Stop if the goal is sufficiently reached, if you encounter a hard blocker, or if no further progress is possible.`,
    ].join(" ");
}
function deriveNextAction(input) {
    const { taskState, inventory, candidates, nowEpochMs } = input;
    // 1. User pause is a non-negotiable.
    if (taskState.status === "paused_for_user") {
        return {
            kind: "pause_for_user",
            reason: "awaiting_user",
            ranked: { ranked: [], top: undefined, alternatives: [] },
            note: "Task is paused awaiting user input.",
        };
    }
    if (taskState.status === "stopped") {
        return { kind: "stop", condition: { kind: "user_paused" } };
    }
    // 2. Goal reached (caller signals on the latest PassRecord).
    const lastPass = taskState.passes[taskState.passes.length - 1];
    if (lastPass?.goalReached) {
        return { kind: "stop", condition: { kind: "goal_reached" } };
    }
    // 3. Pass budget exhaustion.
    if (taskState.passBudget.remaining <= 0) {
        return { kind: "stop", condition: { kind: "pass_budget_exhausted" } };
    }
    // 4. Time budget exhaustion.
    if ((0, budget_1.isTimeBudgetExhausted)(taskState.timeBudget, nowEpochMs)) {
        return { kind: "stop", condition: { kind: "time_budget_exhausted" } };
    }
    // 5. Verification failure under strict strictness.
    if (lastPass?.verificationFailure &&
        taskState.profile.verificationStrictness === "strict") {
        return {
            kind: "stop",
            condition: {
                kind: "verification_failed",
                failure: lastPass.verificationFailure,
            },
        };
    }
    // 6. No-progress detection on artifact snapshots.
    const progress = detectNoProgress(taskState.passes);
    if (progress.noProgress) {
        return {
            kind: "stop",
            condition: {
                kind: "no_progress",
                passesWithoutDelta: progress.passesWithoutDelta,
            },
        };
    }
    // 7. Hard blockers always stop.
    const hardBlocker = taskState.blockers.find((b) => b.kind === "hard");
    if (hardBlocker) {
        return { kind: "stop", condition: { kind: "blocker", blocker: hardBlocker } };
    }
    // 8. Soft blockers vs mode tolerance.
    const softCount = taskState.blockers.filter((b) => b.kind === "soft").length;
    if (softCount > taskState.profile.blockerTolerance) {
        const firstSoft = taskState.blockers.find((b) => b.kind === "soft");
        return { kind: "stop", condition: { kind: "blocker", blocker: firstSoft } };
    }
    // 9. Capability filter on candidates.
    const eligible = filterByCapability(candidates, inventory);
    if (eligible.length === 0) {
        return { kind: "stop", condition: { kind: "no_viable_action" } };
    }
    // 10. Rank and inspect top.
    const ranked = rankActions(eligible);
    const top = ranked.top; // eligible.length > 0 ⇒ top defined
    const threshold = taskState.profile.confidenceThreshold;
    // 11. Confidence below threshold → pause for user pick.
    if (top.confidence < threshold) {
        return {
            kind: "pause_for_user",
            reason: "mode_threshold_unmet",
            ranked,
            note: `Top candidate confidence ${top.confidence.toFixed(2)} is below the ` +
                `${taskState.mode} threshold ${threshold.toFixed(2)}.`,
        };
    }
    // 12. Self-continue with the top action.
    const continuationPrompt = buildContinuationPrompt(top, ranked.alternatives);
    const reasoningTrace = `Selected '${top.label}' (tool: ${top.tool}) with confidence ` +
        `${top.confidence.toFixed(2)} ≥ mode threshold ` +
        `${threshold.toFixed(2)}. ${ranked.alternatives.length} alternative(s) considered.`;
    return {
        kind: "continue",
        need: (0, signals_1.createContinuationNeed)({
            selectedAction: top,
            continuationPrompt,
            reasoningTrace,
            alternativesConsidered: ranked.alternatives,
        }),
    };
}
//# sourceMappingURL=decision.js.map