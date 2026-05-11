import type { CapabilityId } from "./matrix.js";
export type GraphDensity = "rich" | "partial" | "sparse" | "absent";
/**
 * Snapshot of graph state used to compute density per capability. The
 * fields are deliberately small and provider-neutral; richer probes can
 * be added without breaking the contract.
 */
export interface DensityProbe {
    /** True when `system://overview` reports a non-empty index. */
    readonly hasIndex: boolean;
    /** Number of source-code entities known to the graph. */
    readonly sourceEntityCount: number;
    /** Number of API-surface entries (functions/classes with signatures). */
    readonly apiEntityCount: number;
    /** Number of recorded ADRs. */
    readonly adrCount: number;
    /** Number of validated edges. */
    readonly validatedEdgeCount: number;
    /** Number of UI elements registered. */
    readonly uiElementCount: number;
    /** Number of rows/tables in the data-model index. */
    readonly dataModelEntityCount: number;
    /** Number of recent dream insights (last cycle window). */
    readonly recentDreamInsightCount: number;
    /** Number of resolved tensions (provenance for memory.recall). */
    readonly resolvedTensionCount: number;
}
/** Empty probe — the day-zero install state. Drives sparse-mode everywhere. */
export declare const EMPTY_DENSITY_PROBE: DensityProbe;
/**
 * Pure mapping from `(probe, capabilityId)` to a density bucket. The
 * mapping picks the *most relevant* count for each capability — e.g.
 * `search.api` reads `apiEntityCount`, `search.ui` reads
 * `uiElementCount`, mutation capabilities read `sourceEntityCount`.
 */
export declare function measureDensity(probe: DensityProbe, capabilityId: CapabilityId): GraphDensity;
//# sourceMappingURL=density.d.ts.map