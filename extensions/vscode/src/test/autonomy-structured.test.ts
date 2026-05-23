import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecommendedActionSetFromContent, extractStructuredPassEnvelope } from '../autonomy-structured.js';

test('extracts actions from recommended next steps section', () => {
  const content = [
    '## Recommended next steps',
    '- Add persistent header',
    '- Wire action dispatch',
  ].join('\n');

  const envelope = extractStructuredPassEnvelope(content);
  assert.equal(envelope.nextSteps.length, 2);
  assert.equal(envelope.nextSteps[0].label, 'Add persistent header');
});

test('prefers structured json envelope when present', () => {
  const content = [
    'Human explanation here',
    '```json',
    JSON.stringify({
      summary: 'Did the thing',
      goal_status: 'partial',
      progress_status: 'advancing',
      uncertainty: 'low',
      recommended_next_steps: [
        { id: 'ship-it', label: 'Ship it', priority: 1, eligible: true, within_scope: true, batch_group: 'release' }
      ]
    }, null, 2),
    '```',
    '## Recommended next steps',
    '- Fallback action that should not win'
  ].join('\n');

  const envelope = extractStructuredPassEnvelope(content);
  assert.equal(envelope.summary, 'Did the thing');
  assert.equal(envelope.nextSteps.length, 1);
  assert.equal(envelope.nextSteps[0].id, 'ship-it');
  assert.equal(envelope.nextSteps[0].batchGroup, 'release');
});

test('does not infer complete from successful tool-call prose alone', () => {
  const envelope = extractStructuredPassEnvelope(
    'The pass gathered evidence through 18 DreamGraph calls completed successfully, but the final adapter assessment remains undelivered.\n\nRecommended next step: Synthesize adapter state report',
  );

  assert.equal(envelope.goalStatus, 'partial');
  assert.equal(envelope.nextSteps[0]?.label, 'Synthesize adapter state report');
});

test('ranks actions from assistant output', () => {
  const content = [
    '## Recommended next steps',
    '1. Mount persistent header',
    '2. Add clickable chips',
  ].join('\n');

  const set = buildRecommendedActionSetFromContent(content);
  assert.equal(set.actions.length, 2);
  assert.equal(set.topActionId, set.actions[0].id);
});

test('preserves structured action blockers and requirements', () => {
  const content = [
    '```json',
    JSON.stringify({
      summary: 'Marketplace publish is blocked',
      goal_status: 'blocked',
      progress_status: 'stalled',
      uncertainty: 'low',
      recommended_next_steps: [
        {
          id: 'publish',
          label: 'Publish VSIX to VS Code Marketplace',
          eligible: false,
          within_scope: true,
          requires_secrets: ['VSCE_PAT'],
          blockers: [{ id: 'missing-pat', kind: 'missing_secret', label: 'Requires VSCE_PAT.' }],
        },
      ],
    }),
    '```',
  ].join('\n');

  const envelope = extractStructuredPassEnvelope(content);
  assert.equal(envelope.nextSteps[0].requiresSecrets?.[0], 'VSCE_PAT');
  assert.equal(envelope.nextSteps[0].blockers?.[0]?.kind, 'missing_secret');
  assert.equal(buildRecommendedActionSetFromContent(content).actions.length, 0);
});
