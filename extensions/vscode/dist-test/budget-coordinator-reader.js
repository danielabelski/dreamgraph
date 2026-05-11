"use strict";
/**
 * Phase 3 of NEVER_FAIL_BUDGET_DEBT_PLAN — pure helpers for the
 * read-only contract between `ContextBuilder` and `BudgetCoordinator`.
 *
 * Lives in its own module so unit tests can import the policy helper
 * without pulling in `vscode` (which `context-builder.ts` requires).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.shouldFetchDeepInsight = shouldFetchDeepInsight;
/**
 * Pure decision for whether to issue a deep-insights MCP fetch given the
 * current pressure label.
 *
 * Policy (Plan §3.1 trimming order, tier 1 = deep insights):
 *  - 'low' or 'normal': always fetch when needed
 *  - 'high': skip when the kind is *only* in optionalEvidence (not required)
 *
 * ADR-097: the curated graph slice is upstream of this; deep insights are
 * advisory MCP fetches, so trimming them never breaches the reserved slice.
 */
function shouldFetchDeepInsight(kind, requiredEvidence, pressureLabel) {
    if (pressureLabel !== 'high')
        return true;
    return requiredEvidence.has(kind);
}
//# sourceMappingURL=budget-coordinator-reader.js.map