import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveVerdict, type ToolTraceEntry } from '../chat-panel/helpers.js';

function completedTrace(count: number): ToolTraceEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    tool: 'dreamgraph:query_resource',
    argsSummary: `uri ${index}`,
    filesAffected: [],
    durationMs: 5,
    status: 'completed' as const,
  }));
}

test('deriveVerdict treats completed tool calls without delivered answer as partial progress', () => {
  const verdict = deriveVerdict(
    'Pass aborted: [CANCELLED] Codex CLI run was cancelled by the host',
    completedTrace(40),
  );

  assert.equal(verdict.level, 'partial');
  assert.match(verdict.summary, /Partial progress: 40 executed tool calls/);
  assert.doesNotMatch(verdict.summary, /Verified with/);
});

test('deriveVerdict keeps completed audited work partial when report says requested assessment remains incomplete', () => {
  const verdict = deriveVerdict(
    'This run did not complete an adapter assessment. The assessment remains incomplete.',
    completedTrace(40),
  );

  assert.equal(verdict.level, 'partial');
  assert.match(verdict.summary, /final completion was not established/);
});

test('deriveVerdict requires completion signal before showing verified tool-count banner', () => {
  const verdict = deriveVerdict(
    'Assessment delivered.\n\n```json\n{"goal_status":"complete","progress_status":"advancing","uncertainty":"low"}\n```',
    completedTrace(2),
  );

  assert.equal(verdict.level, 'verified');
  assert.equal(verdict.summary, 'Verified with 2 executed tool calls.');
});

test('deriveVerdict honors partial structured envelope over successful tool trace', () => {
  const verdict = deriveVerdict(
    'Investigated the adapter, but no final assessment was delivered.\n\n```json\n{"goal_status":"partial","progress_status":"stalled","uncertainty":"high"}\n```',
    completedTrace(45),
  );

  assert.equal(verdict.level, 'partial');
  assert.match(verdict.summary, /Partial progress: 45 executed tool calls/);
});
