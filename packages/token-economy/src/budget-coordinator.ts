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

/** Plan §4.8 — model-switch tuning. Marked final policy; revisit only on
 *  runtime evidence of harm. */
const MODEL_SWITCH_DEBT_CLAMP_FRACTION = 0.5; // |rescaled| <= 0.5 * newExpected
const MODEL_SWITCH_DEBT_DECAY = 0.5;          // multiply rescaled debt by 0.5
const MODEL_SWITCH_DOWNGRADE_RESET_RATIO = 0.25; // reset if newExpected < 0.25 * oldExpected

/** Plan §4.1 — single owner of the pressure-label thresholds. */
const PRESSURE_LABEL_THRESHOLDS = { lowMax: 0.0, normalMax: 0.5 } as const;

/** Plan §4.5 — default detailed-history retention. */
const DEFAULT_FULL_HISTORY_DEPTH = 20;

interface ComponentEntry {
  estimate?: number;
  actual?: number;
}

export class BudgetCoordinator {
  private readonly _expected: number;
  private readonly _ceiling: number;
  private readonly _debtCarry: number;
  private readonly _modelId: string;
  private readonly _turnNumber: number;
  private readonly _fullHistoryDepth: number;
  private readonly _previousSnapshot: BudgetSnapshot;

  /** Carried debt after model-switch rescaling — frozen for the turn. */
  private readonly _entryDebt: number;
  /** If a model switch happened on construction, capture it for history. */
  private readonly _modelSwitchEvent: BudgetSnapshotHistoryEntry["modelSwitch"];

  /** Component-level state for the current turn. */
  private readonly _components = new Map<string, ComponentEntry>();
  private readonly _compressions: CompressionRecord[] = [];
  /** Set when context builder reports an ADR-097 emergency trim. */
  private _graphSliceEmergencyTrim = false;
  private _finalized = false;
  private _finalSnapshot: BudgetSnapshot | null = null;

  constructor(snapshot: BudgetSnapshot | null, settings: BudgetCoordinatorSettings) {
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

  getSnapshot(): BudgetSnapshot {
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
  getPressure(): number {
    const target = this._turnTarget();
    if (target <= 0) return 1;
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

  getContextPressureLabel(): PressureLabel {
    const p = this.getPressure();
    if (p <= PRESSURE_LABEL_THRESHOLDS.lowMax) return "low";
    if (p <= PRESSURE_LABEL_THRESHOLDS.normalMax) return "normal";
    return "high";
  }

  /** Plan §4.1 — turnTarget − sum(actuals) − sum(unreconciled estimates). */
  getRemainingTargetTokens(): number {
    return Math.max(0, this._turnTarget() - this._committedTokens());
  }

  // -------------------------------------------------------------- Write side

  recordComponentEstimate(component: string, estimatedTokens: number): void {
    if (this._finalized) return;
    const entry = this._components.get(component) ?? {};
    entry.estimate = Math.max(0, Math.floor(estimatedTokens));
    this._components.set(component, entry);
  }

  recordComponentActual(component: string, actualTokens: number): void {
    if (this._finalized) return;
    const entry = this._components.get(component) ?? {};
    entry.actual = Math.max(0, Math.floor(actualTokens));
    // Reservation replaced (Plan §4.1 reconciliation semantics).
    entry.estimate = undefined;
    this._components.set(component, entry);
  }

  recordCompression(
    component: string,
    originalTokens: number,
    finalTokens: number,
    mode: CompressionMode,
  ): void {
    if (this._finalized) return;
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
  flagGraphSliceEmergencyTrim(): void {
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
  finalizeTurn(totalActualTokens?: number): BudgetSnapshot {
    if (this._finalized && this._finalSnapshot) {
      return this._finalSnapshot;
    }
    this._finalized = true;

    const components: Record<string, number> = {};
    let actualSum = 0;
    for (const [name, entry] of this._components) {
      if (entry.actual === undefined) continue; // unreconciled estimate — discard
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

    const history: BudgetSnapshotHistoryEntry[] = [...this._previousSnapshot.history];
    if (this._modelSwitchEvent) {
      history.push({
        turn: this._turnNumber,
        actual: 0,
        delta: 0,
        modelSwitch: this._modelSwitchEvent,
      });
    }
    const turnEntry: BudgetSnapshotHistoryEntry = {
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

    const finalSnapshot: BudgetSnapshot = {
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
  describe(): {
    target: number;
    remaining: number;
    pressure: number;
    label: PressureLabel;
    entryDebt: number;
    components: Array<{ name: string; estimate?: number; actual?: number }>;
    compressions: CompressionRecord[];
  } {
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

  private _turnTarget(): number {
    // target = expected - max(0, debt) + bonus, where bonus = max(0, -debt)
    const repay = Math.max(0, this._entryDebt);
    const bonus = Math.max(0, -this._entryDebt);
    return Math.max(1000, this._expected - repay + bonus);
  }

  private _committedTokens(): number {
    let total = 0;
    for (const entry of this._components.values()) {
      if (entry.actual !== undefined) total += entry.actual;
      else if (entry.estimate !== undefined) total += entry.estimate;
    }
    return total;
  }

  private _emptySnapshot(): BudgetSnapshot {
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
  private _rescaleForModelSwitch(prev: BudgetSnapshot): {
    debt: number;
    event?: BudgetSnapshotHistoryEntry["modelSwitch"];
  } {
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

// ---------------------------------------------------------------- Module helpers

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 1;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function pruneHistory(
  history: BudgetSnapshotHistoryEntry[],
  fullDepth: number,
): BudgetSnapshotHistoryEntry[] {
  if (history.length <= fullDepth) return history;
  const cutoff = history.length - fullDepth;
  return history.map((entry, idx) => {
    if (idx >= cutoff) return entry;
    if (!entry.components) return entry;
    const { components: _drop, ...rest } = entry;
    return rest;
  });
}

/** Token estimate fast path (Plan §7 open question 1 — char/4 heuristic). */
export function estimateTokensFromChars(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / 4);
}

/** Token estimate from string content. */
export function estimateTokensFromString(s: string | null | undefined): number {
  if (!s) return 0;
  return estimateTokensFromChars(s.length);
}
