import test from 'node:test';
import assert from 'node:assert/strict';
import { BudgetCoordinator, estimateTokensFromString, type BudgetSnapshot } from '../budget-coordinator.js';

const baseSettings = {
  expectedTokensPerTurn: 16_000,
  transportCeilingTokens: 180_000,
  debtCarryFraction: 1.0,
  turnNumber: 1,
  modelId: 'claude-opus-4-6',
};

test('fresh coordinator with no snapshot has zero debt and full target', () => {
  const c = new BudgetCoordinator(null, baseSettings);
  assert.equal(c.getSnapshot().debtTokens, 0);
  assert.equal(c.getRemainingTargetTokens(), 16_000);
  assert.equal(c.getContextPressureLabel(), 'low');
});

test('estimate creates a reservation and is replaced by actual', () => {
  const c = new BudgetCoordinator(null, baseSettings);
  c.recordComponentEstimate('tool:read_source_code', 5_000);
  assert.equal(c.getRemainingTargetTokens(), 11_000);
  c.recordComponentActual('tool:read_source_code', 6_500);
  // estimate replaced; remaining = 16000 - 6500
  assert.equal(c.getRemainingTargetTokens(), 9_500);
});

test('unreconciled estimates are discarded at finalize', () => {
  const c = new BudgetCoordinator(null, baseSettings);
  c.recordComponentEstimate('context:graph', 2_000);
  c.recordComponentActual('context:env', 1_000);
  const snap = c.finalizeTurn();
  assert.equal(snap.history.length, 1);
  assert.equal(snap.history[0].components?.['context:env'], 1_000);
  assert.equal(snap.history[0].components?.['context:graph'], undefined);
  assert.equal(snap.lastActualTokens, 1_000);
});

test('debt carries forward after overspend', () => {
  const c = new BudgetCoordinator(null, baseSettings);
  c.recordComponentActual('tool:foo', 18_000);
  const snap = c.finalizeTurn();
  assert.equal(snap.debtTokens, 2_000);
  assert.equal(snap.lastActualTokens, 18_000);
});

test('debt repaid by underspend on next turn', () => {
  const start: BudgetSnapshot = {
    debtTokens: 2_000,
    expectedTokens: 16_000,
    ceilingTokens: 180_000,
    lastActualTokens: 18_000,
    modelId: 'claude-opus-4-6',
    history: [],
  };
  const c = new BudgetCoordinator(start, { ...baseSettings, turnNumber: 2 });
  // turn target = 16000 - 2000 = 14000
  assert.equal(c.getRemainingTargetTokens(), 14_000);
  c.recordComponentActual('tool:foo', 12_000);
  const next = c.finalizeTurn();
  // delta = 12000 - 16000 = -4000; new debt = 2000 + (-4000) = -2000
  assert.equal(next.debtTokens, -2_000);
});

test('pressure label crosses thresholds at 0 and 0.5', () => {
  const c = new BudgetCoordinator(null, baseSettings);
  // empty -> low
  assert.equal(c.getContextPressureLabel(), 'low');
  // committed equal to target -> pressure ~0 -> still low (boundary inclusive)
  c.recordComponentActual('a', 16_000);
  assert.equal(c.getContextPressureLabel(), 'low');
  // overshoot by 25% -> pressure 0.25 -> normal
  c.recordComponentActual('b', 4_000);
  assert.equal(c.getContextPressureLabel(), 'normal');
  // overshoot by 75% -> pressure 0.75 -> high
  c.recordComponentActual('b', 12_000);
  assert.equal(c.getContextPressureLabel(), 'high');
});

test('compression records do not affect debt math', () => {
  const c = new BudgetCoordinator(null, baseSettings);
  c.recordCompression('tool:foo', 50_000, 8_000, 'expected');
  c.recordComponentActual('tool:foo', 8_000);
  const snap = c.finalizeTurn();
  // debt is computed from final delivered actual (8000), not original 50000
  assert.equal(snap.debtTokens, 8_000 - 16_000);
});

test('history retains components only for the most recent N turns', () => {
  let snap: BudgetSnapshot | null = null;
  for (let turn = 1; turn <= 25; turn++) {
    const c: BudgetCoordinator = new BudgetCoordinator(snap, { ...baseSettings, turnNumber: turn });
    c.recordComponentActual('tool:x', 16_000);
    snap = c.finalizeTurn();
  }
  assert.ok(snap);
  // last 20 keep components; first 5 stripped
  assert.equal(snap!.history.length, 25);
  assert.equal(snap!.history[0].components, undefined);
  assert.equal(snap!.history[4].components, undefined);
  assert.ok(snap!.history[5].components);
  assert.ok(snap!.history[24].components);
});

test('model switch rescales debt with clamp + decay', () => {
  const start: BudgetSnapshot = {
    debtTokens: 50_000, // big debt on big model
    expectedTokens: 64_000,
    ceilingTokens: 200_000,
    lastActualTokens: 0,
    modelId: 'big-model',
    history: [],
  };
  const c = new BudgetCoordinator(start, {
    ...baseSettings,
    expectedTokensPerTurn: 16_000, // downgrade
    turnNumber: 5,
    modelId: 'small-model',
  });
  // ratio = 16000/64000 = 0.25; provisional = 12500; decayed = 6250
  // clamp magnitude = 0.5 * 16000 = 8000 -> 6250 fits
  // NOT extreme downgrade (16000 == 0.25 * 64000, not strictly <)
  assert.equal(c.getSnapshot().debtTokens, 6_250);
});

test('extreme downgrade resets debt and logs synthetic history entry', () => {
  const start: BudgetSnapshot = {
    debtTokens: 100_000,
    expectedTokens: 200_000,
    ceilingTokens: 400_000,
    lastActualTokens: 0,
    modelId: 'huge',
    history: [],
  };
  const c = new BudgetCoordinator(start, {
    ...baseSettings,
    expectedTokensPerTurn: 8_000, // 8000 < 0.25 * 200000 = 50000 -> reset
    turnNumber: 3,
    modelId: 'tiny',
  });
  assert.equal(c.getSnapshot().debtTokens, 0);
  c.recordComponentActual('x', 8_000);
  const snap = c.finalizeTurn();
  const switchEntry = snap.history.find((h) => h.modelSwitch);
  assert.ok(switchEntry);
  assert.equal(switchEntry!.modelSwitch!.from, 'huge');
  assert.equal(switchEntry!.modelSwitch!.newDebt, 0);
});

test('graph slice emergency trim flag persisted in history', () => {
  const c = new BudgetCoordinator(null, baseSettings);
  c.recordComponentActual('context:graph', 200);
  c.flagGraphSliceEmergencyTrim();
  const snap = c.finalizeTurn();
  assert.equal(snap.history[0].graphSliceEmergencyTrim, true);
});

test('finalize is idempotent', () => {
  const c = new BudgetCoordinator(null, baseSettings);
  c.recordComponentActual('a', 1000);
  const first = c.finalizeTurn();
  // subsequent record-calls are ignored
  c.recordComponentActual('b', 9999);
  const second = c.finalizeTurn();
  assert.equal(first, second);
});

test('estimateTokensFromString uses chars/4 heuristic', () => {
  assert.equal(estimateTokensFromString(''), 0);
  assert.equal(estimateTokensFromString(null), 0);
  assert.equal(estimateTokensFromString('1234'), 1);
  assert.equal(estimateTokensFromString('12345'), 2);
});

test('Phase 2 — BudgetSnapshot is JSON round-trip identical (Plan §9 reload invariant)', () => {
  const c = new BudgetCoordinator(null, baseSettings);
  c.recordComponentActual('tool:read_source_code', 6_500);
  c.recordComponentActual('context:graph', 4_000);
  c.recordComponentActual('context:evidence', 2_000);
  c.flagGraphSliceEmergencyTrim();
  const snap = c.finalizeTurn();
  const roundTripped = JSON.parse(JSON.stringify(snap)) as BudgetSnapshot;
  assert.deepEqual(roundTripped, snap);

  // Hydrating a follow-up turn from the round-tripped snapshot must yield
  // the same pressure label and remaining target as hydrating from the
  // original — that is the §9 byte-for-byte invariant in observable form.
  const next1 = new BudgetCoordinator(snap, { ...baseSettings, turnNumber: 2 });
  const next2 = new BudgetCoordinator(roundTripped, { ...baseSettings, turnNumber: 2 });
  assert.equal(next1.getPressure(), next2.getPressure());
  assert.equal(next1.getContextPressureLabel(), next2.getContextPressureLabel());
  assert.equal(next1.getRemainingTargetTokens(), next2.getRemainingTargetTokens());
});
