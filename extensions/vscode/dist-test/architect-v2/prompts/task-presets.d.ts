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
export declare const TASK_PRESETS: readonly TaskPreset[];
export declare function getTaskPreset(id: TaskPresetId): TaskPreset;
/**
 * Wrap a free-form user request through a preset. Returns a new
 * UserIntent whose `text` carries the preset prefix + the original
 * request. The system addendum is delivered separately via
 * `presetAutonomyAddendum` so it merges into the autonomy contract,
 * not the user turn.
 */
export declare function applyPreset(intent: UserIntent, presetId: TaskPresetId): UserIntent;
/**
 * Build a system-prompt addendum string from a preset, suitable for
 * appending to the autonomy contract handed to `composePrompt`. Returns
 * an empty string when `presetId` is undefined so the caller can pipe
 * unconditionally.
 */
export declare function presetAutonomyAddendum(presetId: TaskPresetId | undefined): string;
//# sourceMappingURL=task-presets.d.ts.map