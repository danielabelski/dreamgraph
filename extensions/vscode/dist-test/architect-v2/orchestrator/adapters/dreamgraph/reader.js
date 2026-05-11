"use strict";
// SCOPED EXCEPTION (ADR-171 guard rail): this directory is the ONLY
// location in architect-v2 where DreamGraph MCP tool names may appear
// in code. Slice 8B's lint rule will exempt orchestrator/adapters/
// dreamgraph/** from the global mcp_dreamgraph_* prohibition.
//
// Slice 8A.3 — DreamGraph adapter for ProjectGraphReader.
//
// The adapter translates the host-agnostic ProjectGraphReader port into
// concrete DreamGraph MCP tool calls. Transport is abstracted behind a
// minimal McpClient port so the adapter is testable without spinning up
// the real MCP server (the host wires a real client in 8A.5).
Object.defineProperty(exports, "__esModule", { value: true });
exports.DreamGraphReaderAdapter = exports.UnboundMcpClient = void 0;
/** No-transport fallback. Always rejects \u2014 used only to fail loudly. */
class UnboundMcpClient {
    async callTool(name) {
        throw new Error(`UnboundMcpClient: no MCP transport wired. Tool '${name}' cannot be called.`);
    }
    async listTools() {
        return [];
    }
}
exports.UnboundMcpClient = UnboundMcpClient;
/**
 * ProjectGraphReader backed by DreamGraph MCP tools. Translates the
 * abstract port surface into concrete tool calls. Never throws on
 * sparse / absent / error \u2014 returns canonical "no signal" values so
 * the ContextBuilder can fall back per ADR-176.
 */
class DreamGraphReaderAdapter {
    client;
    maxNodesCeiling;
    constructor(options) {
        this.client = options.client;
        this.maxNodesCeiling = options.maxNodesCeiling ?? 200;
    }
    async getRichnessSignal(scope) {
        // Strategy: query system overview for global, capability scope for
        // capability, neighbor count for node, project listing for path.
        try {
            switch (scope.kind) {
                case "global": {
                    // Probe `cognitive_status` — the same source the dashboard
                    // and explorer read from. It exposes the canonical entity
                    // counts (validated_stats.validated, dream_graph_stats), so
                    // the architect's `graph:` pill matches what the user sees
                    // in the UI. Probing `dream://graph` alone only counts
                    // speculative dream nodes (typically tens), which would
                    // mis-report a project with thousands of validated edges as
                    // sparse / absent.
                    const status = await this.client.callTool("mcp_dreamgraph_cognitive_status", {});
                    return cognitiveStatusToRichness(status);
                }
                case "capability": {
                    // No direct capability-richness tool; approximate via API surface.
                    const result = await this.client.callTool("mcp_dreamgraph_query_api_surface", { search: scope.capabilityId, limit: 10 });
                    return apiSurfaceToRichness(result);
                }
                case "node": {
                    const neighbors = await this.client.callTool("mcp_dreamgraph_graph_rag_retrieve", { anchors: [scope.nodeId], max_nodes: 10, max_depth: 1 });
                    return countToRichness(extractNodeCount(neighbors));
                }
                case "path": {
                    const status = await this.client.callTool("mcp_dreamgraph_cognitive_status", {});
                    return cognitiveStatusToRichness(status);
                }
                default: {
                    const _exhaustive = scope;
                    void _exhaustive;
                    return { richness: "absent", confidence: 1 };
                }
            }
        }
        catch {
            // Transport failure \u2014 degrade gracefully.
            return { richness: "absent", confidence: 1, note: "graph_error" };
        }
    }
    async retrieveSubgraph(query) {
        const limit = Math.min(this.maxNodesCeiling, query.maxNodes ?? 50);
        // Primary path: RAG retrieval. Requires `query` to be a non-empty
        // string per server schema, so synthesize one when absent.
        const ragQuery = (query.freeText ?? "").trim() || "project overview";
        try {
            const result = await this.client.callTool("mcp_dreamgraph_graph_rag_retrieve", {
                anchors: query.anchors ?? [],
                query: ragQuery,
                max_nodes: limit,
                max_depth: query.maxDepth ?? 2,
                kinds: query.kinds ?? undefined,
            });
            const sub = parseSubgraph(result);
            if (sub.nodes.length > 0)
                return sub;
        }
        catch {
            // fall through to snapshot fallback
        }
        // Fallback: when RAG returns nothing (or throws), pull a bounded
        // slice of the actual graph via `dream://graph` so the model still
        // sees real entities instead of an "absent" stub.
        return this.retrieveGraphSnapshot(limit);
    }
    /**
     * Last-resort subgraph: read `dream://graph` directly and project the
     * first N nodes/edges. Used when RAG cannot anchor a query but the
     * graph itself is rich. Without this, every architect turn that
     * cannot match an anchor falls back to the "graph absent — shallow
     * project walk" prompt section, which misleads the model into
     * planning a `scan_project` it does not need.
     */
    async retrieveGraphSnapshot(limit) {
        try {
            const graph = await this.client.callTool("mcp_dreamgraph_query_resource", { uri: "dream://graph" });
            const sub = parseSubgraph(graph);
            if (sub.nodes.length === 0)
                return EMPTY_SUBGRAPH;
            const nodes = sub.nodes.slice(0, limit);
            const ids = new Set(nodes.map((n) => n.id));
            const edges = sub.edges.filter((e) => ids.has(e.fromId) && ids.has(e.toId));
            return Object.freeze({
                nodes: Object.freeze(nodes),
                edges: Object.freeze(edges),
                truncated: sub.nodes.length > nodes.length,
            });
        }
        catch {
            return EMPTY_SUBGRAPH;
        }
    }
    async getNeighbors(nodeId, options) {
        try {
            const result = await this.client.callTool("mcp_dreamgraph_graph_rag_retrieve", {
                anchors: [nodeId],
                max_nodes: options?.limit ?? 25,
                max_depth: 1,
                relation: options?.relation ?? undefined,
                direction: options?.direction ?? "both",
            });
            return parseSubgraph(result).nodes;
        }
        catch {
            return [];
        }
    }
}
exports.DreamGraphReaderAdapter = DreamGraphReaderAdapter;
// ---------------------------------------------------------------------------
// Response parsing (defensive: tolerate any response shape)
// ---------------------------------------------------------------------------
const EMPTY_SUBGRAPH = Object.freeze({
    nodes: Object.freeze([]),
    edges: Object.freeze([]),
    truncated: false,
});
function overviewToRichness(payload) {
    // system://overview returns counts; map total entities to richness bands.
    const total = pickNumber(payload, [
        ["total_entities"],
        ["data", "total_entities"],
        ["entities"],
        ["data", "entities"],
    ]);
    if (total === undefined)
        return { richness: "absent", confidence: 0.5 };
    return countToRichness(total);
}
/**
 * Map `dream://graph` payload → richness. The graph resource is a JSON
 * document of shape `{ metadata, nodes: [...], edges: [...] }`. Total
 * "entities" for richness banding is `nodes.length + edges.length`.
 */
function graphToRichness(payload) {
    const nodes = pickArray(payload, [["nodes"], ["data", "nodes"]]);
    const edges = pickArray(payload, [["edges"], ["data", "edges"]]);
    if (nodes === undefined && edges === undefined) {
        // Could not parse the response at all — fall back to the legacy
        // overview probe shape so the signal degrades gracefully.
        return overviewToRichness(payload);
    }
    const total = (nodes?.length ?? 0) + (edges?.length ?? 0);
    return countToRichness(total);
}
/**
 * Map `cognitive_status` payload → richness. Reads the canonical
 * dashboard counts so the architect's `graph:` pill matches what the
 * user sees in the UI. Sums validated edges (the real, normalized
 * graph) with dream graph nodes/edges (current speculative working
 * set). Dream-only counts of tens are correct for "partial" but the
 * validated-edge total commonly runs in the thousands and must
 * dominate the richness band.
 */
function cognitiveStatusToRichness(payload) {
    const validated = pickNumber(payload, [
        ["validated_stats", "validated"],
        ["data", "validated_stats", "validated"],
    ]);
    const dreamNodes = pickNumber(payload, [
        ["dream_graph_stats", "total_nodes"],
        ["data", "dream_graph_stats", "total_nodes"],
    ]);
    const dreamEdges = pickNumber(payload, [
        ["dream_graph_stats", "total_edges"],
        ["data", "dream_graph_stats", "total_edges"],
    ]);
    if (validated === undefined &&
        dreamNodes === undefined &&
        dreamEdges === undefined) {
        // Unrecognised shape — fall back to the legacy overview probe.
        return overviewToRichness(payload);
    }
    const total = (validated ?? 0) + (dreamNodes ?? 0) + (dreamEdges ?? 0);
    return countToRichness(total);
}
function apiSurfaceToRichness(payload) {
    const items = pickArray(payload, [["items"], ["data", "items"], ["results"]]);
    if (items === undefined)
        return { richness: "absent", confidence: 0.5 };
    return countToRichness(items.length);
}
function countToRichness(n) {
    let richness;
    if (n <= 0)
        richness = "absent";
    else if (n < 5)
        richness = "sparse";
    else if (n < 50)
        richness = "partial";
    else
        richness = "rich";
    return { richness, confidence: 0.8 };
}
function extractNodeCount(payload) {
    const arr = pickArray(payload, [["nodes"], ["data", "nodes"], ["results"]]);
    return arr?.length ?? 0;
}
function parseSubgraph(payload) {
    const rawNodes = pickArray(payload, [["nodes"], ["data", "nodes"], ["results"]]) ?? [];
    const rawEdges = pickArray(payload, [["edges"], ["data", "edges"], ["relations"]]) ?? [];
    const truncated = pickBool(payload, [["truncated"], ["data", "truncated"]]) ?? false;
    const nodes = [];
    for (const r of rawNodes) {
        const node = toNode(r);
        if (node)
            nodes.push(node);
    }
    const edges = [];
    for (const r of rawEdges) {
        const edge = toEdge(r);
        if (edge)
            edges.push(edge);
    }
    return Object.freeze({
        nodes: Object.freeze(nodes),
        edges: Object.freeze(edges),
        truncated,
    });
}
function toNode(raw) {
    if (!isRecord(raw))
        return undefined;
    const id = asString(raw["id"] ?? raw["node_id"] ?? raw["entity_id"]);
    if (!id)
        return undefined;
    const kind = normalizeKind(asString(raw["kind"] ?? raw["type"]));
    const label = asString(raw["label"] ?? raw["name"] ?? raw["title"]) ?? id;
    const uri = asString(raw["uri"] ?? raw["path"] ?? raw["file"]);
    return Object.freeze({ id, kind, label, uri });
}
function toEdge(raw) {
    if (!isRecord(raw))
        return undefined;
    const fromId = asString(raw["from"] ?? raw["from_id"] ?? raw["source"]);
    const toId = asString(raw["to"] ?? raw["to_id"] ?? raw["target"]);
    const relation = asString(raw["relation"] ?? raw["type"] ?? raw["kind"]) ?? "related";
    if (!fromId || !toId)
        return undefined;
    return Object.freeze({ fromId, toId, relation });
}
function normalizeKind(s) {
    switch (s) {
        case "file":
        case "directory":
        case "symbol":
        case "module":
        case "decision":
        case "card":
        case "concept":
        case "test":
        case "artifact":
            return s;
        default:
            return "other";
    }
}
// ---------------------------------------------------------------------------
// Tiny defensive accessors
// ---------------------------------------------------------------------------
function isRecord(x) {
    return typeof x === "object" && x !== null && !Array.isArray(x);
}
function asString(x) {
    return typeof x === "string" && x.length > 0 ? x : undefined;
}
function pickNumber(payload, paths) {
    for (const p of paths) {
        const v = walk(payload, p);
        if (typeof v === "number" && Number.isFinite(v))
            return v;
    }
    return undefined;
}
function pickArray(payload, paths) {
    for (const p of paths) {
        const v = walk(payload, p);
        if (Array.isArray(v))
            return v;
    }
    return undefined;
}
function pickBool(payload, paths) {
    for (const p of paths) {
        const v = walk(payload, p);
        if (typeof v === "boolean")
            return v;
    }
    return undefined;
}
function walk(payload, path) {
    let cur = payload;
    for (const seg of path) {
        if (!isRecord(cur))
            return undefined;
        cur = cur[seg];
    }
    return cur;
}
//# sourceMappingURL=reader.js.map