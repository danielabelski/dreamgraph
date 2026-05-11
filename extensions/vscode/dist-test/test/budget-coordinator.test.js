"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const budget_coordinator_js_1 = require("../budget-coordinator.js");
const baseSettings = {
    expectedTokensPerTurn: 16_000,
    transportCeilingTokens: 180_000,
    debtCarryFraction: 1.0,
    turnNumber: 1,
    modelId: 'claude-opus-4-6',
};
(0, node_test_1.default)('fresh coordinator with no snapshot has zero debt and full target', () => {
    const c = new budget_coordinator_js_1.BudgetCoordinator(null, baseSettings);
    strict_1.default.equal(c.getSnapshot().debtTokens, 0);
    strict_1.default.equal(c.getRemainingTargetTokens(), 16_000);
    strict_1.default.equal(c.getContextPressureLabel(), 'low');
});
(0, node_test_1.default)('estimate creates a reservation and is replaced by actual', () => {
    const c = new budget_coordinator_js_1.BudgetCoordinator(null, baseSettings);
    c.recordComponentEstimate('tool:read_source_code', 5_000);
    strict_1.default.equal(c.getRemainingTargetTokens(), 11_000);
    c.recordComponentActual('tool:read_source_code', 6_500);
    // estimate replaced; remaining = 16000 - 6500
    strict_1.default.equal(c.getRemainingTargetTokens(), 9_500);
});
(0, node_test_1.default)('unreconciled estimates are discarded at finalize', () => {
    const c = new budget_coordinator_js_1.BudgetCoordinator(null, baseSettings);
    c.recordComponentEstimate('context:graph', 2_000);
    c.recordComponentActual('context:env', 1_000);
    const snap = c.finalizeTurn();
    strict_1.default.equal(snap.history.length, 1);
    strict_1.default.equal(snap.history[0].components?.['context:env'], 1_000);
    strict_1.default.equal(snap.history[0].components?.['context:graph'], undefined);
    strict_1.default.equal(snap.lastActualTokens, 1_000);
});
(0, node_test_1.default)('debt carries forward after overspend', () => {
    const c = new budget_coordinator_js_1.BudgetCoordinator(null, baseSettings);
    c.recordComponentActual('tool:foo', 18_000);
    const snap = c.finalizeTurn();
    strict_1.default.equal(snap.debtTokens, 2_000);
    strict_1.default.equal(snap.lastActualTokens, 18_000);
});
(0, node_test_1.default)('debt repaid by underspend on next turn', () => {
    const start = {
        debtTokens: 2_000,
        expectedTokens: 16_000,
        ceilingTokens: 180_000,
        lastActualTokens: 18_000,
        modelId: 'claude-opus-4-6',
        history: [],
    };
    const c = new budget_coordinator_js_1.BudgetCoordinator(start, { ...baseSettings, turnNumber: 2 });
    // turn target = 16000 - 2000 = 14000
    strict_1.default.equal(c.getRemainingTargetTokens(), 14_000);
    c.recordComponentActual('tool:foo', 12_000);
    const next = c.finalizeTurn();
    // delta = 12000 - 16000 = -4000; new debt = 2000 + (-4000) = -2000
    strict_1.default.equal(next.debtTokens, -2_000);
});
(0, node_test_1.default)('pressure label crosses thresholds at 0 and 0.5', () => {
    const c = new budget_coordinator_js_1.BudgetCoordinator(null, baseSettings);
    // empty -> low
    strict_1.default.equal(c.getContextPressureLabel(), 'low');
    // committed equal to target -> pressure ~0 -> still low (boundary inclusive)
    c.recordComponentActual('a', 16_000);
    strict_1.default.equal(c.getContextPressureLabel(), 'low');
    // overshoot by 25% -> pressure 0.25 -> normal
    c.recordComponentActual('b', 4_000);
    strict_1.default.equal(c.getContextPressureLabel(), 'normal');
    // overshoot by 75% -> pressure 0.75 -> high
    c.recordComponentActual('b', 12_000);
    strict_1.default.equal(c.getContextPressureLabel(), 'high');
});
(0, node_test_1.default)('compression records do not affect debt math', () => {
    const c = new budget_coordinator_js_1.BudgetCoordinator(null, baseSettings);
    c.recordCompression('tool:foo', 50_000, 8_000, 'expected');
    c.recordComponentActual('tool:foo', 8_000);
    const snap = c.finalizeTurn();
    // debt is computed from final delivered actual (8000), not original 50000
    strict_1.default.equal(snap.debtTokens, 8_000 - 16_000);
});
(0, node_test_1.default)('history retains components only for the most recent N turns', () => {
    let snap = null;
    for (let turn = 1; turn <= 25; turn++) {
        const c = new budget_coordinator_js_1.BudgetCoordinator(snap, { ...baseSettings, turnNumber: turn });
        c.recordComponentActual('tool:x', 16_000);
        snap = c.finalizeTurn();
    }
    strict_1.default.ok(snap);
    // last 20 keep components; first 5 stripped
    strict_1.default.equal(snap.history.length, 25);
    strict_1.default.equal(snap.history[0].components, undefined);
    strict_1.default.equal(snap.history[4].components, undefined);
    strict_1.default.ok(snap.history[5].components);
    strict_1.default.ok(snap.history[24].components);
});
(0, node_test_1.default)('model switch rescales debt with clamp + decay', () => {
    const start = {
        debtTokens: 50_000, // big debt on big model
        expectedTokens: 64_000,
        ceilingTokens: 200_000,
        lastActualTokens: 0,
        modelId: 'big-model',
        history: [],
    };
    const c = new budget_coordinator_js_1.BudgetCoordinator(start, {
        ...baseSettings,
        expectedTokensPerTurn: 16_000, // downgrade
        turnNumber: 5,
        modelId: 'small-model',
    });
    // ratio = 16000/64000 = 0.25; provisional = 12500; decayed = 6250
    // clamp magnitude = 0.5 * 16000 = 8000 -> 6250 fits
    // NOT extreme downgrade (16000 == 0.25 * 64000, not strictly <)
    strict_1.default.equal(c.getSnapshot().debtTokens, 6_250);
});
(0, node_test_1.default)('extreme downgrade resets debt and logs synthetic history entry', () => {
    const start = {
        debtTokens: 100_000,
        expectedTokens: 200_000,
        ceilingTokens: 400_000,
        lastActualTokens: 0,
        modelId: 'huge',
        history: [],
    };
    const c = new budget_coordinator_js_1.BudgetCoordinator(start, {
        ...baseSettings,
        expectedTokensPerTurn: 8_000, // 8000 < 0.25 * 200000 = 50000 -> reset
        turnNumber: 3,
        modelId: 'tiny',
    });
    strict_1.default.equal(c.getSnapshot().debtTokens, 0);
    c.recordComponentActual('x', 8_000);
    const snap = c.finalizeTurn();
    const switchEntry = snap.history.find((h) => h.modelSwitch);
    strict_1.default.ok(switchEntry);
    strict_1.default.equal(switchEntry.modelSwitch.from, 'huge');
    strict_1.default.equal(switchEntry.modelSwitch.newDebt, 0);
});
(0, node_test_1.default)('graph slice emergency trim flag persisted in history', () => {
    const c = new budget_coordinator_js_1.BudgetCoordinator(null, baseSettings);
    c.recordComponentActual('context:graph', 200);
    c.flagGraphSliceEmergencyTrim();
    const snap = c.finalizeTurn();
    strict_1.default.equal(snap.history[0].graphSliceEmergencyTrim, true);
});
(0, node_test_1.default)('finalize is idempotent', () => {
    const c = new budget_coordinator_js_1.BudgetCoordinator(null, baseSettings);
    c.recordComponentActual('a', 1000);
    const first = c.finalizeTurn();
    // subsequent record-calls are ignored
    c.recordComponentActual('b', 9999);
    const second = c.finalizeTurn();
    strict_1.default.equal(first, second);
});
(0, node_test_1.default)('estimateTokensFromString uses chars/4 heuristic', () => {
    strict_1.default.equal((0, budget_coordinator_js_1.estimateTokensFromString)(''), 0);
    strict_1.default.equal((0, budget_coordinator_js_1.estimateTokensFromString)(null), 0);
    strict_1.default.equal((0, budget_coordinator_js_1.estimateTokensFromString)('1234'), 1);
    strict_1.default.equal((0, budget_coordinator_js_1.estimateTokensFromString)('12345'), 2);
});
(0, node_test_1.default)('Phase 2 — BudgetSnapshot is JSON round-trip identical (Plan §9 reload invariant)', () => {
    const c = new budget_coordinator_js_1.BudgetCoordinator(null, baseSettings);
    c.recordComponentActual('tool:read_source_code', 6_500);
    c.recordComponentActual('context:graph', 4_000);
    c.recordComponentActual('context:evidence', 2_000);
    c.flagGraphSliceEmergencyTrim();
    const snap = c.finalizeTurn();
    const roundTripped = JSON.parse(JSON.stringify(snap));
    strict_1.default.deepEqual(roundTripped, snap);
    // Hydrating a follow-up turn from the round-tripped snapshot must yield
    // the same pressure label and remaining target as hydrating from the
    // original — that is the §9 byte-for-byte invariant in observable form.
    const next1 = new budget_coordinator_js_1.BudgetCoordinator(snap, { ...baseSettings, turnNumber: 2 });
    const next2 = new budget_coordinator_js_1.BudgetCoordinator(roundTripped, { ...baseSettings, turnNumber: 2 });
    strict_1.default.equal(next1.getPressure(), next2.getPressure());
    strict_1.default.equal(next1.getContextPressureLabel(), next2.getContextPressureLabel());
    strict_1.default.equal(next1.getRemainingTargetTokens(), next2.getRemainingTargetTokens());
});
//# sourceMappingURL=budget-coordinator.test.js.map