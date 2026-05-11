import type { Intent } from "./intents.js";
import type { Tier } from "./tiers.js";
/**
 * Stable handle to something the tool produced or modified. Same shape
 * Slice 3 `TaskState.artifacts` consumes for no-progress detection.
 */
export interface ArtifactRef {
    readonly kind: "file" | "mcp_entity" | "graph_edge" | "verification" | "narrative" | "adr" | "card";
    readonly id: string;
    /** Optional content hash for delta detection. */
    readonly hash?: string;
}
/**
 * Verification evidence carried by `success` outcomes that are themselves
 * verification operations (build/test/lint/mcp_verify/etc.).
 */
export interface VerificationEvidence {
    readonly kind: "build" | "test" | "type" | "lint" | "mcp_verify" | "invariant";
    readonly passed: boolean;
    readonly summary: string;
    readonly failures?: readonly {
        readonly description: string;
        readonly artifactRef?: string;
    }[];
}
interface OutcomeBase {
    readonly tool: string;
    readonly tier: Tier;
    readonly intent: Intent;
    readonly executedAtEpochMs: number;
    readonly durationMs: number;
}
export interface SuccessOutcome extends OutcomeBase {
    readonly kind: "success";
    readonly artifacts: readonly ArtifactRef[];
    readonly evidence?: VerificationEvidence;
    /**
     * Optional serializable payload returned by the tool (e.g. the JSON
     * body of an MCP read tool like `query_resource`). Surfaced verbatim
     * in the OutcomeCard so the user can see what the tool actually
     * returned. Limited to plain JSON values; large payloads should be
     * truncated by the producer before reaching this field.
     */
    readonly payload?: unknown;
}
export interface FailureOutcome extends OutcomeBase {
    readonly kind: "failure";
    readonly failureReason: string;
    /** True if the orchestrator may retry the same tool with the same args. */
    readonly recoverable: boolean;
    /**
     * If the failure mode suggests trying a different tier (e.g. MCP tool
     * threw → try VS Code), the suggested tier is named here. The orchestrator
     * is free to ignore this hint.
     */
    readonly suggestedFallbackTier?: Tier;
}
export interface PartialOutcome extends OutcomeBase {
    readonly kind: "partial";
    readonly artifacts: readonly ArtifactRef[];
    readonly blockedBy: string;
    /** Same semantics as SuccessOutcome.payload — see above. */
    readonly payload?: unknown;
}
export type ToolOutcome = SuccessOutcome | FailureOutcome | PartialOutcome;
export declare function success(args: Omit<SuccessOutcome, "kind">): SuccessOutcome;
export declare function failure(args: Omit<FailureOutcome, "kind">): FailureOutcome;
export declare function partial(args: Omit<PartialOutcome, "kind">): PartialOutcome;
/**
 * True if the outcome modified observable state (an artifact was produced
 * or changed). Used by Slice 3 no-progress detection at the orchestrator
 * boundary.
 */
export declare function outcomeProducedArtifacts(o: ToolOutcome): boolean;
export {};
//# sourceMappingURL=outcome.d.ts.map