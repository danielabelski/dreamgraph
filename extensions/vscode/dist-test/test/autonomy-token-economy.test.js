"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const autonomy_js_1 = require("../autonomy.js");
const autonomy_loop_js_1 = require("../autonomy-loop.js");
(0, node_test_1.default)('extractProseAnchorPaths picks up file path co-occurring with edit verb', () => {
    const paths = (0, autonomy_loop_js_1.extractProseAnchorPaths)('I will patch extensions/vscode/src/chat-panel.ts to add the optimistic state.');
    strict_1.default.deepEqual(paths, ['extensions/vscode/src/chat-panel.ts']);
});
(0, node_test_1.default)('extractProseAnchorPaths picks up backtick-quoted bare filename with edit verb', () => {
    const paths = (0, autonomy_loop_js_1.extractProseAnchorPaths)('Need to update `chat-panel.ts` next.');
    strict_1.default.deepEqual(paths, ['chat-panel.ts']);
});
(0, node_test_1.default)('extractProseAnchorPaths returns [] when there is no edit verb on the line', () => {
    const paths = (0, autonomy_loop_js_1.extractProseAnchorPaths)('Read extensions/vscode/src/chat-panel.ts to understand the flow.');
    strict_1.default.deepEqual(paths, []);
});
(0, node_test_1.default)('extractProseAnchorPaths deduplicates and preserves first-occurrence order', () => {
    const paths = (0, autonomy_loop_js_1.extractProseAnchorPaths)('Patch a/b.ts and modify c/d.ts. Then patch a/b.ts again.');
    strict_1.default.deepEqual(paths, ['a/b.ts', 'c/d.ts']);
});
(0, node_test_1.default)('setEqualsPaths is order-independent and treats undefined as empty', () => {
    strict_1.default.equal((0, autonomy_loop_js_1.setEqualsPaths)(['a', 'b'], ['b', 'a']), true);
    strict_1.default.equal((0, autonomy_loop_js_1.setEqualsPaths)(['a'], ['a', 'b']), false);
    strict_1.default.equal((0, autonomy_loop_js_1.setEqualsPaths)(undefined, []), true);
});
(0, node_test_1.default)('analyzePass treats prose anchor as patch anchor without tool binding', () => {
    const state = (0, autonomy_js_1.createAutonomyState)('autonomous', 8);
    const result = (0, autonomy_loop_js_1.analyzePass)(state, {
        content: 'Plan: patch extensions/vscode/src/chat-panel.ts to add the new branch.',
        toolCallCount: 0,
        fileEditCount: 0,
    });
    strict_1.default.equal(result.patchAnchorEstablished, true);
    strict_1.default.deepEqual(result.anchorPaths, ['extensions/vscode/src/chat-panel.ts']);
});
(0, node_test_1.default)('continuation prompt includes anchor preamble when patch anchor is sticky', () => {
    const prompt = (0, autonomy_loop_js_1.buildContinuationPrompt)(undefined, { patchAnchorEstablished: true });
    strict_1.default.match(prompt, /Do NOT re-locate/);
});
(0, node_test_1.default)('continuation prompt omits anchor preamble before any anchor', () => {
    const prompt = (0, autonomy_loop_js_1.buildContinuationPrompt)(undefined, { patchAnchorEstablished: false });
    strict_1.default.doesNotMatch(prompt, /Do NOT re-locate/i);
});
(0, node_test_1.default)('two-strike token-economy stop fires on second consecutive locate-only pass with same anchor', () => {
    const state = (0, autonomy_js_1.createAutonomyState)('autonomous', 8);
    // Pass 1: prose anchor + zero writes → anchor established, locate-only.
    const p1 = (0, autonomy_loop_js_1.analyzePass)(state, {
        content: 'Plan: patch a/b.ts to add the new branch.',
        toolCallCount: 1,
        fileEditCount: 0,
        toolNames: ['read_file'],
    });
    strict_1.default.equal(p1.patchAnchorEstablished, true);
    strict_1.default.equal(p1.isLocateOnlyThisPass, true);
    const state1 = (0, autonomy_loop_js_1.advanceAutonomyStateIfContinued)(state, p1.decision, p1.signal, p1.patchAnchorEstablished, p1.anchorPaths, p1.isLocateOnlyThisPass);
    strict_1.default.equal(state1.lastPassWasLocateOnly, true);
    strict_1.default.deepEqual(state1.lastAnchorPaths, ['a/b.ts']);
    // Pass 2: still locate-only, same anchor, no new blocker → must stop.
    const p2 = (0, autonomy_loop_js_1.analyzePass)(state1, {
        content: 'Re-reading a/b.ts to confirm the patch site.',
        toolCallCount: 1,
        fileEditCount: 0,
        toolNames: ['read_file'],
    });
    strict_1.default.equal(p2.decision.shouldContinue, false);
    strict_1.default.match(p2.decision.reason, /token-economy stop/i);
    strict_1.default.equal(p2.decision.selectionMode, 'user');
});
(0, node_test_1.default)('two-strike rule allows continuation when anchor moves to a different file', () => {
    const state = (0, autonomy_js_1.createAutonomyState)('autonomous', 8);
    const p1 = (0, autonomy_loop_js_1.analyzePass)(state, {
        content: 'Plan: patch a/b.ts to add the branch.',
        toolCallCount: 1,
        fileEditCount: 0,
        toolNames: ['read_file'],
    });
    const state1 = (0, autonomy_loop_js_1.advanceAutonomyStateIfContinued)(state, p1.decision, p1.signal, p1.patchAnchorEstablished, p1.anchorPaths, p1.isLocateOnlyThisPass);
    // Pass 2: anchor moved to a different file → legitimate re-anchor, continue.
    const p2 = (0, autonomy_loop_js_1.analyzePass)(state1, {
        content: 'Actually we should patch c/d.ts instead — found the real site.',
        toolCallCount: 1,
        fileEditCount: 0,
        toolNames: ['read_file'],
    });
    // Must NOT trip the token-economy stop (different anchor → not waste).
    strict_1.default.notEqual(p2.decision.reason, undefined);
    strict_1.default.doesNotMatch(p2.decision.reason ?? '', /token-economy stop/i);
});
(0, node_test_1.default)('two-strike rule allows continuation when a NEW blocker is reported', () => {
    // Use shouldContinueAfterPass directly — we synthesize state where the
    // prior pass was locate-only with a sticky anchor, the current pass is
    // also locate-only with the same anchor, but a new blocker is reported.
    const state = {
        ...(0, autonomy_js_1.createAutonomyState)('autonomous', 8),
        patchAnchorEstablished: true,
        lastPassWasLocateOnly: true,
        lastAnchorPaths: ['a/b.ts'],
    };
    const decision = (0, autonomy_js_1.shouldContinueAfterPass)(state, {
        goalSufficientlyReached: false,
        hasClearNextStep: true,
        hasBlockingFailure: false,
        isEmptyPass: false,
        progressStatus: 'advancing',
        uncertainty: 'low',
        nextStepWithinScope: true,
    }, { actions: [], doAllEligible: false, topActionId: undefined }, {
        writeToolCalls: 0,
        fileEdits: 0,
        currentAnchorPaths: ['a/b.ts'],
        newBlockerReported: true,
    });
    // newBlockerReported bypasses the token-economy stop → must continue.
    strict_1.default.doesNotMatch(decision.reason, /token-economy stop/i);
});
//# sourceMappingURL=autonomy-token-economy.test.js.map