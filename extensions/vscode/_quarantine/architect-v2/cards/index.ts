// architect-v2/cards/index.ts
// Slice 5 — Public surface of the cards module.

export type {
  Card,
  CardKind,
  CardSchemaVersion,
  BaseCard,
  GoalCard,
  PlanCard,
  PlanStep,
  ContextCard,
  DecisionCard,
  EditCard,
  VerificationCard,
  BlockerCard,
  NextStepCard,
  CompletionCard,
  FallbackCard,
  OutcomeCard,
} from './types.js';
export { CARD_SCHEMA_VERSION, assertNeverCard } from './types.js';

export type {
  PillSet,
  PillKind,
  Certainty,
  GraphBound,
  VerificationStatus,
  FallbackReason,
  ComputePillsInput,
} from './pills.js';
export { PILL_KINDS, computePills } from './pills.js';

export type {
  DurableCardRecord,
  EphemeralCardState,
  PersistenceSplit,
} from './persistence.js';
export {
  splitForPersistence,
  createEmptyEphemeralState,
} from './persistence.js';

export type { CardMigrator } from './migration.js';
export { MIGRATIONS, migrate } from './migration.js';

export type { CardCommon } from './factory.js';
export {
  createGoalCard,
  createPlanCard,
  createContextCard,
  createDecisionCard,
  createEditCard,
  createVerificationCard,
  createBlockerCard,
  createCompletionCard,
  createNextStepCard,
  createFallbackCard,
  createOutcomeCard,
} from './factory.js';

export { renderCard, renderCards, renderTrailingNote, renderPass, sanitizeFreeText } from './render.js';
