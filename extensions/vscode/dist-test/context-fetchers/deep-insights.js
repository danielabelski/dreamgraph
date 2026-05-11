"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchDreamInsights = fetchDreamInsights;
exports.fetchCausalInsights = fetchCausalInsights;
exports.fetchTemporalInsights = fetchTemporalInsights;
exports.fetchDataModelEntities = fetchDataModelEntities;
exports.fetchCognitiveStatus = fetchCognitiveStatus;
const context_cache_js_1 = require("../context-cache.js");
/* ------------------------------------------------------------------ */
/*  Dream insights — get_dream_insights                               */
/* ------------------------------------------------------------------ */
async function fetchDreamInsights(cache, mcp) {
    const slot = cache.getDeepInsightsSlot();
    if (slot.dreams)
        return slot.dreams;
    try {
        const result = await mcp.callTool("get_dream_insights", {}, context_cache_js_1.ContextCache.MCP_CONTEXT_FETCH_TIMEOUT_MS);
        const data = typeof result === "string" ? JSON.parse(result) : result;
        const raw = data?.ok ? data.data?.insights : data?.insights;
        if (!Array.isArray(raw)) {
            slot.dreams = [];
            return slot.dreams;
        }
        slot.dreams = raw.slice(0, 8).map((i) => ({
            type: String(i.type ?? "insight"),
            insight: String(i.insight ?? i.description ?? i.text ?? ""),
            confidence: Number(i.confidence ?? 0.5),
            source: i.source ? String(i.source) : undefined,
            relevance: Number(i.relevance ?? 0.7),
        }));
        return slot.dreams;
    }
    catch (err) {
        if (context_cache_js_1.ContextCache.isTimeout(err)) {
            context_cache_js_1.ContextCache.recordTimeout("get_dream_insights");
        }
        slot.dreams = [];
        return slot.dreams;
    }
}
/* ------------------------------------------------------------------ */
/*  Causal insights — get_causal_insights                             */
/* ------------------------------------------------------------------ */
async function fetchCausalInsights(cache, mcp) {
    const slot = cache.getDeepInsightsSlot();
    if (slot.causal)
        return slot.causal;
    try {
        const result = await mcp.callTool("get_causal_insights", {}, context_cache_js_1.ContextCache.MCP_CONTEXT_FETCH_TIMEOUT_MS);
        const data = typeof result === "string" ? JSON.parse(result) : result;
        const chains = data?.ok
            ? data.data?.chains ?? data.data?.insights
            : data?.chains ?? data?.insights;
        if (!Array.isArray(chains)) {
            slot.causal = [];
            return slot.causal;
        }
        slot.causal = chains.slice(0, 12).map((c) => ({
            from: String(c.from ?? c.source ?? ""),
            to: String(c.to ?? c.target ?? ""),
            relationship: String(c.relationship ?? c.type ?? "influences"),
            confidence: Number(c.confidence ?? 0.5),
            relevance: Number(c.relevance ?? 0.75),
        }));
        return slot.causal;
    }
    catch (err) {
        if (context_cache_js_1.ContextCache.isTimeout(err)) {
            context_cache_js_1.ContextCache.recordTimeout("get_causal_insights");
        }
        slot.causal = [];
        return slot.causal;
    }
}
/* ------------------------------------------------------------------ */
/*  Temporal insights — get_temporal_insights                         */
/* ------------------------------------------------------------------ */
async function fetchTemporalInsights(cache, mcp) {
    const slot = cache.getDeepInsightsSlot();
    if (slot.temporal)
        return slot.temporal;
    try {
        const result = await mcp.callTool("get_temporal_insights", {}, context_cache_js_1.ContextCache.MCP_CONTEXT_FETCH_TIMEOUT_MS);
        const data = typeof result === "string" ? JSON.parse(result) : result;
        const patterns = data?.ok
            ? data.data?.patterns ?? data.data?.insights
            : data?.patterns ?? data?.insights;
        if (!Array.isArray(patterns)) {
            slot.temporal = [];
            return slot.temporal;
        }
        slot.temporal = patterns.slice(0, 8).map((p) => ({
            pattern: String(p.pattern ?? p.description ?? ""),
            frequency: String(p.frequency ?? p.recurrence ?? "unknown"),
            last_seen: p.last_seen ? String(p.last_seen) : undefined,
            relevance: Number(p.relevance ?? 0.65),
        }));
        return slot.temporal;
    }
    catch (err) {
        if (context_cache_js_1.ContextCache.isTimeout(err)) {
            context_cache_js_1.ContextCache.recordTimeout("get_temporal_insights");
        }
        slot.temporal = [];
        return slot.temporal;
    }
}
/* ------------------------------------------------------------------ */
/*  Data-model entities — search_data_model (no slot caching)         */
/* ------------------------------------------------------------------ */
async function fetchDataModelEntities(envelope, mcp) {
    try {
        const anchor = envelope.activeFile?.selection?.anchor?.symbolPath ??
            envelope.activeFile?.selection?.anchor?.label ??
            envelope.activeFile?.cursorAnchor?.symbolPath ??
            envelope.activeFile?.cursorAnchor?.label ??
            envelope.activeFile?.path ??
            envelope.visibleFiles[0] ??
            "";
        const result = await mcp.callTool("search_data_model", { entity_name: anchor }, context_cache_js_1.ContextCache.MCP_CONTEXT_FETCH_TIMEOUT_MS);
        const data = typeof result === "string" ? JSON.parse(result) : result;
        const entities = data?.ok
            ? data.data?.matches ?? data.data?.entities
            : data?.matches ?? data?.entities;
        if (!Array.isArray(entities))
            return [];
        return entities.slice(0, 8).map((e) => ({
            id: String(e.id ?? ""),
            name: String(e.name ?? ""),
            storage: String(e.storage ?? e.store ?? "unknown"),
            relevance: Number(e.relevance ?? 0.7),
        }));
    }
    catch {
        return [];
    }
}
/* ------------------------------------------------------------------ */
/*  Cognitive status — getCognitiveStatus (race against timeout)      */
/* ------------------------------------------------------------------ */
async function fetchCognitiveStatus(cache, mcp) {
    const slot = cache.getDeepInsightsSlot();
    if (slot.cognitive !== undefined)
        return slot.cognitive;
    try {
        // Bound this fetch with the same hard ceiling as other context fetches —
        // getCognitiveStatus has no built-in timeout and was contributing to the
        // multi-second "Dreaming…" stall before the first tool call.
        const status = await Promise.race([
            mcp.getCognitiveStatus(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("getCognitiveStatus timeout")), context_cache_js_1.ContextCache.MCP_CONTEXT_FETCH_TIMEOUT_MS)),
        ]);
        if (status && typeof status === "object" && "current_state" in status) {
            slot.cognitive = status.current_state;
        }
        else {
            slot.cognitive = null;
        }
        return slot.cognitive;
    }
    catch (err) {
        if (context_cache_js_1.ContextCache.isTimeout(err)) {
            context_cache_js_1.ContextCache.recordTimeout("cognitive_status");
        }
        slot.cognitive = null;
        return slot.cognitive;
    }
}
//# sourceMappingURL=deep-insights.js.map