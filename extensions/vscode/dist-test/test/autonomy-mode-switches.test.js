"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const autonomy_js_1 = require("../autonomy.js");
// F-18 scenario 2 — rapid mode switches mid-pass.
// The chat panel re-evaluates `shouldContinueAfterPass(state, signal)` each
// pass, and a user can flip `dreamgraph.architect.autonomyMode` between any
// two passes. These tests pin that:
//   - `state.mode` is the only field that changes during a switch; the
//     pass counters survive the transition;
//   - the per-mode gate inside shouldContinueAfterPass is evaluated against
//     the CURRENT mode each call (no stale-mode latching);
//   - decrementPassBudget keeps counting accurately across a switch sequence.
const ambiguousSignal = {
    // Clear next step inside scope, but uncertainty is medium and the step is
    // neither near-trivial nor defining — different modes give different verdicts.
    hasClearNextStep: true,
    uncertainty: 'medium',
    hasBlockingFailure: false,
    nextStepWithinScope: true,
    goalSufficientlyReached: false,
    progressStatus: 'advancing',
    nextStepIsNearTrivial: false,
    nextStepIsDefining: false,
};
function withMode(state, mode) {
    // Mirrors the chat-panel pattern: change mode, keep counters as-is.
    return { ...state, mode };
}
(0, node_test_1.default)('mode switch preserves completed and remaining pass counters', () => {
    const initial = {
        mode: 'cautious',
        completedAutoPasses: 2,
        remainingAutoPasses: 3,
        totalAuthorizedPasses: 5,
    };
    const switched = withMode(initial, 'autonomous');
    strict_1.default.equal(switched.completedAutoPasses, 2);
    strict_1.default.equal(switched.remainingAutoPasses, 3);
    strict_1.default.equal(switched.totalAuthorizedPasses, 5);
    strict_1.default.equal(switched.mode, 'autonomous');
});
(0, node_test_1.default)('shouldContinueAfterPass re-evaluates against the new mode immediately', () => {
    let state = {
        mode: 'cautious',
        completedAutoPasses: 1,
        remainingAutoPasses: 5,
        totalAuthorizedPasses: 5,
    };
    // Cautious + ambiguous signal → pause for user.
    const cautiousDecision = (0, autonomy_js_1.shouldContinueAfterPass)(state, ambiguousSignal);
    strict_1.default.equal(cautiousDecision.shouldContinue, false);
    strict_1.default.equal(cautiousDecision.selectionMode, 'user');
    // Switch to autonomous mid-run; the very next call must continue automatically
    // (no latency from a stale mode).
    state = withMode(state, 'autonomous');
    const autonomousDecision = (0, autonomy_js_1.shouldContinueAfterPass)(state, ambiguousSignal);
    strict_1.default.equal(autonomousDecision.shouldContinue, true);
    strict_1.default.equal(autonomousDecision.selectionMode, 'self');
    // Switch back to cautious; the answer flips back deterministically.
    state = withMode(state, 'cautious');
    const cautiousAgain = (0, autonomy_js_1.shouldContinueAfterPass)(state, ambiguousSignal);
    strict_1.default.equal(cautiousAgain.shouldContinue, false);
    strict_1.default.equal(cautiousAgain.selectionMode, 'user');
});
(0, node_test_1.default)('decrementPassBudget counts correctly across a cautious→eager→autonomous→cautious sequence', () => {
    let state = {
        mode: 'cautious',
        completedAutoPasses: 0,
        remainingAutoPasses: 4,
        totalAuthorizedPasses: 4,
    };
    state = (0, autonomy_js_1.decrementPassBudget)(state); // pass 1, cautious
    state = withMode(state, 'eager');
    state = (0, autonomy_js_1.decrementPassBudget)(state); // pass 2, eager
    state = withMode(state, 'autonomous');
    state = (0, autonomy_js_1.decrementPassBudget)(state); // pass 3, autonomous
    state = withMode(state, 'cautious');
    state = (0, autonomy_js_1.decrementPassBudget)(state); // pass 4, cautious
    strict_1.default.equal(state.completedAutoPasses, 4);
    strict_1.default.equal(state.remainingAutoPasses, 0);
    strict_1.default.equal(state.totalAuthorizedPasses, 4);
    strict_1.default.equal(state.mode, 'cautious');
});
(0, node_test_1.default)('switching modes after exhaustion does not revive the budget', () => {
    const exhausted = {
        mode: 'cautious',
        completedAutoPasses: 4,
        remainingAutoPasses: 0,
        totalAuthorizedPasses: 4,
    };
    const flipped = withMode(exhausted, 'autonomous');
    const decision = (0, autonomy_js_1.shouldContinueAfterPass)(flipped, {
        ...ambiguousSignal,
        uncertainty: 'low',
        nextStepIsNearTrivial: true,
    });
    strict_1.default.equal(decision.shouldContinue, false);
    strict_1.default.match(decision.reason, /pass budget exhausted/i);
});
//# sourceMappingURL=autonomy-mode-switches.test.js.map