import type { TaskState } from "../autonomy/index.js";
import type { CapabilityId } from "../capabilities/index.js";
import type { UserIntent } from "../orchestrator/types.js";
/**
 * Closed enumeration of context kinds the composer may request. Adding a
 * kind requires an ADR amendment (per ADR-174 guard rails) so the
 * assembler can enumerate exhaustive support.
 *
 * Kinds map roughly to:
 *   - Decision history    : architectural_decisions, adr_lineage
 *   - Open work           : unresolved_blockers, prior_failed_attempts
 *   - Code surface        : graph_neighborhood, file_excerpts
 *   - Operational signals : recent_history, runtime_diagnostics, environment_state
 */
export type ContextRequirementKind = "architectural_decisions" | "adr_lineage" | "unresolved_blockers" | "prior_failed_attempts" | "graph_neighborhood" | "file_excerpts" | "recent_history" | "runtime_diagnostics" | "environment_state";
/**
 * Coarse budget hint. The assembler converts this to a token allocation
 * against the active provider window — there is intentionally no token
 * count here, because the composer does not know the window size.
 */
export type ContextRequirementBudget = "small" | "medium" | "large";
/**
 * One declared requirement. `anchors` are opaque ids the assembler can
 * use to focus retrieval (file paths, capability ids, ADR ids, etc.);
 * the composer may leave it empty when it has no anchor in mind.
 */
export interface ContextRequirement {
    readonly kind: ContextRequirementKind;
    readonly budget: ContextRequirementBudget;
    /** Human-readable reason this requirement was declared (audit + tests). */
    readonly rationale: string;
    /** Optional anchors (paths, capability ids, ADR ids, node ids). */
    readonly anchors?: readonly string[];
    /**
     * Optional priority within the manifest. Higher = the assembler should
     * satisfy this first when budget pressure forces choices. Defaults to 0.
     */
    readonly priority?: number;
}
export interface ContextRequirementManifest {
    readonly schemaVersion: 1;
    readonly requirements: readonly ContextRequirement[];
    /**
     * Free-form note explaining *why this manifest looks like this*, for
     * golden-file diffs and audit. Not consumed by the assembler.
     */
    readonly note: string;
}
export interface DeclareRequirementsInput {
    readonly userIntent: UserIntent;
    readonly taskState: TaskState;
    /**
     * Optional capability hint. Continuations carry one (the action they
     * intend to retry); fresh user turns usually do not. The composer uses
     * this to add capability-specific requirement kinds.
     */
    readonly capabilityHint?: CapabilityId;
}
/**
 * Build the requirement manifest for the upcoming pass.
 *
 * Pure: same inputs → deeply-equal output. No clock, no randomness.
 * No I/O. No graph access. No MCP calls. No filesystem.
 */
export declare function declareContextRequirements(input: DeclareRequirementsInput): ContextRequirementManifest;
//# sourceMappingURL=requirements.d.ts.map