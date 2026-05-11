import type { ToolOutcome, VerificationEvidence } from "../execution/index.js";
import { type AutonomyBudgetView } from "./repair.js";
import type { CompletionStatus, VerificationPlan } from "./types.js";
import type { VerificationKind } from "../autonomy/index.js";
export interface ClassifyInput {
    readonly mutationOutcome: ToolOutcome;
    readonly plan: VerificationPlan;
    /**
     * Evidence collected from running each step. Keyed by VerificationKind.
     * Missing keys mean the step was attempted but the toolchain was
     * unavailable (e.g. no test runner installed).
     */
    readonly evidence: Readonly<Partial<Record<VerificationKind, VerificationEvidence>>>;
    readonly repairAttemptsByKind: Readonly<Record<VerificationKind, number>>;
    readonly autonomyBudget: AutonomyBudgetView;
}
/**
 * Pure classification of a single capability invocation's completion
 * status. Same input -> same status forever.
 */
export declare function classifyCompletion(input: ClassifyInput): CompletionStatus;
//# sourceMappingURL=classifier.d.ts.map