import type { ToolDescriptor } from "./catalog.js";
import type { Intent } from "./intents.js";
import type { ResolvedCatalog } from "./inventory.js";
import type { Tier } from "./tiers.js";
/**
 * Why the chosen tool sits at a tier higher (numerically) than the
 * intent's preferred tier. Always present when a fallback occurred,
 * always absent otherwise.
 */
export interface FallbackJustification {
    readonly reason: "mcp_tool_failed" | "mcp_tool_unavailable" | "intent_not_covered_by_dreamgraph" | "editor_native_required";
    readonly preferredTier: Tier;
    readonly chosenTier: Tier;
    readonly note: string;
}
/**
 * Result of `selectExecutor`. Pure plan — no execution has happened yet.
 */
export interface ExecutionPlan {
    readonly intent: Intent;
    readonly chosen: ToolDescriptor;
    readonly tier: Tier;
    /**
     * For each tier walked, the descriptors that matched the intent in that
     * tier (whether or not the tier was selected). Useful for the card UI to
     * render "considered alternatives" without recomputing.
     */
    readonly alternativesByTier: ReadonlyMap<Tier, readonly ToolDescriptor[]>;
    readonly fallbackJustification?: FallbackJustification;
}
/**
 * The "no plan possible" outcome — every tier had nothing for the intent.
 * The orchestrator turns this into a `Blocker` of kind `'capability_missing'`
 * (Slice 3 contract).
 */
export interface NoExecutorAvailable {
    readonly intent: Intent;
    readonly reason: "no_tier_covers_intent";
    /** What we tried — useful for the blocker description. */
    readonly inspectedTiers: readonly Tier[];
}
/**
 * Lowest tier number declared anywhere in the static catalog for this intent.
 * That is the "preferred" tier — the one we'd pick if everything was available.
 */
export declare function preferredTierForIntent(intent: Intent): Tier | null;
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
export declare function selectExecutor(intent: Intent, resolved: ResolvedCatalog): ExecutionPlan | NoExecutorAvailable;
/**
 * Convenience predicate the orchestrator uses when deciding whether to
 * promote a `NoExecutorAvailable` into a `Blocker`.
 */
export declare function isNoExecutor(result: ExecutionPlan | NoExecutorAvailable): result is NoExecutorAvailable;
//# sourceMappingURL=policy.d.ts.map