/**
 * Strict execution priority tiers. Lower number = higher priority.
 * `selectExecutor` walks tiers in ascending order.
 *
 * (Preserved concept from v1 implicit tool grouping — but expressed as an
 * explicit ordered enum so the priority is visible and testable.)
 */
export type Tier = 1 | 2 | 3 | 4 | 5;
export declare const TIER_NAMES: Readonly<Record<Tier, string>>;
/** Canonical ordering used by every tier-walk in this module. */
export declare const TIER_ORDER: readonly Tier[];
/** True if `tier` is a DreamGraph-native tier (T1–T3). */
export declare function isDreamGraphTier(tier: Tier): boolean;
/** True if `tier` is a fallback tier (T4 VS Code, T5 shell). */
export declare function isFallbackTier(tier: Tier): boolean;
//# sourceMappingURL=tiers.d.ts.map