/**
 * (Preserved concept from v1 `AutonomyMode` — same four names, completely new
 * semantics. v1's per-mode `chooseActionForMode` and `shouldContinueAfterPass`
 * cascades are NOT ported.)
 */
export type AutonomyMode = "cautious" | "conscientious" | "eager" | "autonomous";
/**
 * How strict verification gating is. 'strict' stops the run on any
 * `VerificationFailure` in the last pass. 'normal' allows continuation
 * while verification is in flight or has soft-failed.
 */
export type VerificationStrictness = "strict" | "normal";
/**
 * Per-mode behavior knobs. Every mode is one row in `MODE_PROFILES`. Adding a
 * fifth mode is one new row plus widening `AutonomyMode`.
 */
export interface ModeProfile {
    readonly mode: AutonomyMode;
    /** Default pass budget for this mode. Caller may override per run. */
    readonly defaultPassBudget: number;
    /** Default wall-clock budget in milliseconds. Caller may override per run. */
    readonly defaultTimeBudgetMs: number;
    /**
     * Minimum confidence the top-ranked action must reach for the engine to
     * self-select it. Below this, the engine pauses for user input.
     * Range: 0..1.
     */
    readonly confidenceThreshold: number;
    /**
     * How many SOFT blockers may accumulate before the engine stops. HARD
     * blockers always stop on the first occurrence regardless of mode.
     */
    readonly blockerTolerance: number;
    readonly verificationStrictness: VerificationStrictness;
}
/**
 * Initial calibration. Values are deliberate but tunable; any change
 * requires a superseding ADR per the Slice 3 plan §2.
 */
export declare const MODE_PROFILES: Readonly<Record<AutonomyMode, ModeProfile>>;
export declare function getModeProfile(mode: AutonomyMode): ModeProfile;
//# sourceMappingURL=modes.d.ts.map