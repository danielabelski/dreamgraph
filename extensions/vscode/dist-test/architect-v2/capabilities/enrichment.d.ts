import type { Intent } from "../execution/index.js";
import { type CapabilityId } from "./matrix.js";
/**
 * Returns the Intent the orchestrator should queue for the next pass
 * when this capability ran in sparse-mode (or was a graph-only gap). May
 * be `undefined` when no enrichment is meaningful — e.g. pure
 * environment IO like `env.clipboard`.
 */
export declare function enrichmentForFallback(capabilityId: CapabilityId): Intent | undefined;
/** Describes a queued enrichment task — emitted on `TaskState.enrichmentQueue`. */
export interface EnrichmentTask {
    readonly capabilityId: CapabilityId;
    readonly intent: Intent;
    /** Why this enrichment was queued (debug/audit; rendered on cards). */
    readonly reason: "sparse_mode_used" | "graph_only_gap";
}
/**
 * Build an `EnrichmentTask` for a capability that just ran in sparse-mode
 * or was declared a gap. Returns `undefined` when the capability has no
 * enrichOnFallback intent (nothing useful to schedule).
 */
export declare function buildEnrichmentTask(capabilityId: CapabilityId, reason: EnrichmentTask["reason"]): EnrichmentTask | undefined;
//# sourceMappingURL=enrichment.d.ts.map