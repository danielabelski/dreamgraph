/**
 * BudgetCoordinator — turn-scoped owner of token-budget behavior.
 *
 * See plans/NEVER_FAIL_BUDGET_DEBT_PLAN.md (Section 4) for the full design.
 *
 * Phase 1 scope (this file):
 *   - In-memory only. Persistence is a no-op handled by the caller.
 *   - All three subsystems (tool result layer, context builder, reasoning packet)
 *     report and consume through this single object per turn.
 *   - No behavioral changes yet — this validates the contract end-to-end and
 *     produces component-level history that we can read in the dev console.
 *
 * Hard rule (Plan §4.0): `getPressure()` and the `low|normal|high` label are
 * computed only here. No subsystem may derive its own pressure value.
 */
export type CompressionMode = "verbatim" | "expected" | "debt-repay" | "envelope-preserved";
export type PressureLabel = "low" | "normal" | "high";
export interface BudgetSnapshotHistoryEntry {
    turn: number;
    actual: number;
    delta: number;
    components?: Record<string, number>;
    /** Set when this turn intentionally trimmed the ADR-097 graph slice below
     *  its reserved floor to avoid a transport-ceiling breach. */
    graphSliceEmergencyTrim?: boolean;
    /** Synthetic entry recording a model switch and its rescaling math. */
    modelSwitch?: {
        from: string;
        to: string;
        ratio: number;
        oldDebt: number;
        newDebt: number;
    };
}
export interface BudgetSnapshot {
    /** Signed; positive = over-spent, negative = saved budget. */
    debtTokens: number;
    /** Base soft target (from settings). */
    expectedTokens: number;
    /** Transport safety ceiling — never aimed at, only consulted in emergencies. */
    ceilingTokens: number;
    /** Most recent finalized turn total. */
    lastActualTokens: number;
    /** Model identity at the time the snapshot was last written. */
    modelId: string;
    history: BudgetSnapshotHistoryEntry[];
}
export interface BudgetCoordinatorSettings {
    /** Plan §5: `expectedTokensPerTurn`. */
    expectedTokensPerTurn: number;
    /** Plan §5: `transportCeilingTokens`. */
    transportCeilingTokens: number;
    /** Plan §5: `debtCarryFraction` (0..1). */
    debtCarryFraction: number;
    /** Current turn number, monotonically increasing across the conversation. */
    turnNumber: number;
    /** Current model id; used for cross-model rescaling on construction. */
    modelId: string;
    /** Plan §4.5 retention: how many turns keep the per-component breakdown. */
    fullHistoryDepth?: number;
}
export interface CompressionRecord {
    component: string;
    originalTokens: number;
    finalTokens: number;
    mode: CompressionMode;
}
export declare class BudgetCoordinator {
    private readonly _expected;
    private readonly _ceiling;
    private readonly _debtCarry;
    private readonly _modelId;
    private readonly _turnNumber;
    private readonly _fullHistoryDepth;
    private readonly _previousSnapshot;
    /** Carried debt after model-switch rescaling — frozen for the turn. */
    private readonly _entryDebt;
    /** If a model switch happened on construction, capture it for history. */
    private readonly _modelSwitchEvent;
    /** Component-level state for the current turn. */
    private readonly _components;
    private readonly _compressions;
    /** Set when context builder reports an ADR-097 emergency trim. */
    private _graphSliceEmergencyTrim;
    private _finalized;
    private _finalSnapshot;
    constructor(snapshot: BudgetSnapshot | null, settings: BudgetCoordinatorSettings);
    getSnapshot(): BudgetSnapshot;
    /** Plan §4.1 — pressure in roughly -1..+1.
     *  Negative = under-budget headroom available; positive = squeezed. */
    getPressure(): number;
    getContextPressureLabel(): PressureLabel;
    /** Plan §4.1 — turnTarget − sum(actuals) − sum(unreconciled estimates). */
    getRemainingTargetTokens(): number;
    recordComponentEstimate(component: string, estimatedTokens: number): void;
    recordComponentActual(component: string, actualTokens: number): void;
    recordCompression(component: string, originalTokens: number, finalTokens: number, mode: CompressionMode): void;
    /** Plan §4.4 — context builder calls this when it intentionally trims the
     *  ADR-097 reserved graph slice below its floor for emergency transport
     *  protection. The flag rides along into history for auditing. */
    flagGraphSliceEmergencyTrim(): void;
    /**
     * Caller persists the returned snapshot. Discards any unreconciled estimates
     * (they were never produced) per Plan §4.1.
     *
     * @param totalActualTokens optional measured envelope total. When omitted,
     *   the coordinator uses the sum of reported component actuals.
     */
    finalizeTurn(totalActualTokens?: number): BudgetSnapshot;
    /** Dev-console aid for Phase 1 — shape-stable summary, safe to log. */
    describe(): {
        target: number;
        remaining: number;
        pressure: number;
        label: PressureLabel;
        entryDebt: number;
        components: Array<{
            name: string;
            estimate?: number;
            actual?: number;
        }>;
        compressions: CompressionRecord[];
    };
    private _turnTarget;
    private _committedTokens;
    private _emptySnapshot;
    /** Plan §4.8 — model-switch debt rescaling with bounded guard rails. */
    private _rescaleForModelSwitch;
}
/** Token estimate fast path (Plan §7 open question 1 — char/4 heuristic). */
export declare function estimateTokensFromChars(chars: number): number;
/** Token estimate from string content. */
export declare function estimateTokensFromString(s: string | null | undefined): number;
//# sourceMappingURL=budget-coordinator.d.ts.map