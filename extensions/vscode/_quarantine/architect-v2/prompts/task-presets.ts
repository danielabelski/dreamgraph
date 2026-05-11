// architect-v2/prompts/task-presets.ts
// Milestone 4 (v10.0.0 cutover) — Port v1 task templates as inert data.
//
// STRICT ISOLATION (ADR-140 + ADR-171): no v1 imports; no MCP tool
// names. This file is pure data. The composer never imports it; the
// chat panel (Milestone 7) wraps a UserIntent through `applyPreset`
// before handing it to the orchestrator.
//
// Why presets are *data*, not templates:
//   v1 carried four task "templates" (explain / patch / suggest /
//   validate) that the architect.ts entry point dispatched on. v2
//   collapses dispatch into `chooseCapabilityPath` — but the user
//   surface still benefits from a small set of named entry points.
//   Each preset encodes:
//     - a system-prompt addendum that frames the task
//     - the default `CapabilityId` the orchestrator should ask the
//       executor to fulfill on the first pass
//     - a deterministic prefix that wraps the user's free text so the
//       provider sees consistent framing across passes
//
//   Nothing in this file calls a tool, reads a file, or branches on
//   provider id. Adding a preset is a data change.

import type { CapabilityId } from "../capabilities/index.js";
import type { UserIntent } from "../orchestrator/types.js";

export type TaskPresetId = "explain" | "patch" | "suggest" | "validate";

export interface TaskPreset {
  readonly id: TaskPresetId;
  readonly displayName: string;
  /** Default capability the orchestrator should resolve on pass 1. */
  readonly defaultCapability: CapabilityId;
  /** System-prompt addendum, appended to the autonomy contract. */
  readonly systemAddendum: string;
  /** Wraps the user's free-form text into a consistent request. */
  readonly userPrefix: string;
}

export const TASK_PRESETS: readonly TaskPreset[] = Object.freeze([
  Object.freeze<TaskPreset>({
    id: "explain",
    displayName: "Explain",
    defaultCapability: "search.semantic",
    systemAddendum: [
      "## Preset: Explain",
      "Goal: produce a clear, evidence-anchored explanation of the requested code or concept.",
      "Cite entities, ADRs, and file paths returned by the graph. Do not invent identifiers.",
      "If the graph is sparse for the topic, say so and propose `enrichment` as one of your candidates.",
    ].join("\n"),
    userPrefix: "Explain the following:",
  }),
  Object.freeze<TaskPreset>({
    id: "patch",
    displayName: "Patch",
    defaultCapability: "mutate.file.patch",
    systemAddendum: [
      "## Preset: Patch",
      "Goal: produce a minimal, reviewable change that fulfills the request.",
      "Prefer `file.patch` (entity-scoped) over `file.edit` (line-range).",
      "After the patch, propose `verify.build` or `verify.test` as the next pass action.",
    ].join("\n"),
    userPrefix: "Apply the following change:",
  }),
  Object.freeze<TaskPreset>({
    id: "suggest",
    displayName: "Suggest",
    defaultCapability: "search.semantic",
    systemAddendum: [
      "## Preset: Suggest",
      "Goal: rank concrete next-step actions; do not mutate state on this pass.",
      "Each candidate must name an exact tool from the inventory and a one-line rationale.",
      "Prefer multiple low-cost candidates over one expensive speculative action.",
    ].join("\n"),
    userPrefix: "Suggest next actions for:",
  }),
  Object.freeze<TaskPreset>({
    id: "validate",
    displayName: "Validate",
    defaultCapability: "verify.discipline",
    systemAddendum: [
      "## Preset: Validate",
      "Goal: run verification and report pass/fail with cited evidence.",
      "Use `verify.discipline` and `verify.invariant` first; fall back to build/test/lint only when discipline does not cover the question.",
      "Never silently retry a failed verification — surface the failure and propose a remediation candidate.",
    ].join("\n"),
    userPrefix: "Validate the following:",
  }),
]);

const PRESET_INDEX: ReadonlyMap<TaskPresetId, TaskPreset> = new Map(
  TASK_PRESETS.map((p) => [p.id, p] as const),
);

export function getTaskPreset(id: TaskPresetId): TaskPreset {
  const p = PRESET_INDEX.get(id);
  if (!p) throw new Error(`Unknown task preset '${id}'`);
  return p;
}

/**
 * Wrap a free-form user request through a preset. Returns a new
 * UserIntent whose `text` carries the preset prefix + the original
 * request. The system addendum is delivered separately via
 * `presetAutonomyAddendum` so it merges into the autonomy contract,
 * not the user turn.
 */
export function applyPreset(
  intent: UserIntent,
  presetId: TaskPresetId,
): UserIntent {
  const preset = getTaskPreset(presetId);
  const text = intent.text.trim();
  const wrapped =
    text.startsWith(preset.userPrefix)
      ? text
      : `${preset.userPrefix}\n${text}`;
  return {
    ...intent,
    text: wrapped,
  };
}

/**
 * Build a system-prompt addendum string from a preset, suitable for
 * appending to the autonomy contract handed to `composePrompt`. Returns
 * an empty string when `presetId` is undefined so the caller can pipe
 * unconditionally.
 */
export function presetAutonomyAddendum(
  presetId: TaskPresetId | undefined,
): string {
  if (!presetId) return "";
  return getTaskPreset(presetId).systemAddendum;
}
