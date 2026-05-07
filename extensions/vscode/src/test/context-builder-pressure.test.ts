/**
 * Phase 3 of NEVER_FAIL_BUDGET_DEBT_PLAN — adaptive trim of deep-insights
 * fetches inside `_resolveGraphContext` based on the BudgetCoordinator's
 * pressure label.
 *
 * The decision is encapsulated in the pure helper `shouldFetchDeepInsight`
 * (exported from `context-builder.ts`) so it can be tested without spinning
 * up the full ContextBuilder (which depends on the `vscode` module).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldFetchDeepInsight } from '../budget-coordinator-reader.js';
import type { ContextEvidenceKind } from '../types.js';

const ALL_DEEP_KINDS: ContextEvidenceKind[] = [
  'causal',
  'temporal',
  'data_model',
  'cognitive_status',
  'feature',
  'workflow',
];

test("Phase 3 — 'low' pressure fetches every deep-insight regardless of required/optional", () => {
  const required = new Set<ContextEvidenceKind>(); // none required
  for (const k of ALL_DEEP_KINDS) {
    assert.equal(shouldFetchDeepInsight(k, required, 'low'), true);
  }
});

test("Phase 3 — 'normal' pressure fetches every deep-insight (tier-2 trim reserved for future)", () => {
  const required = new Set<ContextEvidenceKind>();
  for (const k of ALL_DEEP_KINDS) {
    assert.equal(shouldFetchDeepInsight(k, required, 'normal'), true);
  }
});

test("Phase 3 — 'high' pressure skips optional deep-insights but keeps required ones", () => {
  const required = new Set<ContextEvidenceKind>(['causal', 'data_model']);
  assert.equal(shouldFetchDeepInsight('causal', required, 'high'), true);
  assert.equal(shouldFetchDeepInsight('data_model', required, 'high'), true);
  assert.equal(shouldFetchDeepInsight('temporal', required, 'high'), false);
  assert.equal(shouldFetchDeepInsight('cognitive_status', required, 'high'), false);
  assert.equal(shouldFetchDeepInsight('feature', required, 'high'), false);
  assert.equal(shouldFetchDeepInsight('workflow', required, 'high'), false);
});

test("Phase 3 — 'high' pressure with all-optional needs drops everything", () => {
  const required = new Set<ContextEvidenceKind>();
  for (const k of ALL_DEEP_KINDS) {
    assert.equal(shouldFetchDeepInsight(k, required, 'high'), false);
  }
});

test("Phase 3 — pressure decision is pure (same inputs → same outputs)", () => {
  const required = new Set<ContextEvidenceKind>(['causal']);
  const a = shouldFetchDeepInsight('causal', required, 'high');
  const b = shouldFetchDeepInsight('causal', required, 'high');
  assert.equal(a, b);
});
