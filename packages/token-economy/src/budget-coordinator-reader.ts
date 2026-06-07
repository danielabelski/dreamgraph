/**
 * Phase 3 of NEVER_FAIL_BUDGET_DEBT_PLAN — pure helpers for the
 * read-only contract between `ContextBuilder` and `BudgetCoordinator`.
 *
 * Lives in its own module so unit tests can import the policy helper
 * without pulling in `vscode` (which `context-builder.ts` requires).
 */

export type ContextEvidenceKind = string;

/**
 * Minimal duck-typed interface the context tier consumes from a
 * `BudgetCoordinator`. The coordinator owns all pressure decisions
 * (Plan §4.0); the builder only reads.
 */
export interface BudgetCoordinatorReader {
  /** Tokens the coordinator estimates remain in the adaptive target. */
  getRemainingTargetTokens?(): number;
  /** Coarse pressure label derived from `getPressure()`. */
  getContextPressureLabel?(): 'low' | 'normal' | 'high';
  /** Report a tier's actual token consumption (Plan §4.5 components). */
  recordComponentActual?(component: string, actualTokens: number): void;
  /**
   * Plan §4.4 / ADR-097 — context builder calls this when it intentionally
   * drops the reserved graph slice for emergency transport protection so the
   * audit trail records the breach.
   */
  flagGraphSliceEmergencyTrim?(): void;
}

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
export function shouldFetchDeepInsight(
  kind: ContextEvidenceKind,
  requiredEvidence: ReadonlySet<ContextEvidenceKind>,
  pressureLabel: 'low' | 'normal' | 'high',
): boolean {
  if (pressureLabel !== 'high') return true;
  return requiredEvidence.has(kind);
}
