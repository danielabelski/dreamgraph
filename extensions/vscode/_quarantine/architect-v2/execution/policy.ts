// architect-v2/execution/policy.ts
// Slice 4 — Tier-walk selection policy (ADR-144 + ADR-156).
//
// STRICT ISOLATION (ADR-140): no import from v1.
//
// Pure: no I/O, no global state, no dispatch. Returns an `ExecutionPlan`
// describing WHICH tool the orchestrator should invoke at WHICH tier, and
// — when a fallback was taken — WHY.

import type { ToolDescriptor } from "./catalog.js";
import { NATIVE_TOOL_CATALOG } from "./catalog.js";
import type { Intent } from "./intents.js";
import type { ResolvedCatalog } from "./inventory.js";
import type { Tier } from "./tiers.js";
import { TIER_ORDER, isDreamGraphTier } from "./tiers.js";

/**
 * Why the chosen tool sits at a tier higher (numerically) than the
 * intent's preferred tier. Always present when a fallback occurred,
 * always absent otherwise.
 */
export interface FallbackJustification {
  readonly reason:
    | "mcp_tool_failed"
    | "mcp_tool_unavailable"
    | "intent_not_covered_by_dreamgraph"
    | "editor_native_required";
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
export function preferredTierForIntent(intent: Intent): Tier | null {
  let best: Tier | null = null;
  for (const d of NATIVE_TOOL_CATALOG) {
    if (d.intent !== intent) continue;
    if (best === null || d.tier < best) best = d.tier;
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
export function selectExecutor(
  intent: Intent,
  resolved: ResolvedCatalog,
): ExecutionPlan | NoExecutorAvailable {
  const alternativesByTier = new Map<Tier, ToolDescriptor[]>();
  for (const t of TIER_ORDER) alternativesByTier.set(t, []);

  for (const d of resolved.available) {
    if (d.intent === intent) {
      alternativesByTier.get(d.tier)!.push(d);
    }
  }

  let chosen: ToolDescriptor | null = null;
  let chosenTier: Tier | null = null;
  for (const t of TIER_ORDER) {
    const cands = alternativesByTier.get(t)!;
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
      inspectedTiers: TIER_ORDER,
    };
  }

  const preferred = preferredTierForIntent(intent);
  let fallback: FallbackJustification | undefined;

  if (preferred !== null && chosenTier > preferred) {
    // We chose a tier higher (numerically) than the static preference.
    // Distinguish "DreamGraph tool exists but is unavailable right now"
    // from "intent is genuinely not covered by DreamGraph".
    const dreamgraphExistsForIntent = NATIVE_TOOL_CATALOG.some(
      (d) => d.intent === intent && isDreamGraphTier(d.tier),
    );
    if (dreamgraphExistsForIntent) {
      fallback = {
        reason: "mcp_tool_unavailable",
        preferredTier: preferred,
        chosenTier,
        note: `Preferred Tier ${preferred} tool for intent '${intent}' is not in the live MCP roster; falling back to Tier ${chosenTier}.`,
      };
    } else {
      fallback = {
        reason: "intent_not_covered_by_dreamgraph",
        preferredTier: preferred,
        chosenTier,
        note: `Intent '${intent}' has no DreamGraph-native tool by design; using Tier ${chosenTier}.`,
      };
    }
  } else if (chosenTier === 4 || chosenTier === 5) {
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

function freezeMap(
  m: Map<Tier, ToolDescriptor[]>,
): ReadonlyMap<Tier, readonly ToolDescriptor[]> {
  const out = new Map<Tier, readonly ToolDescriptor[]>();
  for (const [k, v] of m) out.set(k, Object.freeze([...v]));
  return out;
}

/**
 * Convenience predicate the orchestrator uses when deciding whether to
 * promote a `NoExecutorAvailable` into a `Blocker`.
 */
export function isNoExecutor(
  result: ExecutionPlan | NoExecutorAvailable,
): result is NoExecutorAvailable {
  return (result as NoExecutorAvailable).reason === "no_tier_covers_intent";
}
