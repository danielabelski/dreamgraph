import type { GraphRichnessSignal, GraphScope, NeighborOptions, ProjectGraphNode, ProjectGraphNodeId, ProjectGraphQuery, ProjectGraphReader, ProjectSubgraph } from "../../project-graph.js";
/**
 * Single-method seam over the MCP transport. The host (extension activate
 * in 8A.5) wires this against the real DreamGraph MCP server. Tests
 * supply an in-memory implementation that returns canned responses.
 *
 * `name` is the DreamGraph MCP tool name (e.g. 'mcp_dreamgraph_query_resource').
 * The adapter is the only thing that knows those names.
 */
export interface McpClient {
    callTool(name: string, args: Readonly<Record<string, unknown>>): Promise<unknown>;
    /**
     * Optional: return the live tool roster, names already in the same
     * namespace the catalog/executor uses (i.e. with the `mcp_dreamgraph_`
     * prefix). The bridge implementation owns the prefix translation.
     * When omitted or rejected, the catalog falls back to its native list
     * with every MCP descriptor marked unavailable.
     */
    listTools?(): Promise<readonly string[]>;
}
/** No-transport fallback. Always rejects \u2014 used only to fail loudly. */
export declare class UnboundMcpClient implements McpClient {
    callTool(name: string): Promise<never>;
    listTools(): Promise<readonly string[]>;
}
export interface DreamGraphReaderAdapterOptions {
    readonly client: McpClient;
    /**
     * Optional ceiling on graph_rag_retrieve max_nodes regardless of
     * caller request. Defaults to 200; the orchestrator's own caps still
     * apply on top via ProjectGraphQuery.maxNodes.
     */
    readonly maxNodesCeiling?: number;
}
/**
 * ProjectGraphReader backed by DreamGraph MCP tools. Translates the
 * abstract port surface into concrete tool calls. Never throws on
 * sparse / absent / error \u2014 returns canonical "no signal" values so
 * the ContextBuilder can fall back per ADR-176.
 */
export declare class DreamGraphReaderAdapter implements ProjectGraphReader {
    private readonly client;
    private readonly maxNodesCeiling;
    constructor(options: DreamGraphReaderAdapterOptions);
    getRichnessSignal(scope: GraphScope): Promise<GraphRichnessSignal>;
    retrieveSubgraph(query: ProjectGraphQuery): Promise<ProjectSubgraph>;
    /**
     * Last-resort subgraph: read `dream://graph` directly and project the
     * first N nodes/edges. Used when RAG cannot anchor a query but the
     * graph itself is rich. Without this, every architect turn that
     * cannot match an anchor falls back to the "graph absent — shallow
     * project walk" prompt section, which misleads the model into
     * planning a `scan_project` it does not need.
     */
    private retrieveGraphSnapshot;
    getNeighbors(nodeId: ProjectGraphNodeId, options?: NeighborOptions): Promise<readonly ProjectGraphNode[]>;
}
//# sourceMappingURL=reader.d.ts.map