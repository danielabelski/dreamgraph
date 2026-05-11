// architect-v2/execution/tiers.ts
// Slice 4 — Tier enum and canonical ordering.
//
// STRICT ISOLATION (ADR-140): no import from v1.
// Tiers encode ADR-144's 5-tier execution priority.

/**
 * Strict execution priority tiers. Lower number = higher priority.
 * `selectExecutor` walks tiers in ascending order.
 *
 * (Preserved concept from v1 implicit tool grouping — but expressed as an
 * explicit ordered enum so the priority is visible and testable.)
 */
export type Tier = 1 | 2 | 3 | 4 | 5;

export const TIER_NAMES: Readonly<Record<Tier, string>> = Object.freeze({
  1: "mcp_knowledge",
  2: "mcp_mutation",
  3: "mcp_verification",
  4: "vscode_editor",
  5: "shell",
});

/** Canonical ordering used by every tier-walk in this module. */
export const TIER_ORDER: readonly Tier[] = Object.freeze([1, 2, 3, 4, 5]);

/** True if `tier` is a DreamGraph-native tier (T1–T3). */
export function isDreamGraphTier(tier: Tier): boolean {
  return tier === 1 || tier === 2 || tier === 3;
}

/** True if `tier` is a fallback tier (T4 VS Code, T5 shell). */
export function isFallbackTier(tier: Tier): boolean {
  return tier === 4 || tier === 5;
}
