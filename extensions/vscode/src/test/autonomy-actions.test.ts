import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRecommendedActionCapabilityGuards,
  chooseActionForMode,
  computeDoAllEligibility,
  rankRecommendedActions,
} from '../autonomy.js';

test('do all eligible only for compatible actions', () => {
  const ranked = rankRecommendedActions([
    { id: 'a1', label: 'One', priority: 1, eligible: true, withinScope: true },
    { id: 'a2', label: 'Two', priority: 2, eligible: true, withinScope: true },
  ]);
  assert.equal(ranked.doAllEligible, true);
});

test('eager selects strongest action under medium uncertainty when defining', () => {
  const ranked = rankRecommendedActions([
    { id: 'a1', label: 'Add clickable actions', priority: 1, eligible: true, withinScope: true },
  ]);
  const selected = chooseActionForMode('eager', ranked, {
    hasClearNextStep: true,
    uncertainty: 'medium',
    hasBlockingFailure: false,
    nextStepWithinScope: true,
    goalSufficientlyReached: false,
    progressStatus: 'advancing',
    nextStepIsDefining: true,
  });
  assert.equal(selected, 'a1');
});

test('capability guards block graph release records without graph-write MCP tool', () => {
  const guarded = applyRecommendedActionCapabilityGuards([
    {
      id: 'record-release',
      label: 'Record v10.6.0 release in DreamGraph knowledge graph',
      priority: 1,
      eligible: true,
      withinScope: true,
    },
  ], { availableToolNames: ['read_local_file'], env: {} });

  assert.equal(guarded[0].eligible, false);
  assert.equal(guarded[0].blockers?.[0]?.kind, 'missing_tool');
  assert.match(guarded[0].blockers?.[0]?.label ?? '', /enrich_seed_data/);
  assert.equal(rankRecommendedActions(guarded).actions.length, 0);
});

test('capability guards allow graph release records when enrich_seed_data is exposed', () => {
  const guarded = applyRecommendedActionCapabilityGuards([
    {
      id: 'record-release',
      label: 'Record v10.6.0 release in DreamGraph knowledge graph',
      priority: 1,
      eligible: true,
      withinScope: true,
    },
  ], { availableToolNames: ['enrich_seed_data'], env: {} });

  assert.equal(guarded[0].eligible, true);
  assert.equal(guarded[0].blockers, undefined);
});

test('capability guards block marketplace publish without VSCE_PAT', () => {
  const guarded = applyRecommendedActionCapabilityGuards([
    {
      id: 'publish',
      label: 'Publish VSIX to VS Code Marketplace',
      priority: 1,
      eligible: true,
      withinScope: true,
    },
  ], { availableToolNames: ['run_command'], env: {} });

  assert.equal(guarded[0].eligible, false);
  assert.equal(guarded[0].blockers?.[0]?.kind, 'missing_secret');
  assert.match(guarded[0].blockers?.[0]?.label ?? '', /VSCE_PAT/);
});

test('capability guards allow marketplace publish when a marketplace PAT is present', () => {
  const guarded = applyRecommendedActionCapabilityGuards([
    {
      id: 'publish',
      label: 'Publish VSIX to VS Code Marketplace',
      priority: 1,
      eligible: true,
      withinScope: true,
    },
  ], { availableToolNames: ['run_command'], env: { VSCE_PAT: 'present' } });

  assert.equal(guarded[0].eligible, true);
  assert.equal(guarded[0].blockers, undefined);
});

test('blocked actions make Do all ineligible', () => {
  const guarded = applyRecommendedActionCapabilityGuards([
    { id: 'safe', label: 'Run focused tests', priority: 1, eligible: true, withinScope: true },
    { id: 'publish', label: 'Publish VSIX to VS Code Marketplace', priority: 2, eligible: true, withinScope: true },
  ], { availableToolNames: ['run_command'], env: {} });

  assert.equal(computeDoAllEligibility(guarded), false);
  assert.equal(rankRecommendedActions(guarded).actions.map((a) => a.id).join(','), 'safe');
});
