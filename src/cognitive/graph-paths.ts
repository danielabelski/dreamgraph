/**
 * DreamGraph — Graph Paths
 *
 * Shortest-path queries over the knowledge graph. Read-only; never mutates state.
 *
 * Edge sources (controlled by input flags):
 *   - validated_edges.json (DEFAULT): trusted, post-promotion edges only
 *   - dream_graph.json edges (opt-in via `include_dreams`): speculative REM edges
 *
 * Algorithm:
 *   - Default (`weighted=false`): unweighted BFS — fewest hops wins.
 *   - `weighted=true`: Dijkstra on edge cost = (1 - confidence). Higher-confidence
 *     edges are "shorter". Falls back to BFS-equivalent when all confidences are 1.
 *
 * Entity resolution: accepts either entity `id` or exact `name` (case-insensitive)
 * for `from` / `to`. Ambiguous names resolve to the first match and the chosen id
 * is reported in the response.
 */

import { existsSync } from "node:fs";
import { loadJsonArray, loadJsonData } from "../utils/cache.js";
import { dataPath } from "../utils/paths.js";
import { logger } from "../utils/logger.js";
import type { Feature, Workflow, DataModelEntity } from "../types/index.js";
import type {
  ValidatedEdge,
  ValidatedEdgesFile,
  DreamEdge,
  DreamGraphFile,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public input/output types
// ---------------------------------------------------------------------------

export interface ShortestPathQuery {
  /** Source entity id or exact name (case-insensitive). */
  from: string;
  /** Target entity id or exact name (case-insensitive). */
  to: string;
  /** Maximum hops to explore (default 6, max 12). */
  max_hops?: number;
  /** Restrict to edges whose `relation` is in this list (case-insensitive). Empty/undefined = no filter. */
  edge_relations?: string[];
  /** Restrict to edges whose `type` is in this list (e.g. "feature", "workflow", "data_model"). */
  edge_types?: string[];
  /** When true, run Dijkstra weighted by (1 - confidence). Default false (unweighted BFS). */
  weighted?: boolean;
  /** When true, also traverse speculative dream edges. Default false (validated only). */
  include_dreams?: boolean;
  /** When true, treat edges as undirected. Default true (most graph queries don't care about edge direction). */
  undirected?: boolean;
}

export interface PathNode {
  entity_id: string;
  name: string;
  kind: "feature" | "workflow" | "data_model" | "unknown";
}

export interface PathEdge {
  from: string;
  to: string;
  relation: string;
  type: string;
  confidence: number;
  source: "validated" | "dream";
  /** True if this edge was traversed against its declared direction (only meaningful when undirected=true). */
  reversed: boolean;
}

export interface ShortestPathResult {
  found: boolean;
  /** Resolved source entity id (after name lookup). */
  from_id: string | null;
  /** Resolved target entity id. */
  to_id: string | null;
  /** Number of edges in the path. 0 if from === to. -1 if not found. */
  hops: number;
  /** Total weight (sum of (1 - confidence) per edge) when weighted, else equals hops. */
  total_cost: number;
  /** Ordered list of entities from source to target. Empty if not found. */
  path: PathNode[];
  /** Ordered list of edges used (path.length - 1 entries). */
  edges: PathEdge[];
  /** Diagnostic / explanatory message. */
  message: string;
  /** Stats about the search. */
  stats: {
    entities_loaded: number;
    edges_considered: number;
    edges_after_filter: number;
    nodes_visited: number;
    algorithm: "bfs" | "dijkstra";
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface EntityRecord {
  id: string;
  name: string;
  kind: PathNode["kind"];
}

interface NormalizedEdge {
  from: string;
  to: string;
  relation: string;
  type: string;
  confidence: number;
  source: "validated" | "dream";
}

async function loadEntities(): Promise<EntityRecord[]> {
  const [features, workflows, dataModels] = await Promise.all([
    loadJsonArray<Feature>("features.json"),
    loadJsonArray<Workflow>("workflows.json"),
    loadJsonArray<DataModelEntity>("data_model.json"),
  ]);
  const out: EntityRecord[] = [];
  for (const f of features) out.push({ id: f.id, name: f.name, kind: "feature" });
  for (const w of workflows) out.push({ id: w.id, name: w.name, kind: "workflow" });
  for (const d of dataModels) out.push({ id: d.id, name: d.name, kind: "data_model" });
  return out;
}

async function loadValidatedEdges(): Promise<ValidatedEdge[]> {
  if (!existsSync(dataPath("validated_edges.json"))) return [];
  try {
    const file = await loadJsonData<ValidatedEdgesFile>("validated_edges.json");
    return file.edges ?? [];
  } catch {
    return [];
  }
}

async function loadDreamEdges(): Promise<DreamEdge[]> {
  if (!existsSync(dataPath("dream_graph.json"))) return [];
  try {
    const file = await loadJsonData<DreamGraphFile>("dream_graph.json");
    return file.edges ?? [];
  } catch {
    return [];
  }
}

/**
 * Resolve an entity reference (id OR exact name, case-insensitive) to an id.
 * Returns null if no match.
 */
function resolveRef(ref: string, entities: EntityRecord[]): EntityRecord | null {
  const lower = ref.trim().toLowerCase();
  // First pass: id match (exact, case-insensitive)
  for (const e of entities) {
    if (e.id.toLowerCase() === lower) return e;
  }
  // Second pass: name match (exact, case-insensitive)
  for (const e of entities) {
    if (e.name.toLowerCase() === lower) return e;
  }
  return null;
}

function lowerSet(arr: string[] | undefined): Set<string> | null {
  if (!arr || arr.length === 0) return null;
  return new Set(arr.map((s) => s.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Public API: findShortestPath
// ---------------------------------------------------------------------------

export async function findShortestPath(input: ShortestPathQuery): Promise<ShortestPathResult> {
  const max_hops = Math.min(Math.max(1, input.max_hops ?? 6), 12);
  const weighted = input.weighted === true;
  const include_dreams = input.include_dreams === true;
  const undirected = input.undirected !== false; // default true
  const relationFilter = lowerSet(input.edge_relations);
  const typeFilter = lowerSet(input.edge_types);

  logger.info(
    `findShortestPath: from="${input.from}" to="${input.to}" max_hops=${max_hops} ` +
      `weighted=${weighted} include_dreams=${include_dreams} undirected=${undirected}`
  );

  const entities = await loadEntities();
  const entityById = new Map<string, EntityRecord>();
  for (const e of entities) entityById.set(e.id, e);

  const fromEntity = resolveRef(input.from, entities);
  const toEntity = resolveRef(input.to, entities);

  const baseStats = {
    entities_loaded: entities.length,
    edges_considered: 0,
    edges_after_filter: 0,
    nodes_visited: 0,
    algorithm: (weighted ? "dijkstra" : "bfs") as "bfs" | "dijkstra",
  };

  if (!fromEntity) {
    return {
      found: false,
      from_id: null,
      to_id: toEntity?.id ?? null,
      hops: -1,
      total_cost: 0,
      path: [],
      edges: [],
      message: `Source entity "${input.from}" not found in features, workflows, or data_model.`,
      stats: baseStats,
    };
  }
  if (!toEntity) {
    return {
      found: false,
      from_id: fromEntity.id,
      to_id: null,
      hops: -1,
      total_cost: 0,
      path: [],
      edges: [],
      message: `Target entity "${input.to}" not found in features, workflows, or data_model.`,
      stats: baseStats,
    };
  }

  // Trivial: same node
  if (fromEntity.id === toEntity.id) {
    return {
      found: true,
      from_id: fromEntity.id,
      to_id: toEntity.id,
      hops: 0,
      total_cost: 0,
      path: [{ entity_id: fromEntity.id, name: fromEntity.name, kind: fromEntity.kind }],
      edges: [],
      message: "Source and target are the same entity.",
      stats: baseStats,
    };
  }

  // ---- Load + normalize edges
  const validated = await loadValidatedEdges();
  const dreamEdges = include_dreams ? await loadDreamEdges() : [];
  const allEdges: NormalizedEdge[] = [];

  for (const e of validated) {
    allEdges.push({
      from: e.from,
      to: e.to,
      relation: e.relation,
      type: e.type,
      confidence: e.confidence,
      source: "validated",
    });
  }
  for (const e of dreamEdges) {
    allEdges.push({
      from: e.from,
      to: e.to,
      relation: e.relation,
      type: e.type,
      confidence: e.confidence,
      source: "dream",
    });
  }

  baseStats.edges_considered = allEdges.length;

  // ---- Apply filters + drop edges referencing unknown entities (orphan dream edges, etc.)
  const filtered: NormalizedEdge[] = [];
  for (const e of allEdges) {
    if (!entityById.has(e.from) || !entityById.has(e.to)) continue;
    if (relationFilter && !relationFilter.has(e.relation.toLowerCase())) continue;
    if (typeFilter && !typeFilter.has(e.type.toLowerCase())) continue;
    filtered.push(e);
  }
  baseStats.edges_after_filter = filtered.length;

  // ---- Build adjacency. Entry: { neighbor, edge, reversed }
  interface AdjEntry {
    neighbor: string;
    edge: NormalizedEdge;
    reversed: boolean;
  }
  const adj = new Map<string, AdjEntry[]>();
  const addAdj = (k: string, v: AdjEntry) => {
    const list = adj.get(k);
    if (list) list.push(v);
    else adj.set(k, [v]);
  };
  for (const e of filtered) {
    addAdj(e.from, { neighbor: e.to, edge: e, reversed: false });
    if (undirected) {
      addAdj(e.to, { neighbor: e.from, edge: e, reversed: true });
    }
  }

  // ---- Search
  const previous = new Map<string, { from: string; entry: AdjEntry }>();
  const visited = new Set<string>();
  let foundCost = -1;

  if (!weighted) {
    // BFS — fewest hops
    const queue: Array<{ id: string; depth: number }> = [{ id: fromEntity.id, depth: 0 }];
    visited.add(fromEntity.id);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      baseStats.nodes_visited++;
      if (cur.id === toEntity.id) {
        foundCost = cur.depth;
        break;
      }
      if (cur.depth >= max_hops) continue;
      const neighbors = adj.get(cur.id) ?? [];
      for (const n of neighbors) {
        if (visited.has(n.neighbor)) continue;
        visited.add(n.neighbor);
        previous.set(n.neighbor, { from: cur.id, entry: n });
        queue.push({ id: n.neighbor, depth: cur.depth + 1 });
      }
    }
  } else {
    // Dijkstra weighted by (1 - confidence). Prevents pathological selection of zero-confidence chains.
    interface PqEntry {
      id: string;
      cost: number;
      depth: number;
    }
    const dist = new Map<string, number>();
    dist.set(fromEntity.id, 0);
    // Simple array-based priority queue (small graphs — no need for a heap).
    const open: PqEntry[] = [{ id: fromEntity.id, cost: 0, depth: 0 }];
    while (open.length > 0) {
      // Pop minimum
      let bestIdx = 0;
      for (let i = 1; i < open.length; i++) {
        if (open[i].cost < open[bestIdx].cost) bestIdx = i;
      }
      const cur = open.splice(bestIdx, 1)[0];
      if (visited.has(cur.id)) continue;
      visited.add(cur.id);
      baseStats.nodes_visited++;
      if (cur.id === toEntity.id) {
        foundCost = cur.cost;
        break;
      }
      if (cur.depth >= max_hops) continue;
      const neighbors = adj.get(cur.id) ?? [];
      for (const n of neighbors) {
        if (visited.has(n.neighbor)) continue;
        const w = Math.max(0.001, 1 - (n.edge.confidence ?? 0));
        const newCost = cur.cost + w;
        const known = dist.get(n.neighbor);
        if (known === undefined || newCost < known) {
          dist.set(n.neighbor, newCost);
          previous.set(n.neighbor, { from: cur.id, entry: n });
          open.push({ id: n.neighbor, cost: newCost, depth: cur.depth + 1 });
        }
      }
    }
  }

  if (foundCost < 0) {
    return {
      found: false,
      from_id: fromEntity.id,
      to_id: toEntity.id,
      hops: -1,
      total_cost: 0,
      path: [],
      edges: [],
      message:
        `No path from "${fromEntity.name}" (${fromEntity.id}) to "${toEntity.name}" (${toEntity.id}) ` +
        `within max_hops=${max_hops} using ${baseStats.edges_after_filter} edge(s) ` +
        `(${include_dreams ? "validated + dream" : "validated only"}).`,
      stats: baseStats,
    };
  }

  // ---- Reconstruct path
  const reverseChain: string[] = [toEntity.id];
  const reverseEdges: PathEdge[] = [];
  let cursor = toEntity.id;
  while (cursor !== fromEntity.id) {
    const step = previous.get(cursor);
    if (!step) break; // safety
    const e = step.entry.edge;
    reverseEdges.push({
      from: step.from,
      to: cursor,
      relation: e.relation,
      type: e.type,
      confidence: e.confidence,
      source: e.source,
      reversed: step.entry.reversed,
    });
    reverseChain.push(step.from);
    cursor = step.from;
  }
  reverseChain.reverse();
  reverseEdges.reverse();

  const path: PathNode[] = reverseChain.map((id) => {
    const ent = entityById.get(id);
    return {
      entity_id: id,
      name: ent?.name ?? id,
      kind: ent?.kind ?? "unknown",
    };
  });

  const hops = reverseEdges.length;
  const totalCost = weighted ? foundCost : hops;

  return {
    found: true,
    from_id: fromEntity.id,
    to_id: toEntity.id,
    hops,
    total_cost: Math.round(totalCost * 1000) / 1000,
    path,
    edges: reverseEdges,
    message:
      `Found path of ${hops} hop(s) from "${fromEntity.name}" to "${toEntity.name}" ` +
      `using ${baseStats.algorithm.toUpperCase()} over ${baseStats.edges_after_filter} edge(s).`,
    stats: baseStats,
  };
}
