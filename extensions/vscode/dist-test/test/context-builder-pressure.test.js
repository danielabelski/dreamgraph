"use strict";
/**
 * Phase 3 of NEVER_FAIL_BUDGET_DEBT_PLAN — adaptive trim of deep-insights
 * fetches inside `_resolveGraphContext` based on the BudgetCoordinator's
 * pressure label.
 *
 * The decision is encapsulated in the pure helper `shouldFetchDeepInsight`
 * (exported from `context-builder.ts`) so it can be tested without spinning
 * up the full ContextBuilder (which depends on the `vscode` module).
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const budget_coordinator_reader_js_1 = require("../budget-coordinator-reader.js");
const ALL_DEEP_KINDS = [
    'causal',
    'temporal',
    'data_model',
    'cognitive_status',
    'feature',
    'workflow',
];
(0, node_test_1.default)("Phase 3 — 'low' pressure fetches every deep-insight regardless of required/optional", () => {
    const required = new Set(); // none required
    for (const k of ALL_DEEP_KINDS) {
        strict_1.default.equal((0, budget_coordinator_reader_js_1.shouldFetchDeepInsight)(k, required, 'low'), true);
    }
});
(0, node_test_1.default)("Phase 3 — 'normal' pressure fetches every deep-insight (tier-2 trim reserved for future)", () => {
    const required = new Set();
    for (const k of ALL_DEEP_KINDS) {
        strict_1.default.equal((0, budget_coordinator_reader_js_1.shouldFetchDeepInsight)(k, required, 'normal'), true);
    }
});
(0, node_test_1.default)("Phase 3 — 'high' pressure skips optional deep-insights but keeps required ones", () => {
    const required = new Set(['causal', 'data_model']);
    strict_1.default.equal((0, budget_coordinator_reader_js_1.shouldFetchDeepInsight)('causal', required, 'high'), true);
    strict_1.default.equal((0, budget_coordinator_reader_js_1.shouldFetchDeepInsight)('data_model', required, 'high'), true);
    strict_1.default.equal((0, budget_coordinator_reader_js_1.shouldFetchDeepInsight)('temporal', required, 'high'), false);
    strict_1.default.equal((0, budget_coordinator_reader_js_1.shouldFetchDeepInsight)('cognitive_status', required, 'high'), false);
    strict_1.default.equal((0, budget_coordinator_reader_js_1.shouldFetchDeepInsight)('feature', required, 'high'), false);
    strict_1.default.equal((0, budget_coordinator_reader_js_1.shouldFetchDeepInsight)('workflow', required, 'high'), false);
});
(0, node_test_1.default)("Phase 3 — 'high' pressure with all-optional needs drops everything", () => {
    const required = new Set();
    for (const k of ALL_DEEP_KINDS) {
        strict_1.default.equal((0, budget_coordinator_reader_js_1.shouldFetchDeepInsight)(k, required, 'high'), false);
    }
});
(0, node_test_1.default)("Phase 3 — pressure decision is pure (same inputs → same outputs)", () => {
    const required = new Set(['causal']);
    const a = (0, budget_coordinator_reader_js_1.shouldFetchDeepInsight)('causal', required, 'high');
    const b = (0, budget_coordinator_reader_js_1.shouldFetchDeepInsight)('causal', required, 'high');
    strict_1.default.equal(a, b);
});
//# sourceMappingURL=context-builder-pressure.test.js.map