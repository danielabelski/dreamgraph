// STRICT ISOLATION (ADR-140): no import from v1.
// Slice 7 — public surface.

export type {
  VerificationKind,
  VerificationReason,
  VerificationStep,
  VerificationPlan,
  CompletionStatus,
  CompletionMetrics,
} from "./types.js";
export { assertNeverStatus } from "./types.js";

export { VERIFICATION_PLAN_TABLE, VERIFICATION_PERFORMED_BY, planVerifications } from "./planner.js";

export type { RepairDecision, AutonomyBudgetView, PlanRepairInput } from "./repair.js";
export { planRepair, DEFAULT_REPAIR_BUDGET_PER_KIND } from "./repair.js";

export type { ClassifyInput } from "./classifier.js";
export { classifyCompletion } from "./classifier.js";

export type { ComputeMetricsInput } from "./metrics.js";
export { computeMetrics } from "./metrics.js";
