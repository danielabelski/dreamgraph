// Slice 8A.2 — public surface for the prompts sub-module.
//
// Re-exports the default composer and the synchronous formatter (for
// golden-file tests). Keep this file thin; do not add prompt logic here.

export { DefaultPromptComposer, composePromptSync } from "./composer.js";
export {
  declareContextRequirements,
  type ContextRequirement,
  type ContextRequirementBudget,
  type ContextRequirementKind,
  type ContextRequirementManifest,
  type DeclareRequirementsInput,
} from "./requirements.js";

export {
  TASK_PRESETS,
  getTaskPreset,
  applyPreset,
  presetAutonomyAddendum,
  type TaskPreset,
  type TaskPresetId,
} from "./task-presets.js";
