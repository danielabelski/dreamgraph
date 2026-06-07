export { shouldFetchDeepInsight } from "@dreamgraph/token-economy/budget-coordinator-reader";
export type { BudgetCoordinatorReader } from "@dreamgraph/token-economy/budget-coordinator-reader";
import type { ContextEvidenceKind } from "./types.js";
import { shouldFetchDeepInsight as sharedShouldFetchDeepInsight } from "@dreamgraph/token-economy/budget-coordinator-reader";

export function shouldFetchDeepInsightForVsCode(
  kind: ContextEvidenceKind,
  requiredEvidence: ReadonlySet<ContextEvidenceKind>,
  pressureLabel: "low" | "normal" | "high",
): boolean {
  return sharedShouldFetchDeepInsight(kind, requiredEvidence, pressureLabel);
}
