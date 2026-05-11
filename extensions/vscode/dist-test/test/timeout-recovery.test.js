"use strict";
/**
 * Unit tests for the timeout / recovery helpers extracted from chat-panel.ts.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const timeout_js_1 = require("../chat-panel/timeout.js");
(0, node_test_1.default)('getLlmTimeoutMs returns Anthropic stream/tool budgets by default', () => {
    strict_1.default.equal((0, timeout_js_1.getLlmTimeoutMs)({ mode: 'stream' }), 90_000);
    strict_1.default.equal((0, timeout_js_1.getLlmTimeoutMs)({ mode: 'tool' }), 120_000);
});
(0, node_test_1.default)('getLlmTimeoutMs uses provider-specific budgets', () => {
    strict_1.default.equal((0, timeout_js_1.getLlmTimeoutMs)({ mode: 'stream', provider: 'openai' }), 150_000);
    strict_1.default.equal((0, timeout_js_1.getLlmTimeoutMs)({ mode: 'tool', provider: 'openai' }), 210_000);
    strict_1.default.equal((0, timeout_js_1.getLlmTimeoutMs)({ mode: 'stream', provider: 'ollama' }), 180_000);
});
(0, node_test_1.default)('getLlmTimeoutMs falls back to REQUEST_TIMEOUT_MS for unknown providers', () => {
    strict_1.default.equal((0, timeout_js_1.getLlmTimeoutMs)({ mode: 'stream', provider: 'unknown' }), timeout_js_1.REQUEST_TIMEOUT_MS);
    strict_1.default.equal((0, timeout_js_1.getLlmTimeoutMs)({ mode: 'tool', provider: 'unknown' }), timeout_js_1.REQUEST_TIMEOUT_MS);
});
(0, node_test_1.default)('getLlmTimeoutMs adds 30s when toolCount > 12', () => {
    const base = (0, timeout_js_1.getLlmTimeoutMs)({ mode: 'tool', provider: 'anthropic' });
    strict_1.default.equal((0, timeout_js_1.getLlmTimeoutMs)({ mode: 'tool', provider: 'anthropic', toolCount: 13 }), base + 30_000);
    strict_1.default.equal((0, timeout_js_1.getLlmTimeoutMs)({ mode: 'tool', provider: 'anthropic', toolCount: 12 }), base);
});
(0, node_test_1.default)('getLlmTimeoutMs reduces budget by 30s when reducedContext=true (floor 60s)', () => {
    strict_1.default.equal((0, timeout_js_1.getLlmTimeoutMs)({ mode: 'stream', provider: 'anthropic', reducedContext: true }), 60_000);
    strict_1.default.equal((0, timeout_js_1.getLlmTimeoutMs)({ mode: 'stream', provider: 'openai', reducedContext: true }), 120_000);
    strict_1.default.equal((0, timeout_js_1.getLlmTimeoutMs)({ mode: 'stream', provider: 'unknown', reducedContext: true }), 60_000);
});
(0, node_test_1.default)('isTimeoutError matches the canonical timeout error shapes', () => {
    strict_1.default.equal((0, timeout_js_1.isTimeoutError)(new Error('LLM request timed out after 90s')), true);
    strict_1.default.equal((0, timeout_js_1.isTimeoutError)(new Error('Request timed out')), true);
    strict_1.default.equal((0, timeout_js_1.isTimeoutError)('LLM request timed out after 120s'), true);
});
(0, node_test_1.default)('isTimeoutError ignores unrelated errors', () => {
    strict_1.default.equal((0, timeout_js_1.isTimeoutError)(new Error('429 rate limited')), false);
    strict_1.default.equal((0, timeout_js_1.isTimeoutError)(new Error('network error')), false);
    strict_1.default.equal((0, timeout_js_1.isTimeoutError)(null), false);
    strict_1.default.equal((0, timeout_js_1.isTimeoutError)(undefined), false);
});
(0, node_test_1.default)('buildTimeoutRecoveryPrompt prepends the original text and recovery instructions', () => {
    const prompt = (0, timeout_js_1.buildTimeoutRecoveryPrompt)('summarize the data model');
    strict_1.default.match(prompt, /^summarize the data model\n/);
    strict_1.default.match(prompt, /Continue using an alternative method because the previous LLM request timed out\./);
    strict_1.default.match(prompt, /1\. Prefer the knowledge graph over long source reads\./);
    strict_1.default.match(prompt, /2\. Use at most 8 recent messages of history\./);
    strict_1.default.match(prompt, /3\. Avoid broad tool use unless strictly necessary\./);
    strict_1.default.match(prompt, /4\. Produce a concise useful result first/);
});
(0, node_test_1.default)('createTimeoutAbortSignal aborts when the timer fires', async () => {
    const parent = new AbortController();
    const handle = (0, timeout_js_1.createTimeoutAbortSignal)(parent, 30);
    await new Promise((resolve) => setTimeout(resolve, 60));
    strict_1.default.equal(handle.signal.aborted, true);
    const reason = handle.signal.reason;
    strict_1.default.ok(reason instanceof Error);
    strict_1.default.match(reason.message, /timed out after 0\.03s/);
    handle.dispose();
});
(0, node_test_1.default)('createTimeoutAbortSignal aborts when the parent signal aborts', () => {
    const parent = new AbortController();
    const handle = (0, timeout_js_1.createTimeoutAbortSignal)(parent, 60_000);
    strict_1.default.equal(handle.signal.aborted, false);
    parent.abort('User stopped generation');
    strict_1.default.equal(handle.signal.aborted, true);
    strict_1.default.equal(handle.signal.reason, 'User stopped generation');
    handle.dispose();
});
(0, node_test_1.default)('createTimeoutAbortSignal aborts immediately if parent already aborted', () => {
    const parent = new AbortController();
    parent.abort('already gone');
    const handle = (0, timeout_js_1.createTimeoutAbortSignal)(parent, 60_000);
    strict_1.default.equal(handle.signal.aborted, true);
    strict_1.default.equal(handle.signal.reason, 'already gone');
    handle.dispose();
});
(0, node_test_1.default)('createTimeoutAbortSignal works without a parent controller', async () => {
    const handle = (0, timeout_js_1.createTimeoutAbortSignal)(null, 20);
    await new Promise((resolve) => setTimeout(resolve, 50));
    strict_1.default.equal(handle.signal.aborted, true);
    handle.dispose();
});
(0, node_test_1.default)('createTimeoutAbortSignal dispose() clears the timer (no late aborts)', async () => {
    const parent = new AbortController();
    const handle = (0, timeout_js_1.createTimeoutAbortSignal)(parent, 20);
    handle.dispose();
    await new Promise((resolve) => setTimeout(resolve, 50));
    strict_1.default.equal(handle.signal.aborted, false);
});
const chatPanelSource = node_fs_1.default.readFileSync(node_path_1.default.resolve(process.cwd(), 'src/chat-panel.ts'), 'utf8');
(0, node_test_1.default)('chat-panel.ts imports from chat-panel/timeout.ts', () => {
    strict_1.default.match(chatPanelSource, /from\s+'\.\/chat-panel\/timeout\.js'/);
});
(0, node_test_1.default)('chat-panel.ts still calls _getLlmTimeoutMs and _createRequestSignal at the streaming + tool sites', () => {
    strict_1.default.match(chatPanelSource, /this\._createRequestSignal\(this\._getLlmTimeoutMs\(\{\s*mode:\s*'stream'\s*\}\)\)/);
    strict_1.default.match(chatPanelSource, /this\._getLlmTimeoutMs\(\{\s*mode:\s*'tool',\s*toolCount:\s*tools\.length\s*\}\)/);
});
(0, node_test_1.default)('chat-panel.ts still invokes the recovery flow on stream timeouts', () => {
    strict_1.default.match(chatPanelSource, /this\._recoverFromLlmTimeout\(/);
});
//# sourceMappingURL=timeout-recovery.test.js.map