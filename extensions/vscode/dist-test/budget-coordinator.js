"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.BudgetCoordinator = void 0;
exports.estimateTokensFromChars = estimateTokensFromChars;
exports.estimateTokensFromString = estimateTokensFromString;
/** Plan §4.8 — model-switch tuning. Marked final policy; revisit only on
 *  runtime evidence of harm. */
const MODEL_SWITCH_DEBT_CLAMP_FRACTION = 0.5; // |rescaled| <= 0.5 * newExpected
const MODEL_SWITCH_DEBT_DECAY = 0.5; // multiply rescaled debt by 0.5
const MODEL_SWITCH_DOWNGRADE_RESET_RATIO = 0.25; // reset if newExpected < 0.25 * oldExpected
/** Plan §4.1 — single owner of the pressure-label thresholds. */
const PRESSURE_LABEL_THRESHOLDS = { lowMax: 0.0, normalMax: 0.5 };
/** Plan §4.5 — default detailed-history retention. */
const DEFAULT_FULL_HISTORY_DEPTH = 20;
class BudgetCoordinator {
    _expected;
    _ceiling;
    _debtCarry;
    _modelId;
    _turnNumber;
    _fullHistoryDepth;
    _previousSnapshot;
    /** Carried debt after model-switch rescaling — frozen for the turn. */
    _entryDebt;
    /** If a model switch happened on construction, capture it for history. */
    _modelSwitchEvent;
    /** Component-level state for the current turn. */
    _components = new Map();
    _compressions = [];
    /** Set when context builder reports an ADR-097 emergency trim. */
    _graphSliceEmergencyTrim = false;
    _finalized = false;
    _finalSnapshot = null;
    constructor(snapshot, settings) {
        this._expected = Math.max(1000, Math.floor(settings.expectedTokensPerTurn));
        this._ceiling = Math.max(this._expected, Math.floor(settings.transportCeilingTokens));
        this._debtCarry = clamp01(settings.debtCarryFraction);
        this._modelId = settings.modelId;
        this._turnNumber = settings.turnNumber;
        this._fullHistoryDepth = Math.max(1, settings.fullHistoryDepth ?? DEFAULT_FULL_HISTORY_DEPTH);
        this._previousSnapshot = snapshot ?? this._emptySnapshot();
        const rescale = this._rescaleForModelSwitch(this._previousSnapshot);
        this._entryDebt = rescale.debt;
        this._modelSwitchEvent = rescale.event;
    }
    // --------------------------------------------------------------- Read side
    getSnapshot() {
        // Live snapshot view — does NOT mutate state.
        return {
            debtTokens: this._entryDebt,
            expectedTokens: this._expected,
            ceilingTokens: this._ceiling,
            lastActualTokens: this._previousSnapshot.lastActualTokens,
            modelId: this._modelId,
            history: this._previousSnapshot.history,
        };
    }
    /** Plan §4.1 — pressure in roughly -1..+1.
     *  Negative = under-budget headroom available; positive = squeezed. */
    getPressure() {
        const target = this._turnTarget();
        if (target <= 0)
            return 1;
        const committed = this._committedTokens();
        // pressure scales committed-vs-target, plus a debt nudge so a heavy ledger
        // raises pressure even before this turn fills up.
        const fillRatio = committed / target;
        const debtNudge = this._entryDebt > 0
            ? Math.min(0.5, this._entryDebt / this._expected)
            : Math.max(-0.5, this._entryDebt / this._expected);
        const raw = fillRatio - 1 + debtNudge;
        return Math.max(-1, Math.min(1, raw));
    }
    getContextPressureLabel() {
        const p = this.getPressure();
        if (p <= PRESSURE_LABEL_THRESHOLDS.lowMax)
            return "low";
        if (p <= PRESSURE_LABEL_THRESHOLDS.normalMax)
            return "normal";
        return "high";
    }
    /** Plan §4.1 — turnTarget − sum(actuals) − sum(unreconciled estimates). */
    getRemainingTargetTokens() {
        return Math.max(0, this._turnTarget() - this._committedTokens());
    }
    // -------------------------------------------------------------- Write side
    recordComponentEstimate(component, estimatedTokens) {
        if (this._finalized)
            return;
        const entry = this._components.get(component) ?? {};
        entry.estimate = Math.max(0, Math.floor(estimatedTokens));
        this._components.set(component, entry);
    }
    recordComponentActual(component, actualTokens) {
        if (this._finalized)
            return;
        const entry = this._components.get(component) ?? {};
        entry.actual = Math.max(0, Math.floor(actualTokens));
        // Reservation replaced (Plan §4.1 reconciliation semantics).
        entry.estimate = undefined;
        this._components.set(component, entry);
    }
    recordCompression(component, originalTokens, finalTokens, mode) {
        if (this._finalized)
            return;
        this._compressions.push({
            component,
            originalTokens: Math.max(0, Math.floor(originalTokens)),
            finalTokens: Math.max(0, Math.floor(finalTokens)),
            mode,
        });
    }
    /** Plan §4.4 — context builder calls this when it intentionally trims the
     *  ADR-097 reserved graph slice below its floor for emergency transport
     *  protection. The flag rides along into history for auditing. */
    flagGraphSliceEmergencyTrim() {
        this._graphSliceEmergencyTrim = true;
    }
    // ---------------------------------------------------------------- Lifecycle
    /**
     * Caller persists the returned snapshot. Discards any unreconciled estimates
     * (they were never produced) per Plan §4.1.
     *
     * @param totalActualTokens optional measured envelope total. When omitted,
     *   the coordinator uses the sum of reported component actuals.
     */
    finalizeTurn(totalActualTokens) {
        if (this._finalized && this._finalSnapshot) {
            return this._finalSnapshot;
        }
        this._finalized = true;
        const components = {};
        let actualSum = 0;
        for (const [name, entry] of this._components) {
            if (entry.actual === undefined)
                continue; // unreconciled estimate — discard
            components[name] = entry.actual;
            actualSum += entry.actual;
        }
        const actual = typeof totalActualTokens === "number" && Number.isFinite(totalActualTokens)
            ? Math.max(0, Math.floor(totalActualTokens))
            : actualSum;
        // Plan §4.1: debt math is from delivered actuals only. Compression metadata
        // is explanatory, not separately billable.
        const overspend = actual - this._expected;
        const newDebt = this._entryDebt + overspend * this._debtCarry;
        const history = [...this._previousSnapshot.history];
        if (this._modelSwitchEvent) {
            history.push({
                turn: this._turnNumber,
                actual: 0,
                delta: 0,
                modelSwitch: this._modelSwitchEvent,
            });
        }
        const turnEntry = {
            turn: this._turnNumber,
            actual,
            delta: overspend,
            components,
        };
        if (this._graphSliceEmergencyTrim) {
            turnEntry.graphSliceEmergencyTrim = true;
        }
        history.push(turnEntry);
        // Plan §4.5 retention: keep full detail for the last N turns, strip
        // components from older entries.
        const prunedHistory = pruneHistory(history, this._fullHistoryDepth);
        const finalSnapshot = {
            debtTokens: newDebt,
            expectedTokens: this._expected,
            ceilingTokens: this._ceiling,
            lastActualTokens: actual,
            modelId: this._modelId,
            history: prunedHistory,
        };
        this._finalSnapshot = finalSnapshot;
        return finalSnapshot;
    }
    // --------------------------------------------------------------- Diagnostics
    /** Dev-console aid for Phase 1 — shape-stable summary, safe to log. */
    describe() {
        return {
            target: this._turnTarget(),
            remaining: this.getRemainingTargetTokens(),
            pressure: this.getPressure(),
            label: this.getContextPressureLabel(),
            entryDebt: this._entryDebt,
            components: Array.from(this._components.entries()).map(([name, e]) => ({
                name,
                estimate: e.estimate,
                actual: e.actual,
            })),
            compressions: [...this._compressions],
        };
    }
    // -------------------------------------------------------------------- Internals
    _turnTarget() {
        // target = expected - max(0, debt) + bonus, where bonus = max(0, -debt)
        const repay = Math.max(0, this._entryDebt);
        const bonus = Math.max(0, -this._entryDebt);
        return Math.max(1000, this._expected - repay + bonus);
    }
    _committedTokens() {
        let total = 0;
        for (const entry of this._components.values()) {
            if (entry.actual !== undefined)
                total += entry.actual;
            else if (entry.estimate !== undefined)
                total += entry.estimate;
        }
        return total;
    }
    _emptySnapshot() {
        return {
            debtTokens: 0,
            expectedTokens: this._expected,
            ceilingTokens: this._ceiling,
            lastActualTokens: 0,
            modelId: this._modelId,
            history: [],
        };
    }
    /** Plan §4.8 — model-switch debt rescaling with bounded guard rails. */
    _rescaleForModelSwitch(prev) {
        if (prev.modelId === this._modelId) {
            return { debt: prev.debtTokens };
        }
        const oldExpected = Math.max(1, prev.expectedTokens);
        const newExpected = this._expected;
        const ratio = newExpected / oldExpected;
        // Extreme downgrade — old ledger is no longer meaningful at the new scale.
        if (newExpected < MODEL_SWITCH_DOWNGRADE_RESET_RATIO * oldExpected) {
            return {
                debt: 0,
                event: {
                    from: prev.modelId,
                    to: this._modelId,
                    ratio,
                    oldDebt: prev.debtTokens,
                    newDebt: 0,
                },
            };
        }
        const provisional = prev.debtTokens * ratio;
        const decayed = provisional * MODEL_SWITCH_DEBT_DECAY;
        const clampMagnitude = MODEL_SWITCH_DEBT_CLAMP_FRACTION * newExpected;
        const clamped = Math.max(-clampMagnitude, Math.min(clampMagnitude, decayed));
        return {
            debt: clamped,
            event: {
                from: prev.modelId,
                to: this._modelId,
                ratio,
                oldDebt: prev.debtTokens,
                newDebt: clamped,
            },
        };
    }
}
exports.BudgetCoordinator = BudgetCoordinator;
// ---------------------------------------------------------------- Module helpers
function clamp01(n) {
    if (!Number.isFinite(n))
        return 1;
    if (n < 0)
        return 0;
    if (n > 1)
        return 1;
    return n;
}
function pruneHistory(history, fullDepth) {
    if (history.length <= fullDepth)
        return history;
    const cutoff = history.length - fullDepth;
    return history.map((entry, idx) => {
        if (idx >= cutoff)
            return entry;
        if (!entry.components)
            return entry;
        const { components: _drop, ...rest } = entry;
        return rest;
    });
}
/** Token estimate fast path (Plan §7 open question 1 — char/4 heuristic). */
function estimateTokensFromChars(chars) {
    if (!Number.isFinite(chars) || chars <= 0)
        return 0;
    return Math.ceil(chars / 4);
}
/** Token estimate from string content. */
function estimateTokensFromString(s) {
    if (!s)
        return 0;
    return estimateTokensFromChars(s.length);
}
//# sourceMappingURL=budget-coordinator.js.map