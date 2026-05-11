/**
 * Stable cross-backend node identity. Format is opaque to the
 * orchestrator; adapters define their own scheme (e.g. `dg:entity:1234`,
 * `lsp:symbol:foo.ts#Bar`, `fs:path:/src/x.ts`). Equality is string equality.
 */
export type ProjectGraphNodeId = string;
/**
 * Coarse classification used by ContextBuilder ranking and richness
 * scoring. Adapters MAY return `'other'` when nothing else fits — this is
 * preferable to inventing a category.
 */
export type ProjectGraphNodeKind = "file" | "directory" | "symbol" | "module" | "decision" | "card" | "concept" | "test" | "artifact" | "other";
export interface ProjectGraphNode {
    readonly id: ProjectGraphNodeId;
    readonly kind: ProjectGraphNodeKind;
    /** Short human-readable label (for prompt rendering). */
    readonly label: string;
    /**
     * Optional URI back to the source artifact (file path, MCP resource
     * URI, etc.). Adapters that have no addressable source may omit.
     */
    readonly uri?: string;
    /**
     * Backend-specific properties. The orchestrator MUST NOT branch on the
     * shape of this bag. ContextBuilder may pass selected fields to the
     * prompt verbatim, but interpretation belongs to the adapter.
     */
    readonly properties?: Readonly<Record<string, unknown>>;
}
export interface ProjectGraphEdge {
    readonly fromId: ProjectGraphNodeId;
    readonly toId: ProjectGraphNodeId;
    /** Free-form label, e.g. "imports", "decided_by", "verifies". */
    readonly relation: string;
    readonly properties?: Readonly<Record<string, unknown>>;
}
/**
 * A bounded slice of the project graph returned by `retrieveSubgraph`.
 * Opaque to the orchestrator beyond its `nodes` / `edges` arrays —
 * ContextBuilder turns it into ContextSections.
 */
export interface ProjectSubgraph {
    readonly nodes: readonly ProjectGraphNode[];
    readonly edges: readonly ProjectGraphEdge[];
    /** True if the adapter truncated to fit within `maxNodes` / token budget. */
    readonly truncated: boolean;
    /** Adapter-specific provenance string for audit/debug. */
    readonly provenance?: string;
}
/**
 * Scope of the richness query. Adapters use this to answer questions like
 * "how well-instrumented is the graph for this capability / file / repo
 * subtree?" without committing to a specific backend.
 */
export type GraphScope = {
    readonly kind: "global";
} | {
    readonly kind: "capability";
    readonly capabilityId: string;
} | {
    readonly kind: "path";
    readonly path: string;
} | {
    readonly kind: "node";
    readonly nodeId: ProjectGraphNodeId;
};
/**
 * Mirrors Slice 6 `GraphDensity` semantics, but lives on the port so the
 * adapter — not the orchestrator — owns the measurement heuristic.
 */
export type GraphRichness = "rich" | "partial" | "sparse" | "absent";
export interface GraphRichnessSignal {
    readonly richness: GraphRichness;
    /**
     * Optional 0..1 confidence in the richness verdict. Adapters that have
     * no confidence model should omit (consumers default to 1.0).
     */
    readonly confidence?: number;
    /** Free-form note rendered on cards/UI (e.g. "no ADRs in last 30 days"). */
    readonly note?: string;
}
export interface ProjectGraphQuery {
    /**
     * Anchor nodes the subgraph must contain. Adapters expand outward from
     * these. May be empty if `freeText` is provided.
     */
    readonly anchors?: readonly ProjectGraphNodeId[];
    /** Optional free-text query for adapters that support semantic search. */
    readonly freeText?: string;
    /** Optional node-kind filter. */
    readonly kinds?: readonly ProjectGraphNodeKind[];
    /** Maximum nodes the adapter may return (hint, not a hard cap). */
    readonly maxNodes?: number;
    /** Maximum edge-traversal depth from anchors. */
    readonly maxDepth?: number;
}
export interface NeighborOptions {
    /** When set, only edges with this relation are returned. */
    readonly relation?: string;
    readonly direction?: "in" | "out" | "both";
    readonly limit?: number;
}
export interface DecisionRecord {
    readonly id: string;
    readonly taskId: string;
    readonly atEpochMs: number;
    readonly chosen: string;
    readonly alternatives: readonly string[];
    readonly rationale: string;
    /** Optional ADR identifier the orchestrator wants linked. */
    readonly adrRef?: string;
}
export interface OutcomeRecord {
    readonly id: string;
    readonly taskId: string;
    readonly atEpochMs: number;
    readonly tool: string;
    readonly succeeded: boolean;
    readonly summary: string;
    /** Touched node ids (files, symbols, ADRs) in graph-native form. */
    readonly touchedNodeIds: readonly ProjectGraphNodeId[];
}
export interface ProjectGraphReader {
    /** Adapter-defined richness measurement for the requested scope. */
    getRichnessSignal(scope: GraphScope): Promise<GraphRichnessSignal>;
    /** Bounded subgraph retrieval; ContextBuilder folds this into the envelope. */
    retrieveSubgraph(query: ProjectGraphQuery): Promise<ProjectSubgraph>;
    /** Direct neighbor expansion, used for follow-up clarifications mid-pass. */
    getNeighbors(nodeId: ProjectGraphNodeId, options?: NeighborOptions): Promise<readonly ProjectGraphNode[]>;
}
import type { Card as ArchitectCard } from "../cards/index.js";
import type { ContinuationNeed } from "../autonomy/index.js";
export interface ProjectGraphRecorder {
    /**
     * Persist a batch of cards as graph nodes (and any implicit edges to
     * the artifacts they reference). Idempotent on `card.id`.
     */
    recordCards(cards: readonly ArchitectCard[]): Promise<void>;
    recordDecision(decision: DecisionRecord): Promise<void>;
    recordOutcome(outcome: OutcomeRecord): Promise<void>;
    /**
     * Persist the continuation so a later pass (or a different host) can
     * resume the task with the exact selected tool intact (ADR-154).
     */
    recordContinuation(continuation: ContinuationNeed): Promise<void>;
}
export declare const NULL_PROJECT_SUBGRAPH: ProjectSubgraph;
export declare const NULL_RICHNESS_SIGNAL: GraphRichnessSignal;
export declare const NullProjectGraphReader: ProjectGraphReader;
export declare const NullProjectGraphRecorder: ProjectGraphRecorder;
//# sourceMappingURL=project-graph.d.ts.map