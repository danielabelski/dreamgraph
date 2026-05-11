/**
 * Deep-insights MCP fetchers for `ContextBuilder`.
 *
 * Each function:
 *  - reads/writes its slice of the {@link ContextCache} deep-insights slot
 *  - bounds the MCP call with `ContextCache.MCP_CONTEXT_FETCH_TIMEOUT_MS`
 *  - records timeouts via `ContextCache.recordTimeout` (F-14)
 *  - never throws — context fetches are advisory and must not block the
 *    LLM call. On any failure the cached value is set to an empty result.
 *
 * Extracted from `context-builder.ts` (F-06 sub-batch 3/3). The fetchers
 * stay free functions so they can be unit-tested without spinning up the
 * full ContextBuilder.
 */
import type { McpClient } from "../mcp-client.js";
import type { EditorContextEnvelope } from "../types.js";
import { ContextCache } from "../context-cache.js";
export declare function fetchDreamInsights(cache: ContextCache, mcp: McpClient): Promise<NonNullable<ReturnType<ContextCache["getDeepInsightsSlot"]>["dreams"]>>;
export declare function fetchCausalInsights(cache: ContextCache, mcp: McpClient): Promise<NonNullable<ReturnType<ContextCache["getDeepInsightsSlot"]>["causal"]>>;
export declare function fetchTemporalInsights(cache: ContextCache, mcp: McpClient): Promise<NonNullable<ReturnType<ContextCache["getDeepInsightsSlot"]>["temporal"]>>;
export declare function fetchDataModelEntities(envelope: EditorContextEnvelope, mcp: McpClient): Promise<Array<{
    id: string;
    name: string;
    storage: string;
    relevance?: number;
}>>;
export declare function fetchCognitiveStatus(cache: ContextCache, mcp: McpClient): Promise<string | null>;
//# sourceMappingURL=deep-insights.d.ts.map