"use strict";
// architect-v2/execution/tiers.ts
// Slice 4 — Tier enum and canonical ordering.
//
// STRICT ISOLATION (ADR-140): no import from v1.
// Tiers encode ADR-144's 5-tier execution priority.
Object.defineProperty(exports, "__esModule", { value: true });
exports.TIER_ORDER = exports.TIER_NAMES = void 0;
exports.isDreamGraphTier = isDreamGraphTier;
exports.isFallbackTier = isFallbackTier;
exports.TIER_NAMES = Object.freeze({
    1: "mcp_knowledge",
    2: "mcp_mutation",
    3: "mcp_verification",
    4: "vscode_editor",
    5: "shell",
});
/** Canonical ordering used by every tier-walk in this module. */
exports.TIER_ORDER = Object.freeze([1, 2, 3, 4, 5]);
/** True if `tier` is a DreamGraph-native tier (T1–T3). */
function isDreamGraphTier(tier) {
    return tier === 1 || tier === 2 || tier === 3;
}
/** True if `tier` is a fallback tier (T4 VS Code, T5 shell). */
function isFallbackTier(tier) {
    return tier === 4 || tier === 5;
}
//# sourceMappingURL=tiers.js.map