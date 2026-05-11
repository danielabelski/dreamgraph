import type { Intent } from "../execution/index.js";
import type { GraphDensity } from "./density.js";
import { type CapabilityId } from "./matrix.js";
/** What the orchestrator should do for a capability on this pass. */
export type CapabilityPlan = {
    readonly kind: "graph-amplified";
    readonly capabilityId: CapabilityId;
    readonly density: GraphDensity;
    /** The Intent set to hand to `selectExecutor`. Fallback forbidden when rich. */
    readonly intents: readonly Intent[];
    /** Empty when density is 'rich'; carries fallback intents when 'partial'. */
    readonly allowedFallback: readonly Intent[];
    readonly graphBound: "yes";
    readonly enrichmentQueued: null;
    readonly winRationale: string;
} | {
    readonly kind: "sparse-mode";
    readonly capabilityId: CapabilityId;
    readonly density: GraphDensity;
    /** Fallback intents — used immediately, no waiting on graph. */
    readonly intents: readonly Intent[];
    readonly allowedFallback: readonly Intent[];
    readonly graphBound: "no" | "partial";
    /** Enrichment Intent queued for the next pass (may be undefined). */
    readonly enrichmentQueued: Intent | null;
    readonly winRationale: string;
} | {
    readonly kind: "gap";
    readonly capabilityId: CapabilityId;
    readonly density: GraphDensity;
    readonly reason: "graph_only_capability_without_baseline";
    readonly enrichmentQueued: Intent | null;
};
/**
 * Pure selection function. Same `(capabilityId, density)` always returns
 * the same plan (Slice 6 verification §9.6).
 */
export declare function chooseCapabilityPath(capabilityId: CapabilityId, density: GraphDensity): CapabilityPlan;
export declare function isGraphAmplified(plan: CapabilityPlan): plan is Extract<CapabilityPlan, {
    kind: "graph-amplified";
}>;
export declare function isSparseMode(plan: CapabilityPlan): plan is Extract<CapabilityPlan, {
    kind: "sparse-mode";
}>;
export declare function isGap(plan: CapabilityPlan): plan is Extract<CapabilityPlan, {
    kind: "gap";
}>;
//# sourceMappingURL=selection.d.ts.map