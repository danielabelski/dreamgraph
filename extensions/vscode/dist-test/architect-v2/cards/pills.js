"use strict";
// STRICT ISOLATION (ADR-140): no import from v1.
// Slice 5 — 8-pill set rendered on every card. ADR-161.
Object.defineProperty(exports, "__esModule", { value: true });
exports.PILL_KINDS = void 0;
exports.computePills = computePills;
exports.PILL_KINDS = Object.freeze([
    'certainty',
    'mode',
    'provider',
    'graphBound',
    'autonomyState',
    'tier',
    'fallbackReason',
    'verificationStatus',
]);
/** Pure derivation. Same input → same output, no I/O. */
function computePills(input) {
    const tier = input.outcome?.tier ?? input.plan?.tier ?? null;
    const fallbackReason = input.plan?.fallbackJustification?.reason ?? null;
    const graphBound = deriveGraphBound(tier, fallbackReason);
    const verificationStatus = deriveVerificationStatus(input.evidence, input.outcome);
    return Object.freeze({
        certainty: input.certainty,
        mode: input.mode,
        provider: input.provider,
        graphBound,
        autonomyState: input.autonomyState,
        tier,
        fallbackReason,
        verificationStatus,
    });
}
function deriveGraphBound(tier, fallbackReason) {
    if (tier === null)
        return 'no';
    if (tier <= 3)
        return fallbackReason === null ? 'yes' : 'partial';
    // T4/T5 — by definition outside DreamGraph tiers.
    return 'no';
}
function deriveVerificationStatus(evidence, outcome) {
    const ev = evidence ?? (outcome && 'evidence' in outcome ? outcome.evidence : undefined);
    if (!ev)
        return null;
    return ev.passed ? 'passed' : 'failed';
}
//# sourceMappingURL=pills.js.map