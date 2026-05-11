// architect-v2/autonomy/index.ts
// Slice 3 — Public surface of the autonomy module.
//
// External consumers (orchestrator, settings UI, future slices) import from
// here. Internal files cross-import directly.

export type {
  AutonomyMode,
  ModeProfile,
  VerificationStrictness,
} from "./modes";
export { MODE_PROFILES, getModeProfile } from "./modes";

export type { PassBudget, TimeBudget, BudgetView } from "./budget";
export {
  createPassBudget,
  consumePass,
  createTimeBudget,
  elapsedMs,
  remainingMs,
  isTimeBudgetExhausted,
  deriveBudgetView,
} from "./budget";

export type {
  TaskStatus,
  ArtifactSnapshot,
  PassRecord,
  TaskState,
} from "./task";

export type {
  BlockerKind,
  Blocker,
  VerificationKind,
  VerificationFailure,
  ActionCandidate,
  RankedActions,
  ContinuationNeed,
  StopCondition,
  PauseReason,
  DecisionResult,
} from "./signals";
export { createContinuationNeed } from "./signals";

export type { CapabilityInventory } from "./capability";
export {
  createStubCapabilityInventory,
  createCapabilityInventory,
} from "./capability";

export type { DeriveNextActionInput } from "./decision";
export {
  deriveNextAction,
  rankActions,
  filterByCapability,
  detectNoProgress,
  buildContinuationPrompt,
} from "./decision";
