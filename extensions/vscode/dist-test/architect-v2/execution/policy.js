"use strict";
// architect-v2/execution/policy.ts
// Slice 4 — Tier-walk selection policy (ADR-144 + ADR-156).
//
// STRICT ISOLATION (ADR-140): no import from v1.
//
// Pure: no I/O, no global state, no dispatch. Returns an `ExecutionPlan`
// describing WHICH tool the orchestrator should invoke at WHICH tier, and
// — when a fallback was taken — WHY.
Object.defineProperty(exports, "__esModule", { value: true });
exports.preferredTierForIntent = preferredTierForIntent;
exports.selectExecutor = selectExecutor;
exports.isNoExecutor = isNoExecutor;
const catalog_js_1 = require("./catalog.js");
const tiers_js_1 = require("./tiers.js");
/**
 * Lowest tier number declared anywhere in the static catalog for this intent.
 * That is the "preferred" tier — the one we'd pick if everything was available.
 */
function preferredTierForIntent(intent) {
    let best = null;
    for (const d of catalog_js_1.NATIVE_TOOL_CATALOG) {
        if (d.intent !== intent)
            continue;
        if (best === null || d.tier < best)
            best = d.tier;
    }
    return best;
}
/**
 * Walk T1 → T5 and pick the first available descriptor matching the intent.
 *
 * Selection rules (locked, ADR-144 / ADR-156):
 *   1. Lower tier wins. T1 beats T2 beats T3 beats T4 beats T5.
 *   2. Within a tier, the first descriptor in `NATIVE_TOOL_CATALOG`
 *      declaration order wins.
 *   3. If the chosen tier is numerically greater than the intent's
 *      `preferredTier`, attach a `FallbackJustification`.
 *   4. If no available descriptor covers the intent in any tier,
 *      return a `NoExecutorAvailable` so the caller can raise a blocker
 *      instead of silently substituting the wrong tool.
 */
function selectExecutor(intent, resolved) {
    const alternativesByTier = new Map();
    for (const t of tiers_js_1.TIER_ORDER)
        alternativesByTier.set(t, []);
    for (const d of resolved.available) {
        if (d.intent === intent) {
            alternativesByTier.get(d.tier).push(d);
        }
    }
    let chosen = null;
    let chosenTier = null;
    for (const t of tiers_js_1.TIER_ORDER) {
        const cands = alternativesByTier.get(t);
        if (cands.length > 0) {
            chosen = cands[0];
            chosenTier = t;
            break;
        }
    }
    if (chosen === null || chosenTier === null) {
        return {
            intent,
            reason: "no_tier_covers_intent",
            inspectedTiers: tiers_js_1.TIER_ORDER,
        };
    }
    const preferred = preferredTierForIntent(intent);
    let fallback;
    if (preferred !== null && chosenTier > preferred) {
        // We chose a tier higher (numerically) than the static preference.
        // Distinguish "DreamGraph tool exists but is unavailable right now"
        // from "intent is genuinely not covered by DreamGraph".
        const dreamgraphExistsForIntent = catalog_js_1.NATIVE_TOOL_CATALOG.some((d) => d.intent === intent && (0, tiers_js_1.isDreamGraphTier)(d.tier));
        if (dreamgraphExistsForIntent) {
            fallback = {
                reason: "mcp_tool_unavailable",
                preferredTier: preferred,
                chosenTier,
                note: `Preferred Tier ${preferred} tool for intent '${intent}' is not in the live MCP roster; falling back to Tier ${chosenTier}.`,
            };
        }
        else {
            fallback = {
                reason: "intent_not_covered_by_dreamgraph",
                preferredTier: preferred,
                chosenTier,
                note: `Intent '${intent}' has no DreamGraph-native tool by design; using Tier ${chosenTier}.`,
            };
        }
    }
    else if (chosenTier === 4 || chosenTier === 5) {
        // Intent's preferred tier IS already the fallback tier — the intent is
        // editor-native by design (e.g. `editor.diagnostics`). Mark it explicitly
        // so cards can render the right pill.
        if (preferred === chosenTier) {
            fallback = {
                reason: "editor_native_required",
                preferredTier: preferred,
                chosenTier,
                note: `Intent '${intent}' is editor-native by design; no DreamGraph equivalent exists.`,
            };
        }
    }
    return {
        intent,
        chosen,
        tier: chosenTier,
        alternativesByTier: freezeMap(alternativesByTier),
        fallbackJustification: fallback,
    };
}
function freezeMap(m) {
    const out = new Map();
    for (const [k, v] of m)
        out.set(k, Object.freeze([...v]));
    return out;
}
/**
 * Convenience predicate the orchestrator uses when deciding whether to
 * promote a `NoExecutorAvailable` into a `Blocker`.
 */
function isNoExecutor(result) {
    return result.reason === "no_tier_covers_intent";
}
//# sourceMappingURL=policy.js.map