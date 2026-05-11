/**
 * DreamGraph Architect Lens — Phase 5 #10 / ADR-100.
 *
 * Picks a *reasoning lens* for the architect (orthogonal to IntentMode,
 * which only chooses where to look). Heuristic-only — no LLM call.
 *
 * Lenses follow ADR-100's "visible when useful, silent otherwise" rule:
 *   - For trivial requests (rename variable, fix typo) we return `generic`
 *     and mark `material = false` so the prompt assembler suppresses the
 *     "Architect Lens: …" badge entirely.
 *   - For requests where the lens materially changes the reasoning
 *     (different evidence pulled, different ADR set, different query
 *     protocol) we return one of the named lenses with `material = true`.
 *
 * @see plans/GRAPH_META_ARCHITECT_DEEP_ANALYSIS.md §8.5
 */
import type { ArchitectLens, ArchitectLensSelection, IntentMode } from "./types.js";
export interface LensDetectionInput {
    prompt: string;
    intentMode: IntentMode;
    commandSource?: string;
}
/**
 * Select an ArchitectLens for the request.
 *
 * Returns a `generic` selection (with `material = false`) for trivial paths
 * or when no rule fires above threshold; the prompt assembler treats those
 * as "silent" per ADR-100.
 */
export declare function detectArchitectLens(input: LensDetectionInput): ArchitectLensSelection;
/** Display label used by prompt overlays / UI surfaces. */
export declare function lensLabel(lens: ArchitectLens): string;
//# sourceMappingURL=architect-lens.d.ts.map