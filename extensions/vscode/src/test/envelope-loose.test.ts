import test from 'node:test';
import assert from 'node:assert/strict';
import { tryParseEnvelope, normalizeLooseEnvelope, isEnvelopeShape } from '../envelope-utils.js';

test('normalizes nested-summary envelope drift (autonomy + summary wrapper)', () => {
  const raw = JSON.stringify({
    autonomy: { completed: 1, remaining: 0, total_authorized: 1 },
    summary: {
      discovered: ['Health ok at foundation', 'Ops visibility weak'],
      changed: ['Appended Health Report section to plans/X.md'],
      current_state: ['Report exists in plans/'],
      recommended_next_step: 'Create dedicated standalone plan/report file',
    },
  });
  const env = tryParseEnvelope(raw);
  assert.ok(env, 'envelope should be recognized after normalization');
  assert.equal(typeof env!.summary, 'string');
  assert.match(env!.summary as string, /Discovered:/);
  assert.match(env!.summary as string, /Changed:/);
  assert.equal(env!.recommended_next_steps?.length, 1);
  assert.equal(env!.recommended_next_steps?.[0]?.label, 'Create dedicated standalone plan/report file');
});

test('promotes singular recommended_next_step to plural array', () => {
  const obj = {
    summary: 'flat summary',
    goal_status: 'partial',
    recommended_next_step: 'Do the thing',
  };
  const normalized = normalizeLooseEnvelope(obj) as Record<string, unknown>;
  assert.ok(isEnvelopeShape(normalized));
  const steps = normalized.recommended_next_steps as Array<{ label: string }>;
  assert.equal(steps.length, 1);
  assert.equal(steps[0].label, 'Do the thing');
});

test('preserves canonical envelope unchanged', () => {
  const canonical = {
    summary: 'all good',
    goal_status: 'complete' as const,
    recommended_next_steps: [{ id: 'a', label: 'A' }],
  };
  const env = tryParseEnvelope(JSON.stringify(canonical));
  assert.ok(env);
  assert.equal(env!.summary, 'all good');
  assert.equal(env!.recommended_next_steps?.[0]?.label, 'A');
});
