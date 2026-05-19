export type AutonomyMode = 'cautious' | 'conscientious' | 'eager' | 'autonomous';
export type UncertaintyLevel = 'low' | 'medium' | 'high';
export type ProgressStatus = 'advancing' | 'slowing' | 'stalled';
export type SelectionMode = 'user' | 'self' | 'none';
export interface AutonomyState {
    mode: AutonomyMode;
    remainingAutoPasses: number;
    completedAutoPasses: number;
    totalAuthorizedPasses?: number;
    /** Wall-clock budget total, in ms. Optional — when absent the bar shows '—'. */
    timeBudgetTotalMs?: number;
    /** Epoch ms when the current time budget started counting. Optional — only set when timeBudgetTotalMs is set. */
    timeBudgetStartedAtEpochMs?: number;
    /** Number of consecutive passes that produced no real work
     * (no tool calls, no file edits, no envelope summary text). Used to
     * break out of pathological counter-spam loops where the model keeps
     * "continuing" without ever doing anything. */
    consecutiveEmptyPasses?: number;
    /** True once the architect has identified a concrete patch anchor or
     * actually performed a write — i.e. the "what to change" question is
     * answered. After this point, additional pure-read passes count as
     * non-progress (see analyzePass). Cleared whenever a write tool runs
     * successfully so a follow-up edit cycle can re-discover its own anchor. */
    patchAnchorEstablished?: boolean;
    /** Concrete file paths the architect named as the patch site in the
     * most recent pass that established or re-confirmed the anchor.
     * Compared across passes by the two-strike token-economy stop rule:
     * if a follow-up locate-only pass names a *different* set of paths,
     * that counts as legitimate re-anchoring (anchor moved) and the loop
     * is allowed to continue; same-set re-locates count as waste. */
    lastAnchorPaths?: readonly string[];
    /** True when the previous pass executed only read tool calls and made
     * no file edits. Together with the same flag for the current pass and
     * the lastAnchorPaths comparison, this drives the two-strike
     * token-economy stop rule in `shouldContinueAfterPass`. */
    lastPassWasLocateOnly?: boolean;
}
export interface PassOutcomeSignal {
    hasClearNextStep: boolean;
    uncertainty: UncertaintyLevel;
    hasBlockingFailure: boolean;
    nextStepWithinScope: boolean;
    goalSufficientlyReached: boolean;
    progressStatus: ProgressStatus;
    nextStepIsNearTrivial?: boolean;
    nextStepIsDefining?: boolean;
    /** True when the pass produced no tool calls, no file edits, no
     * envelope summary, and no recommended actions — i.e. the model
     * "reported" only autonomy counters. */
    isEmptyPass?: boolean;
}
export interface RecommendedAction {
    id: string;
    label: string;
    rationale?: string;
    priority: number;
    eligible: boolean;
    withinScope: boolean;
    mutuallyExclusiveWith?: string[];
    batchGroup?: string;
    /** Exact MCP/local tool name to run for this action, when applicable. */
    tool?: string;
    /** Pre-bound arguments for `tool`. */
    toolArgs?: Record<string, unknown>;
}
export interface RecommendedActionSet {
    actions: RecommendedAction[];
    doAllEligible: boolean;
    topActionId?: string;
}
export interface ContinuationDecision {
    shouldContinue: boolean;
    reason: string;
    selectionMode: SelectionMode;
}
export interface AutonomyStatusView {
    mode: AutonomyMode;
    countingActive: boolean;
    completed: number;
    remaining: number;
    totalAuthorized?: number;
    /** Wall-clock budget total in ms (per ADR-153). Optional. */
    timeBudgetTotalMs?: number;
    /** Epoch ms when the time budget started ticking. Optional, paired with totalMs. */
    timeBudgetStartedAtEpochMs?: number;
    summary: string;
}
export interface AutonomyInstructionState extends AutonomyState {
    enabled?: boolean;
}
export declare function createAutonomyState(mode?: AutonomyMode, totalAuthorizedPasses?: number, timeBudgetTotalMs?: number, timeBudgetStartedAtEpochMs?: number): AutonomyState;
export declare function isPassCountingActive(state: AutonomyState | undefined): boolean;
export declare function decrementPassBudget(state: AutonomyState): AutonomyState;
export declare function deriveAutonomyStatusView(state: AutonomyState): AutonomyStatusView;
export interface ModeProfile {
    readonly mode: AutonomyMode;
    /** Default pass budget for this mode (ADR-153 PassBudget total). */
    readonly defaultPassBudget: number;
    /** Default wall-clock budget in ms (ADR-153 TimeBudget totalMs). */
    readonly defaultTimeBudgetMs: number;
}
export declare const MODE_PROFILES: Readonly<Record<AutonomyMode, ModeProfile>>;
export declare function getModeProfile(mode: AutonomyMode): ModeProfile;
/**
 * Build a fresh `AutonomyState` from a mode's profile (pass budget + time
 * budget started now). Used when the user explicitly switches mode via the
 * header dropdown — explicit selection means "start a new session under this
 * mode's policy".
 */
export declare function applyModeProfileToState(mode: AutonomyMode, nowEpochMs?: number): AutonomyState;
export declare function rankRecommendedActions(actions: RecommendedAction[]): RecommendedActionSet;
export declare function computeDoAllEligibility(actions: RecommendedAction[]): boolean;
export declare function chooseActionForMode(mode: AutonomyMode, actionSet: RecommendedActionSet, signal: PassOutcomeSignal): string | undefined;
export declare function shouldContinueAfterPass(state: AutonomyState, signal: PassOutcomeSignal, actionSet?: RecommendedActionSet): ContinuationDecision;
export declare function getAutonomyInstructionBlock(state?: AutonomyInstructionState): string;
//# sourceMappingURL=autonomy.d.ts.map