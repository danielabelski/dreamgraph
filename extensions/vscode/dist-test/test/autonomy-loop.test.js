"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const autonomy_js_1 = require("../autonomy.js");
const autonomy_loop_js_1 = require("../autonomy-loop.js");
(0, node_test_1.default)('inferPassOutcomeSignal detects goal completion and stalled progress markers', () => {
    const done = (0, autonomy_loop_js_1.inferPassOutcomeSignal)('Done and verified. Ready for commit.');
    strict_1.default.equal(done.goalSufficientlyReached, true);
    const toolOnly = (0, autonomy_loop_js_1.inferPassOutcomeSignal)('18 DreamGraph tool calls completed successfully, but the report is still missing.');
    strict_1.default.equal(toolOnly.goalSufficientlyReached, false);
    const stalled = (0, autonomy_loop_js_1.inferPassOutcomeSignal)('Stalled progress. Cannot proceed.');
    strict_1.default.equal(stalled.progressStatus, 'stalled');
});
(0, node_test_1.default)('inferPassOutcomeSignal detects awaiting-user prose at the message tail', () => {
    // Trailing question mark.
    const q = (0, autonomy_loop_js_1.inferPassOutcomeSignal)('I rebuilt the bridge. Should I proceed with the deployment step?');
    strict_1.default.equal(q.awaitingUserInput, true);
    // "Let me know" sign-off.
    const lmk = (0, autonomy_loop_js_1.inferPassOutcomeSignal)('All changes applied. Let me know if you want me to also update the docs.');
    strict_1.default.equal(lmk.awaitingUserInput, true);
    // "Would you like me to" handoff.
    const wyl = (0, autonomy_loop_js_1.inferPassOutcomeSignal)('Patch is ready. Would you like me to commit it?');
    strict_1.default.equal(wyl.awaitingUserInput, true);
    // Plain progress prose must NOT trip the detector.
    const plain = (0, autonomy_loop_js_1.inferPassOutcomeSignal)('Edited the file and ran the tests. Recommended next step: run the build.');
    strict_1.default.equal(plain.awaitingUserInput, false);
});
(0, node_test_1.default)('analyzePass pauses for user input when the assistant asks a question, even with action chips', () => {
    const state = (0, autonomy_js_1.createAutonomyState)('autonomous', 4);
    const result = (0, autonomy_loop_js_1.analyzePass)(state, {
        content: 'I prepared two patches. Which option would you like me to apply?',
        actions: [
            { id: 'a', label: 'Apply patch A', priority: 1, eligible: true, withinScope: true },
            { id: 'b', label: 'Apply patch B', priority: 2, eligible: true, withinScope: true },
        ],
    });
    strict_1.default.equal(result.decision.shouldContinue, false);
    strict_1.default.match(result.decision.reason, /awaiting user input/i);
    strict_1.default.equal(result.decision.selectionMode, 'user');
});
(0, node_test_1.default)('analyzePass selects continuation prompt when autonomous mode has a strong next step', () => {
    const state = (0, autonomy_js_1.createAutonomyState)('autonomous', 4);
    const result = (0, autonomy_loop_js_1.analyzePass)(state, {
        content: 'Implemented a structural next slice. Recommended next step: add clickable recommended actions.',
        actions: [{ id: 'next', label: 'Add clickable recommended actions', priority: 1, eligible: true, withinScope: true }],
    });
    strict_1.default.equal(result.decision.shouldContinue, true);
    strict_1.default.equal(result.selectedActionId, 'next');
    strict_1.default.match(result.nextPrompt ?? '', /Add clickable recommended actions/);
});
(0, node_test_1.default)('analyzePass stops when goal is sufficiently reached', () => {
    const state = (0, autonomy_js_1.createAutonomyState)('autonomous', 4);
    const result = (0, autonomy_loop_js_1.analyzePass)(state, {
        content: 'Done and verified. Ready for commit.',
    });
    strict_1.default.equal(result.decision.shouldContinue, false);
    strict_1.default.match(result.decision.reason, /goal sufficiently reached/i);
});
(0, node_test_1.default)('analyzePass lets partial structured envelope override broad completion prose', () => {
    const state = (0, autonomy_js_1.createAutonomyState)('eager', 20);
    const result = (0, autonomy_loop_js_1.analyzePass)(state, {
        content: 'The pass gathered evidence through 18 DreamGraph calls completed successfully, but the final adapter assessment remains undelivered.',
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
    strict_1.default.equal(result.signal.goalSufficientlyReached, false);
    strict_1.default.doesNotMatch(result.decision.reason, /goal sufficiently reached/i);
});
(0, node_test_1.default)('advanceAutonomyStateIfContinued decrements visible counters only when continuing', () => {
    const state = (0, autonomy_js_1.createAutonomyState)('autonomous', 4);
    const continued = (0, autonomy_loop_js_1.advanceAutonomyStateIfContinued)(state, { shouldContinue: true, reason: 'continue', selectionMode: 'self' });
    strict_1.default.equal(continued.completedAutoPasses, 1);
    strict_1.default.equal(continued.remainingAutoPasses, 3);
    const paused = (0, autonomy_loop_js_1.advanceAutonomyStateIfContinued)(state, { shouldContinue: false, reason: 'stop', selectionMode: 'none' });
    strict_1.default.equal(paused.completedAutoPasses, 0);
    strict_1.default.equal(paused.remainingAutoPasses, 4);
});
(0, node_test_1.default)('analyzePass marks pure-read pass as empty once patch anchor is established', () => {
    // First pass: model writes a file → anchor established.
    const state0 = (0, autonomy_js_1.createAutonomyState)('autonomous', 8);
    const writePass = (0, autonomy_loop_js_1.analyzePass)(state0, {
        content: 'Applied patch.',
        toolCallCount: 1,
        fileEditCount: 1,
        toolNames: ['edit_file'],
    });
    strict_1.default.equal(writePass.patchAnchorEstablished, true);
    const state1 = (0, autonomy_loop_js_1.advanceAutonomyStateIfContinued)(state0, writePass.decision, writePass.signal, writePass.patchAnchorEstablished);
    strict_1.default.equal(state1.patchAnchorEstablished, true);
    // Second pass: only read tools, no edits → must register as empty.
    const readPass = (0, autonomy_loop_js_1.analyzePass)(state1, {
        content: 'Re-confirming the anchor by reading source again.',
        toolCallCount: 2,
        fileEditCount: 0,
        toolNames: ['read_file', 'grep_search'],
    });
    strict_1.default.equal(readPass.signal.isEmptyPass, true);
    // Third consecutive pure-read pass should trip the empty-pass guard and stop.
    const state2 = (0, autonomy_loop_js_1.advanceAutonomyStateIfContinued)(state1, readPass.decision, readPass.signal, readPass.patchAnchorEstablished);
    const readPass2 = (0, autonomy_loop_js_1.analyzePass)(state2, {
        content: 'Reading more.',
        toolCallCount: 1,
        fileEditCount: 0,
        toolNames: ['read_file'],
    });
    strict_1.default.equal(readPass2.signal.isEmptyPass, true);
    strict_1.default.equal(readPass2.decision.shouldContinue, false);
});
(0, node_test_1.default)('analyzePass does not mark read-only pass as empty before any anchor', () => {
    const state = (0, autonomy_js_1.createAutonomyState)('autonomous', 8);
    const result = (0, autonomy_loop_js_1.analyzePass)(state, {
        content: 'Initial exploration to find the patch site.',
        toolCallCount: 2,
        fileEditCount: 0,
        toolNames: ['grep_search', 'read_file'],
    });
    strict_1.default.equal(result.patchAnchorEstablished, false);
    strict_1.default.equal(result.signal.isEmptyPass, false);
});
//# sourceMappingURL=autonomy-loop.test.js.map