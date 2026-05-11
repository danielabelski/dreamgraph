// STRICT ISOLATION (ADR-140 + ADR-171): no import from v1.
// No import of mcp_dreamgraph_* anywhere in this file or anywhere it is
// consumed. DreamGraph is one *adapter* behind these ports (8A.3 / 8A.4);
// the orchestrator binds only to the abstractions defined here.
//
// Slice 8A.1 — Project graph ports.
//
// `ProjectGraphReader` and `ProjectGraphRecorder` are the *only* graph
// surfaces the Architect orchestrator and its sub-slices may consume.
// They are deliberately narrower than DreamGraph's internal model so
// that LSP-only, filesystem-only, or remote-graph backends can be
// implemented without stub returns.
//
// Sparse / no-graph projects are first-class:
//   - `ProjectGraphReader.getRichnessSignal` returns 'absent' / 'sparse'
//     and the orchestrator transparently degrades to filesystem +
//     runtime + LSP context reconstruction (Slice 6 sparse-mode).
//   - `ProjectGraphRecorder` may be a no-op `NullProjectGraphRecorder`;
//     cognition is still produced, just not durably indexed.

// ---------------------------------------------------------------------------
// Domain types — intentionally narrower than any specific backend.
// Backends translate their own model into / out of these shapes inside
// their adapter layer. Nothing here is DreamGraph-specific.
// ---------------------------------------------------------------------------

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
export type ProjectGraphNodeKind =
  | "file"
  | "directory"
  | "symbol"        // function, class, type, etc. (LSP-style)
  | "module"        // package-level grouping
  | "decision"      // an ADR or design decision
  | "card"          // an Architect card persisted into the graph
  | "concept"       // a domain concept / capability description
  | "test"
  | "artifact"      // build output, generated file, etc.
  | "other";

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

// ---------------------------------------------------------------------------
// Richness signal — feeds Slice 6 density measurement.
// ---------------------------------------------------------------------------

/**
 * Scope of the richness query. Adapters use this to answer questions like
 * "how well-instrumented is the graph for this capability / file / repo
 * subtree?" without committing to a specific backend.
 */
export type GraphScope =
  | { readonly kind: "global" }
  | { readonly kind: "capability"; readonly capabilityId: string }
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "node"; readonly nodeId: ProjectGraphNodeId };

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

// ---------------------------------------------------------------------------
// Query / option shapes
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Records emitted by the orchestrator into the Recorder
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Reader port
// ---------------------------------------------------------------------------

export interface ProjectGraphReader {
  /** Adapter-defined richness measurement for the requested scope. */
  getRichnessSignal(scope: GraphScope): Promise<GraphRichnessSignal>;
  /** Bounded subgraph retrieval; ContextBuilder folds this into the envelope. */
  retrieveSubgraph(query: ProjectGraphQuery): Promise<ProjectSubgraph>;
  /** Direct neighbor expansion, used for follow-up clarifications mid-pass. */
  getNeighbors(
    nodeId: ProjectGraphNodeId,
    options?: NeighborOptions,
  ): Promise<readonly ProjectGraphNode[]>;
}

// ---------------------------------------------------------------------------
// Recorder port
// ---------------------------------------------------------------------------
//
// IMPORTANT: types `ArchitectCard`, `ContinuationNeed` are imported from
// the existing architect-v2 modules so the recorder speaks the
// orchestrator's native vocabulary. Adapters translate these into their
// backend's storage shape.

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

// ---------------------------------------------------------------------------
// Null implementations — used when no backend is wired.
// They are *not* stubs in the bad sense: they implement the contract
// faithfully for an empty / no-graph project.
// ---------------------------------------------------------------------------

export const NULL_PROJECT_SUBGRAPH: ProjectSubgraph = Object.freeze({
  nodes: Object.freeze([]) as readonly ProjectGraphNode[],
  edges: Object.freeze([]) as readonly ProjectGraphEdge[],
  truncated: false,
  provenance: "null-reader",
});

export const NULL_RICHNESS_SIGNAL: GraphRichnessSignal = Object.freeze({
  richness: "absent" as const,
  confidence: 1,
  note: "No project-graph reader wired.",
});

export const NullProjectGraphReader: ProjectGraphReader = Object.freeze({
  async getRichnessSignal(_scope: GraphScope): Promise<GraphRichnessSignal> {
    return NULL_RICHNESS_SIGNAL;
  },
  async retrieveSubgraph(_query: ProjectGraphQuery): Promise<ProjectSubgraph> {
    return NULL_PROJECT_SUBGRAPH;
  },
  async getNeighbors(
    _nodeId: ProjectGraphNodeId,
    _options?: NeighborOptions,
  ): Promise<readonly ProjectGraphNode[]> {
    return [];
  },
});

export const NullProjectGraphRecorder: ProjectGraphRecorder = Object.freeze({
  async recordCards(_cards: readonly ArchitectCard[]): Promise<void> {
    /* no-op */
  },
  async recordDecision(_decision: DecisionRecord): Promise<void> {
    /* no-op */
  },
  async recordOutcome(_outcome: OutcomeRecord): Promise<void> {
    /* no-op */
  },
  async recordContinuation(_continuation: ContinuationNeed): Promise<void> {
    /* no-op */
  },
});
