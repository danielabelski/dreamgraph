import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutonomyState } from '../autonomy.js';
import { advanceAutonomyStateIfContinued, analyzePass, inferPassOutcomeSignal } from '../autonomy-loop.js';

test('inferPassOutcomeSignal detects goal completion and stalled progress markers', () => {
  const done = inferPassOutcomeSignal('Done and verified. Ready for commit.');
  assert.equal(done.goalSufficientlyReached, true);
  const toolOnly = inferPassOutcomeSignal('18 DreamGraph tool calls completed successfully, but the report is still missing.');
  assert.equal(toolOnly.goalSufficientlyReached, false);
  const stalled = inferPassOutcomeSignal('Stalled progress. Cannot proceed.');
  assert.equal(stalled.progressStatus, 'stalled');
});

test('inferPassOutcomeSignal detects awaiting-user prose at the message tail', () => {
  // Trailing question mark.
  const q = inferPassOutcomeSignal('I rebuilt the bridge. Should I proceed with the deployment step?');
  assert.equal(q.awaitingUserInput, true);
  // "Let me know" sign-off.
  const lmk = inferPassOutcomeSignal('All changes applied. Let me know if you want me to also update the docs.');
  assert.equal(lmk.awaitingUserInput, true);
  // "Would you like me to" handoff.
  const wyl = inferPassOutcomeSignal('Patch is ready. Would you like me to commit it?');
  assert.equal(wyl.awaitingUserInput, true);
  // Plain progress prose must NOT trip the detector.
  const plain = inferPassOutcomeSignal('Edited the file and ran the tests. Recommended next step: run the build.');
  assert.equal(plain.awaitingUserInput, false);
});

test('analyzePass pauses for user input when the assistant asks a question, even with action chips', () => {
  const state = createAutonomyState('autonomous', 4);
  const result = analyzePass(state, {
    content: 'I prepared two patches. Which option would you like me to apply?',
    actions: [
      { id: 'a', label: 'Apply patch A', priority: 1, eligible: true, withinScope: true },
      { id: 'b', label: 'Apply patch B', priority: 2, eligible: true, withinScope: true },
    ],
  });
  assert.equal(result.decision.shouldContinue, false);
  assert.match(result.decision.reason, /awaiting user input/i);
  assert.equal(result.decision.selectionMode, 'user');
});

test('analyzePass selects continuation prompt when autonomous mode has a strong next step', () => {
  const state = createAutonomyState('autonomous', 4);
  const result = analyzePass(state, {
    content: 'Implemented a structural next slice. Recommended next step: add clickable recommended actions.',
    actions: [{ id: 'next', label: 'Add clickable recommended actions', priority: 1, eligible: true, withinScope: true }],
  });
  assert.equal(result.decision.shouldContinue, true);
  assert.equal(result.selectedActionId, 'next');
  assert.match(result.nextPrompt ?? '', /Add clickable recommended actions/);
});

test('analyzePass stops when goal is sufficiently reached', () => {
  const state = createAutonomyState('autonomous', 4);
  const result = analyzePass(state, {
    content: 'Done and verified. Ready for commit.',
  });
  assert.equal(result.decision.shouldContinue, false);
  assert.match(result.decision.reason, /goal sufficiently reached/i);
});

test('analyzePass lets partial structured envelope override broad completion prose', () => {
  const state = createAutonomyState('eager', 20);
  const result = analyzePass(state, {
    content:
      'The pass gathered evidence through 18 DreamGraph calls completed successfully, but the final adapter assessment remains undelivered.',
    actions: [
      { id: 'synthesize', label: 'Synthesize adapter state report', priority: 1, eligible: true, withinScope: true },
    ],
    envelope: {
      summary: 'Evidence gathered, final report undelivered.',
      goalStatus: 'partial',
      progressStatus: 'advancing',
      uncertainty: 'medium',
      nextSteps: [
        { id: 'synthesize', label: 'Synthesize adapter state report', priority: 1, eligible: true, withinScope: true },
      ],
    },
    toolCallCount: 18,
    toolNames: ['dreamgraph:read_source_code'],
  });

  assert.equal(result.signal.goalSufficientlyReached, false);
  assert.doesNotMatch(result.decision.reason, /goal sufficiently reached/i);
});

test('advanceAutonomyStateIfContinued decrements visible counters only when continuing', () => {
  const state = createAutonomyState('autonomous', 4);
  const continued = advanceAutonomyStateIfContinued(state, { shouldContinue: true, reason: 'continue', selectionMode: 'self' });
  assert.equal(continued.completedAutoPasses, 1);
  assert.equal(continued.remainingAutoPasses, 3);
  const paused = advanceAutonomyStateIfContinued(state, { shouldContinue: false, reason: 'stop', selectionMode: 'none' });
  assert.equal(paused.completedAutoPasses, 0);
  assert.equal(paused.remainingAutoPasses, 4);
});

test('analyzePass marks pure-read pass as empty once patch anchor is established', () => {
  // First pass: model writes a file → anchor established.
  const state0 = createAutonomyState('autonomous', 8);
  const writePass = analyzePass(state0, {
    content: 'Applied patch.',
    toolCallCount: 1,
    fileEditCount: 1,
    toolNames: ['edit_file'],
  });
  assert.equal(writePass.patchAnchorEstablished, true);
  const state1 = advanceAutonomyStateIfContinued(state0, writePass.decision, writePass.signal, writePass.patchAnchorEstablished);
  assert.equal(state1.patchAnchorEstablished, true);

  // Second pass: only read tools, no edits → must register as empty.
  const readPass = analyzePass(state1, {
    content: 'Re-confirming the anchor by reading source again.',
    toolCallCount: 2,
    fileEditCount: 0,
    toolNames: ['read_file', 'grep_search'],
  });
  assert.equal(readPass.signal.isEmptyPass, true);

  // Third consecutive pure-read pass should trip the empty-pass guard and stop.
  const state2 = advanceAutonomyStateIfContinued(state1, readPass.decision, readPass.signal, readPass.patchAnchorEstablished);
  const readPass2 = analyzePass(state2, {
    content: 'Reading more.',
    toolCallCount: 1,
    fileEditCount: 0,
    toolNames: ['read_file'],
  });
  assert.equal(readPass2.signal.isEmptyPass, true);
  assert.equal(readPass2.decision.shouldContinue, false);
});

test('analyzePass does not mark read-only pass as empty before any anchor', () => {
  const state = createAutonomyState('autonomous', 8);
  const result = analyzePass(state, {
    content: 'Initial exploration to find the patch site.',
    toolCallCount: 2,
    fileEditCount: 0,
    toolNames: ['grep_search', 'read_file'],
  });
  assert.equal(result.patchAnchorEstablished, false);
  assert.equal(result.signal.isEmptyPass, false);
});
