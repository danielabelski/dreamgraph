"use strict";
// architect-v2/autonomy/modes.ts
// Slice 3 — Autonomy mode names + mode profile table.
//
// STRICT ISOLATION (ADR-140): no import from v1.
//
// Per Slice 3 directive: carry only the v1 mode names and the concept of
// bounded autonomous continuation. Mode SEMANTICS are rebuilt from scratch
// as a data table indexed by mode (ADR-152). Modes differ ONLY by the values
// in this table, not by separate code branches anywhere in v2.
Object.defineProperty(exports, "__esModule", { value: true });
exports.MODE_PROFILES = void 0;
exports.getModeProfile = getModeProfile;
/**
 * Initial calibration. Values are deliberate but tunable; any change
 * requires a superseding ADR per the Slice 3 plan §2.
 */
exports.MODE_PROFILES = Object.freeze({
    cautious: Object.freeze({
        mode: "cautious",
        defaultPassBudget: 3,
        defaultTimeBudgetMs: 2 * 60 * 1000,
        confidenceThreshold: 0.95,
        blockerTolerance: 0,
        verificationStrictness: "strict",
    }),
    conscientious: Object.freeze({
        mode: "conscientious",
        defaultPassBudget: 8,
        defaultTimeBudgetMs: 5 * 60 * 1000,
        confidenceThreshold: 0.85,
        blockerTolerance: 0,
        verificationStrictness: "strict",
    }),
    eager: Object.freeze({
        mode: "eager",
        defaultPassBudget: 20,
        defaultTimeBudgetMs: 10 * 60 * 1000,
        confidenceThreshold: 0.70,
        blockerTolerance: 1,
        verificationStrictness: "normal",
    }),
    autonomous: Object.freeze({
        mode: "autonomous",
        defaultPassBudget: 50,
        defaultTimeBudgetMs: 30 * 60 * 1000,
        confidenceThreshold: 0.55,
        blockerTolerance: 2,
        verificationStrictness: "normal",
    }),
});
function getModeProfile(mode) {
    return exports.MODE_PROFILES[mode];
}
//# sourceMappingURL=modes.js.map