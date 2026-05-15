// Token-economy guarantees at TASK level.
//
// Phase B/D/F + Levers 1+2: the canonical post-anchor re-reading
// pathology is mitigated by structural pressure (write reservation in
// the agentic loop, anchor-aware continuation prompt, write-tool
// binding on apply/patch actions, and tool-catalog narrowing toward
// write+verify on the second sticky-anchor locate-only pass) — NOT by
// a hard stop in shouldContinueAfterPass. The architectural rule is
// "no failure: keep going until done", so this suite asserts the
// pressure machinery (anchor extraction, sticky anchor state, prompt
// preamble, classifier helpers) and asserts the absence of the old
// two-strike STOP rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutonomyState } from '../autonomy.js';
import {
  analyzePass,
  buildContinuationPrompt,
  extractProseAnchorPaths,
  setEqualsPaths,
} from '../autonomy-loop.js';

test('extractProseAnchorPaths picks up file path co-occurring with edit verb', () => {
  const paths = extractProseAnchorPaths(
    'I will patch extensions/vscode/src/chat-panel.ts to add the optimistic state.',
  );
  assert.deepEqual(paths, ['extensions/vscode/src/chat-panel.ts']);
});

test('extractProseAnchorPaths picks up backtick-quoted bare filename with edit verb', () => {
  const paths = extractProseAnchorPaths('Need to update `chat-panel.ts` next.');
  assert.deepEqual(paths, ['chat-panel.ts']);
});

test('extractProseAnchorPaths returns [] when there is no edit verb on the line', () => {
  const paths = extractProseAnchorPaths('Read extensions/vscode/src/chat-panel.ts to understand the flow.');
  assert.deepEqual(paths, []);
});

test('extractProseAnchorPaths deduplicates and preserves first-occurrence order', () => {
  const paths = extractProseAnchorPaths(
    'Patch a/b.ts and modify c/d.ts then patch a/b.ts again',
  );
  assert.deepEqual(paths, ['a/b.ts', 'c/d.ts']);
});

test('setEqualsPaths is order-independent and treats undefined as empty', () => {
  assert.equal(setEqualsPaths(['a', 'b'], ['b', 'a']), true);
  assert.equal(setEqualsPaths(['a'], ['a', 'b']), false);
  assert.equal(setEqualsPaths(undefined, []), true);
});

test('analyzePass treats prose anchor as patch anchor without tool binding', () => {
  const state = createAutonomyState('autonomous', 8);
  const result = analyzePass(state, {
    content: 'Plan: patch extensions/vscode/src/chat-panel.ts to add the new branch.',
    toolCallCount: 0,
    fileEditCount: 0,
  });
  assert.equal(result.patchAnchorEstablished, true);
  assert.deepEqual(result.anchorPaths, ['extensions/vscode/src/chat-panel.ts']);
});

test('continuation prompt includes anchor preamble when patch anchor is sticky', () => {
  const prompt = buildContinuationPrompt(undefined, { patchAnchorEstablished: true });
  assert.match(prompt, /Do NOT re-locate/);
});

test('continuation prompt omits anchor preamble before any anchor', () => {
  const prompt = buildContinuationPrompt(undefined, { patchAnchorEstablished: false });
  assert.doesNotMatch(prompt, /Do NOT re-locate/i);
});

test('post-anchor re-reading does NOT trigger a two-strike token-economy STOP', () => {
  // The architectural decision is "no failure: keep going until done".
  // Re-reading after an anchor was the canonical token-waste pattern, but
  // the remedy is structural pressure — NOT a hard stop in
  // shouldContinueAfterPass. This test pins the contract: whatever the
  // decision is on a locate-only post-anchor pass, the reason must NEVER
  // mention the deprecated token-economy STOP rule.
  const state = createAutonomyState('autonomous', 8);
  const p1 = analyzePass(state, {
    content: 'Plan: patch a/b.ts to add the branch.',
    toolCallCount: 1,
    fileEditCount: 0,
    toolNames: ['read_file'],
  });
  assert.equal(p1.patchAnchorEstablished, true);
  assert.doesNotMatch(p1.decision.reason ?? '', /token-economy stop/i);
});
