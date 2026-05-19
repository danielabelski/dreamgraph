"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
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
    const paths = (0, autonomy_loop_js_1.extractProseAnchorPaths)('Patch a/b.ts and modify c/d.ts then patch a/b.ts again');
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
(0, node_test_1.default)('post-anchor re-reading does NOT trigger a two-strike token-economy STOP', () => {
    // The architectural decision is "no failure: keep going until done".
    // Re-reading after an anchor was the canonical token-waste pattern, but
    // the remedy is structural pressure — NOT a hard stop in
    // shouldContinueAfterPass. This test pins the contract: whatever the
    // decision is on a locate-only post-anchor pass, the reason must NEVER
    // mention the deprecated token-economy STOP rule.
    const state = (0, autonomy_js_1.createAutonomyState)('autonomous', 8);
    const p1 = (0, autonomy_loop_js_1.analyzePass)(state, {
        content: 'Plan: patch a/b.ts to add the branch.',
        toolCallCount: 1,
        fileEditCount: 0,
        toolNames: ['read_file'],
    });
    strict_1.default.equal(p1.patchAnchorEstablished, true);
    strict_1.default.doesNotMatch(p1.decision.reason ?? '', /token-economy stop/i);
});
//# sourceMappingURL=autonomy-token-economy.test.js.map