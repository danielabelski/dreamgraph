"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const context_cache_js_1 = require("../context-cache.js");
// F-18 scenario 4 — context-builder timeout truncation.
// Pins the F-14 observability surface in ContextCache:
//   - recordTimeout increments per-tool counters monotonically;
//   - getTimeoutStats returns a snapshot with the right keys/values;
//   - isTimeout heuristic matches /timeout|timed out|aborted/i and
//     rejects unrelated errors.
//
// The timeout counter is process-wide (static field). Each test uses a
// freshly-coined tool name so it does not collide with other tests in the
// same process and is not order-dependent.
let counter = 0;
function uniqueTool(prefix) {
    counter += 1;
    return `${prefix}_${process.pid}_${counter}_${Math.random().toString(36).slice(2, 8)}`;
}
(0, node_test_1.default)('recordTimeout increments per-tool counters', () => {
    const tool = uniqueTool('f18_record');
    context_cache_js_1.ContextCache.recordTimeout(tool);
    context_cache_js_1.ContextCache.recordTimeout(tool);
    context_cache_js_1.ContextCache.recordTimeout(tool);
    const stats = context_cache_js_1.ContextCache.getTimeoutStats();
    strict_1.default.equal(stats[tool], 3, 'three recorded timeouts must produce a count of 3');
});
(0, node_test_1.default)('getTimeoutStats returns an independent snapshot — mutating it does not affect the cache', () => {
    const tool = uniqueTool('f18_snapshot');
    context_cache_js_1.ContextCache.recordTimeout(tool);
    const snap = context_cache_js_1.ContextCache.getTimeoutStats();
    strict_1.default.equal(snap[tool], 1);
    // Mutate the snapshot; subsequent reads must not reflect the mutation.
    snap[tool] = 999;
    const fresh = context_cache_js_1.ContextCache.getTimeoutStats();
    strict_1.default.equal(fresh[tool], 1, 'cache state must not be aliased through getTimeoutStats');
});
(0, node_test_1.default)('per-tool counters are independent', () => {
    const a = uniqueTool('f18_a');
    const b = uniqueTool('f18_b');
    context_cache_js_1.ContextCache.recordTimeout(a);
    context_cache_js_1.ContextCache.recordTimeout(a);
    context_cache_js_1.ContextCache.recordTimeout(b);
    const stats = context_cache_js_1.ContextCache.getTimeoutStats();
    strict_1.default.equal(stats[a], 2);
    strict_1.default.equal(stats[b], 1);
});
(0, node_test_1.default)('isTimeout matches the documented timeout/aborted error vocabulary', () => {
    const matches = [
        new Error('Operation timed out after 6000ms'),
        new Error('Request timeout'),
        new Error('AbortError: The operation was aborted'),
        'fetch aborted',
        'TIMEOUT',
    ];
    for (const err of matches) {
        strict_1.default.equal(context_cache_js_1.ContextCache.isTimeout(err), true, `should classify as timeout: ${String(err)}`);
    }
});
(0, node_test_1.default)('isTimeout rejects unrelated errors and falsy values', () => {
    const nonMatches = [
        new Error('ECONNREFUSED'),
        new Error('Invalid response shape'),
        new Error('404 Not Found'),
        'permission denied',
        null,
        undefined,
        '',
        0,
    ];
    for (const err of nonMatches) {
        strict_1.default.equal(context_cache_js_1.ContextCache.isTimeout(err), false, `should NOT classify as timeout: ${err === null ? 'null' : err === undefined ? 'undefined' : String(err)}`);
    }
});
(0, node_test_1.default)('MCP_CONTEXT_FETCH_TIMEOUT_MS is a positive finite number', () => {
    // F-07 baseline ceiling — the value comes from env or defaults to 6_000.
    // We don't pin the exact value (it's overridable), only that it's sane.
    strict_1.default.ok(Number.isFinite(context_cache_js_1.ContextCache.MCP_CONTEXT_FETCH_TIMEOUT_MS));
    strict_1.default.ok(context_cache_js_1.ContextCache.MCP_CONTEXT_FETCH_TIMEOUT_MS > 0);
});
//# sourceMappingURL=context-cache-timeout-truncation.test.js.map