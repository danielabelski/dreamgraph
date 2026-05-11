"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const autonomy_js_1 = require("../autonomy.js");
// F-18 scenario 1 — autonomy budget exhaustion.
// Pins the contract that:
//   - shouldContinueAfterPass stops cleanly when remainingAutoPasses hits 0
//     while a totalAuthorizedPasses budget is in effect, regardless of mode;
//   - decrementPassBudget bottoms out at 0 and never goes negative;
//   - decrementPassBudget is a no-op on remainingAutoPasses when no budget
//     was ever authorized (pass counting inactive).
const eligibleSignal = {
    hasClearNextStep: true,
    uncertainty: 'low',
    hasBlockingFailure: false,
    nextStepWithinScope: true,
    goalSufficientlyReached: false,
    progressStatus: 'advancing',
    nextStepIsNearTrivial: true,
    nextStepIsDefining: true,
};
(0, node_test_1.default)('shouldContinueAfterPass stops with "pass budget exhausted" when remaining hits 0', () => {
    const exhausted = {
        mode: 'autonomous',
        completedAutoPasses: 4,
        remainingAutoPasses: 0,
        totalAuthorizedPasses: 4,
    };
    const decision = (0, autonomy_js_1.shouldContinueAfterPass)(exhausted, eligibleSignal);
    strict_1.default.equal(decision.shouldContinue, false);
    strict_1.default.match(decision.reason, /pass budget exhausted/i);
    strict_1.default.equal(decision.selectionMode, 'none');
});
(0, node_test_1.default)('budget exhaustion stops every mode, even with otherwise-eligible signal', () => {
    for (const mode of ['cautious', 'conscientious', 'eager', 'autonomous']) {
        const state = {
            mode,
            completedAutoPasses: 3,
            remainingAutoPasses: 0,
            totalAuthorizedPasses: 3,
        };
        const decision = (0, autonomy_js_1.shouldContinueAfterPass)(state, eligibleSignal);
        strict_1.default.equal(decision.shouldContinue, false, `mode=${mode} should stop on exhausted budget`);
        strict_1.default.match(decision.reason, /pass budget exhausted/i, `mode=${mode} should report budget exhaustion`);
    }
});
(0, node_test_1.default)('decrementPassBudget bottoms out at 0 — never goes negative', () => {
    let state = (0, autonomy_js_1.createAutonomyState)('autonomous', 2);
    state = (0, autonomy_js_1.decrementPassBudget)(state);
    state = (0, autonomy_js_1.decrementPassBudget)(state);
    strict_1.default.equal(state.remainingAutoPasses, 0);
    strict_1.default.equal(state.completedAutoPasses, 2);
    // One more decrement past the floor.
    state = (0, autonomy_js_1.decrementPassBudget)(state);
    strict_1.default.equal(state.remainingAutoPasses, 0, 'remaining must clamp at 0');
    strict_1.default.equal(state.completedAutoPasses, 3, 'completed continues to count');
});
(0, node_test_1.default)('decrementPassBudget leaves remaining untouched when pass counting is inactive', () => {
    // No totalAuthorizedPasses → pass counting inactive → remaining stays at 0.
    const state = (0, autonomy_js_1.createAutonomyState)('eager');
    const next = (0, autonomy_js_1.decrementPassBudget)(state);
    strict_1.default.equal(next.totalAuthorizedPasses, undefined);
    strict_1.default.equal(next.remainingAutoPasses, 0);
    strict_1.default.equal(next.completedAutoPasses, 1, 'completed still increments for telemetry');
});
(0, node_test_1.default)('exhausted-budget stop fires before the cautious/eager mode-specific gates', () => {
    // A cautious-mode state with a high-uncertainty signal would normally pause for
    // user confirmation. With remaining=0 it must instead report budget exhaustion
    // — the budget gate is checked BEFORE the per-mode gates.
    const state = {
        mode: 'cautious',
        completedAutoPasses: 1,
        remainingAutoPasses: 0,
        totalAuthorizedPasses: 1,
    };
    const decision = (0, autonomy_js_1.shouldContinueAfterPass)(state, {
        ...eligibleSignal,
        uncertainty: 'medium',
        nextStepIsNearTrivial: false,
    });
    strict_1.default.equal(decision.shouldContinue, false);
    strict_1.default.match(decision.reason, /pass budget exhausted/i);
});
//# sourceMappingURL=autonomy-budget-exhaustion.test.js.map