import test from 'node:test';
import assert from 'node:assert/strict';
import { detectArchitectLens, lensLabel } from '../architect-lens.js';

test('detectArchitectLens — silent default for empty / trivial prompts', () => {
  assert.equal(detectArchitectLens({ prompt: '', intentMode: 'active_file' }).lens, 'generic');
  assert.equal(
    detectArchitectLens({ prompt: 'rename variable foo to bar', intentMode: 'active_file' }).material,
    false,
  );
  assert.equal(
    detectArchitectLens({ prompt: 'fix typo in comment', intentMode: 'active_file' }).lens,
    'generic',
  );
});

test('detectArchitectLens — performance keywords select performance lens', () => {
  const result = detectArchitectLens({
    prompt: 'this query is slow, can we optimize the bottleneck?',
    intentMode: 'active_file',
  });
  assert.equal(result.lens, 'performance');
  assert.equal(result.material, true);
  assert.ok(result.confidence >= 0.6);
  assert.match(result.reason, /slow|optimize|bottleneck/);
});

test('detectArchitectLens — security keywords select security lens', () => {
  const result = detectArchitectLens({
    prompt: 'audit this auth handler for jwt vulnerabilities',
    intentMode: 'active_file',
  });
  assert.equal(result.lens, 'security');
  assert.equal(result.material, true);
});

test('detectArchitectLens — refactor keywords select refactor lens', () => {
  const result = detectArchitectLens({
    prompt: 'extract this duplicated block and clean up the helper',
    intentMode: 'active_file',
  });
  assert.equal(result.lens, 'refactor');
});

test('detectArchitectLens — debug keywords select debug lens', () => {
  const result = detectArchitectLens({
    prompt: 'why does this throw an exception? help me debug the stack trace',
    intentMode: 'active_file',
  });
  assert.equal(result.lens, 'debug');
});

test('detectArchitectLens — review keywords select review lens', () => {
  const result = detectArchitectLens({
    prompt: 'please code review this PR and flag any smell',
    intentMode: 'active_file',
  });
  assert.equal(result.lens, 'review');
});

test('detectArchitectLens — reliability keywords select reliability lens', () => {
  const result = detectArchitectLens({
    prompt: 'add a retry with timeout to make this idempotent',
    intentMode: 'active_file',
  });
  assert.equal(result.lens, 'reliability');
});

test('detectArchitectLens — explanatory ask_dreamgraph downgrades weak performance hits', () => {
  // Single keyword "optimize" at base 0.7 — gets downgraded under ask_dreamgraph
  // unless lens is debug/security/review.
  const result = detectArchitectLens({
    prompt: 'how does the planner optimize evidence selection?',
    intentMode: 'ask_dreamgraph',
  });
  assert.equal(result.lens, 'generic');
});

test('detectArchitectLens — security stays material under ask_dreamgraph', () => {
  const result = detectArchitectLens({
    prompt: 'how does authorization flow protect against injection?',
    intentMode: 'ask_dreamgraph',
  });
  assert.equal(result.lens, 'security');
});

test('detectArchitectLens — command source forces lens even without keywords', () => {
  const result = detectArchitectLens({
    prompt: 'do the thing',
    intentMode: 'active_file',
    commandSource: 'nightmareCycle',
  });
  assert.equal(result.lens, 'security');
  assert.ok(result.confidence >= 0.85);
});

test('lensLabel — capitalised display labels', () => {
  assert.equal(lensLabel('performance'), 'Performance');
  assert.equal(lensLabel('security'), 'Security');
  assert.equal(lensLabel('generic'), 'Generic');
});
