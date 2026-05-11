// architect-v2/execution/index.ts
// Slice 4 — Public re-exports for the execution module.

export type { Tier } from "./tiers.js";
export {
  TIER_NAMES,
  TIER_ORDER,
  isDreamGraphTier,
  isFallbackTier,
} from "./tiers.js";

export type {
  Intent,
  T1Intent,
  T2Intent,
  T3Intent,
  T4Intent,
  T5Intent,
} from "./intents.js";
export { INTENT_GROUPS } from "./intents.js";

export type { ToolDescriptor, ToolKind } from "./catalog.js";
export { NATIVE_TOOL_CATALOG } from "./catalog.js";

export type {
  McpRosterProbe,
  VsCodeCapabilityProbe,
  ResolvedCatalog,
} from "./inventory.js";
export {
  resolveCatalog,
  buildCapabilityInventory,
  tiersCoveringIntent,
} from "./inventory.js";

export type {
  ExecutionPlan,
  FallbackJustification,
  NoExecutorAvailable,
} from "./policy.js";
export { selectExecutor, preferredTierForIntent, isNoExecutor } from "./policy.js";

export type {
  ToolOutcome,
  SuccessOutcome,
  FailureOutcome,
  PartialOutcome,
  ArtifactRef,
  VerificationEvidence,
} from "./outcome.js";
export { success, failure, partial, outcomeProducedArtifacts } from "./outcome.js";
