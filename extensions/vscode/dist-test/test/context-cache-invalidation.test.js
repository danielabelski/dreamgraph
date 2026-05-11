"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const context_cache_js_1 = require("../context-cache.js");
// F-18 scenario 3 — cache invalidation behaviour.
// Pins the contract that:
//   - every name in COGNITIVE_MUTATING_TOOLS triggers deep-insights eviction
//     via maybeInvalidateForTool;
//   - read-only tool names do NOT trigger eviction;
//   - invalidateDeepInsights drops the slot;
//   - clearAll drops both env-snapshot and deep-insights slots;
//   - getDeepInsightsSlot returns the same instance within its TTL window.
(0, node_test_1.default)('every COGNITIVE_MUTATING_TOOL triggers deep-insights invalidation', () => {
    for (const tool of context_cache_js_1.ContextCache.COGNITIVE_MUTATING_TOOLS) {
        const cache = new context_cache_js_1.ContextCache();
        // Prime the slot so we have something to invalidate.
        cache.getDeepInsightsSlot();
        const invalidated = cache.maybeInvalidateForTool(tool);
        strict_1.default.equal(invalidated, true, `tool "${tool}" must invalidate the cache`);
    }
});
(0, node_test_1.default)('read-only tools do NOT trigger invalidation', () => {
    const readOnlyTools = [
        'cognitive_status',
        'query_dreams',
        'query_runtime_metrics',
        'query_architecture_decisions',
        'unknown_tool_xyz',
    ];
    for (const tool of readOnlyTools) {
        const cache = new context_cache_js_1.ContextCache();
        cache.getDeepInsightsSlot();
        const invalidated = cache.maybeInvalidateForTool(tool);
        strict_1.default.equal(invalidated, false, `tool "${tool}" must NOT invalidate the cache`);
    }
});
(0, node_test_1.default)('invalidateDeepInsights drops the slot so the next get rebuilds it', () => {
    const cache = new context_cache_js_1.ContextCache();
    const first = cache.getDeepInsightsSlot();
    // Mutate slot so we can detect a rebuild.
    first.sentinel = 'before';
    const repeat = cache.getDeepInsightsSlot();
    strict_1.default.equal(repeat, first, 'within TTL the same slot is returned');
    cache.invalidateDeepInsights('test-eviction');
    const rebuilt = cache.getDeepInsightsSlot();
    strict_1.default.notEqual(rebuilt, first, 'after invalidation a fresh slot is built');
    strict_1.default.equal(rebuilt.sentinel, undefined, 'fresh slot has no carry-over');
});
(0, node_test_1.default)('clearAll drops both env-snapshot and deep-insights slots', () => {
    const cache = new context_cache_js_1.ContextCache();
    // Seed a snapshot slot. The snapshot value can be null — we only care that
    // the entry is cached (returns null instead of undefined on hit).
    cache.setEnvSnapshot('/repo', null);
    strict_1.default.equal(cache.getEnvSnapshot('/repo'), null, 'env snapshot is cached as null');
    cache.getDeepInsightsSlot();
    cache.clearAll();
    strict_1.default.equal(cache.getEnvSnapshot('/repo'), undefined, 'env snapshot dropped');
    // Re-fetching the deep slot must produce a fresh instance (no carry-over).
    const fresh = cache.getDeepInsightsSlot();
    strict_1.default.equal(fresh.sentinel, undefined);
});
(0, node_test_1.default)('getDeepInsightsSlot returns the same instance within the TTL window', () => {
    const cache = new context_cache_js_1.ContextCache();
    const a = cache.getDeepInsightsSlot();
    const b = cache.getDeepInsightsSlot();
    strict_1.default.equal(a, b, 'same slot returned within TTL');
    strict_1.default.ok(a.expiresAt > Date.now(), 'expiresAt is in the future');
    strict_1.default.ok(a.expiresAt <= Date.now() + context_cache_js_1.ContextCache.DEEP_INSIGHTS_TTL_MS + 100, 'expiresAt does not exceed TTL window');
});
(0, node_test_1.default)('maybeInvalidateForTool only fires for the published mutating-tool set', () => {
    // Spot-check the boundary: tools that mutate fact graph or cognitive state
    // are in; tools that only read are out. Catches accidental drift in the
    // COGNITIVE_MUTATING_TOOLS constant.
    const mustInvalidate = ['dream_cycle', 'normalize_dreams', 'record_architecture_decision'];
    const mustNotInvalidate = ['cognitive_status', 'query_dreams'];
    for (const tool of mustInvalidate) {
        const cache = new context_cache_js_1.ContextCache();
        cache.getDeepInsightsSlot();
        strict_1.default.equal(cache.maybeInvalidateForTool(tool), true, `${tool} must invalidate`);
    }
    for (const tool of mustNotInvalidate) {
        const cache = new context_cache_js_1.ContextCache();
        cache.getDeepInsightsSlot();
        strict_1.default.equal(cache.maybeInvalidateForTool(tool), false, `${tool} must NOT invalidate`);
    }
});
//# sourceMappingURL=context-cache-invalidation.test.js.map