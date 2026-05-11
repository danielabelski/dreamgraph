// architect-v2/autonomy/modes.ts
// Slice 3 — Autonomy mode names + mode profile table.
//
// STRICT ISOLATION (ADR-140): no import from v1.
//
// Per Slice 3 directive: carry only the v1 mode names and the concept of
// bounded autonomous continuation. Mode SEMANTICS are rebuilt from scratch
// as a data table indexed by mode (ADR-152). Modes differ ONLY by the values
// in this table, not by separate code branches anywhere in v2.

/**
 * (Preserved concept from v1 `AutonomyMode` — same four names, completely new
 * semantics. v1's per-mode `chooseActionForMode` and `shouldContinueAfterPass`
 * cascades are NOT ported.)
 */
export type AutonomyMode =
  | "cautious"
  | "conscientious"
  | "eager"
  | "autonomous";

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
export const MODE_PROFILES: Readonly<Record<AutonomyMode, ModeProfile>> =
  Object.freeze({
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

export function getModeProfile(mode: AutonomyMode): ModeProfile {
  return MODE_PROFILES[mode];
}
