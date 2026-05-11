/**
 * DreamGraph Context Cache (Layer 2 helper).
 *
 * Hot-path cache for `ContextBuilder.buildEnvelope`. Owns:
 *  - Environment-snapshot cache (5 min TTL)
 *  - Deep-insights slot (30 s TTL — covers dream/causal/temporal/cognitive)
 *  - Process-wide context-fetch timeout counter (F-14 observability)
 *  - The list of cognitive-mutating MCP tools that should invalidate the
 *    deep-insights slot after they run (F-04)
 *  - The hard MCP fetch ceiling (F-07)
 *
 * Extracted from `context-builder.ts` (F-06 sub-batch 3/3) so the cache
 * policy lives in one focused module instead of being interleaved with
 * the envelope assembly logic.
 */
import type { EnvironmentContextSnapshot } from "./environment-context.js";
/** Per-instance environment-snapshot cache entry. */
export interface EnvSnapshotEntry {
    workspaceRoot: string;
    snapshot: EnvironmentContextSnapshot | null;
    expiresAt: number;
}
/** Deep-insights slot — every field is independently lazily filled. */
export interface DeepInsightsSlot {
    expiresAt: number;
    dreams?: Array<{
        type: string;
        insight: string;
        confidence: number;
        source?: string;
        relevance?: number;
    }>;
    causal?: Array<{
        from: string;
        to: string;
        relationship: string;
        confidence: number;
        relevance?: number;
    }>;
    temporal?: Array<{
        pattern: string;
        frequency: string;
        last_seen?: string;
        relevance?: number;
    }>;
    cognitive?: string | null;
}
export declare class ContextCache {
    /**
     * Hard ceiling for any MCP context-builder fetch. Advisory context only —
     * if the daemon is busy or a tool hangs we must not block the LLM call.
     *
     * F-07: 6 s baseline (up from 4 s) gives slow daemons a fairer chance on
     * large graphs while still cutting hung calls long before the LLM sees
     * them. Override via env var `DREAMGRAPH_CTX_FETCH_TIMEOUT_MS`.
     */
    static readonly MCP_CONTEXT_FETCH_TIMEOUT_MS: number;
    /** Workspace runtime/package facts barely change. */
    static readonly ENV_SNAPSHOT_TTL_MS: number;
    /** Dream/causal/temporal/cognitive change on dream-cycle cadence. */
    static readonly DEEP_INSIGHTS_TTL_MS = 30000;
    /**
     * Names of MCP tools whose successful execution invalidates the
     * deep-insights cache. Anything that mutates the dream graph, the
     * validated edges, the tension log, ADRs, the UI registry, or the
     * seed graph belongs here.
     */
    static readonly COGNITIVE_MUTATING_TOOLS: ReadonlySet<string>;
    /**
     * Process-wide counts of context-fetch timeouts since extension start,
     * keyed by MCP tool name. F-14 — makes silent context truncation
     * observable to the context inspector channel.
     */
    private static readonly _ctxFetchTimeouts;
    /** Record a context-fetch timeout. First two per tool log loudly. */
    static recordTimeout(tool: string): void;
    /** Read-only snapshot of context-fetch timeouts (tool -> count). */
    static getTimeoutStats(): Record<string, number>;
    /** Heuristic: did this thrown value originate from one of our timeouts? */
    static isTimeout(err: unknown): boolean;
    private _envSnapshot;
    private _deepInsights;
    /** Returns the cached snapshot if valid for this workspace, else undefined. */
    getEnvSnapshot(workspaceRoot: string): EnvironmentContextSnapshot | null | undefined;
    /** Store a freshly built environment snapshot. */
    setEnvSnapshot(workspaceRoot: string, snapshot: EnvironmentContextSnapshot | null): void;
    /**
     * Get the deep-insights slot, recreating it (and resetting the TTL) if
     * the previous slot has expired. Each `_fetchX` caller fills the field
     * relevant to it, so the first read in a TTL window does the work and
     * subsequent reads in the same window are O(1).
     */
    getDeepInsightsSlot(): DeepInsightsSlot;
    /**
     * Drop the deep-insights slot so the next fetch refreshes from MCP.
     * Call after a graph-mutating action so the chat panel does not assert
     * "Verified" against stale state.
     */
    invalidateDeepInsights(reason?: string): void;
    /**
     * Convenience: invalidate when the named tool is known to mutate
     * cognitive state. Returns true if the cache was invalidated.
     */
    maybeInvalidateForTool(toolName: string): boolean;
    /** Drop every cached slot. Useful on workspace change or daemon reconnect. */
    clearAll(): void;
}
//# sourceMappingURL=context-cache.d.ts.map