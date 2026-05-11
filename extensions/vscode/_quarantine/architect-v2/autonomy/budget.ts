// architect-v2/autonomy/budget.ts
// Slice 3 — Pass budget + time budget shapes.
//
// STRICT ISOLATION (ADR-140): no import from v1.
//
// Per ADR-153: every autonomous run is bounded by BOTH a pass budget AND a
// wall-clock time budget. The run stops on whichever exhausts first. Both
// budgets expose `used` / `remaining` / `total` so the UI can display
// counters at all times (Slice 3 plan §1 carry-over).

// ---------------------------------------------------------------------------
// Pass budget
// ---------------------------------------------------------------------------

export interface PassBudget {
  readonly total: number;
  readonly used: number;
  readonly remaining: number;
}

export function createPassBudget(total: number): PassBudget {
  if (!Number.isFinite(total) || total <= 0 || !Number.isInteger(total)) {
    throw new RangeError(
      `PassBudget.total must be a positive integer; received ${total}.`,
    );
  }
  return { total, used: 0, remaining: total };
}

/**
 * Returns a new `PassBudget` with one more pass consumed. Throws if the
 * budget is already exhausted; callers are expected to check `remaining`
 * via `deriveNextAction()` before consuming.
 */
export function consumePass(budget: PassBudget): PassBudget {
  if (budget.remaining <= 0) {
    throw new RangeError("PassBudget already exhausted; cannot consume.");
  }
  const used = budget.used + 1;
  return { total: budget.total, used, remaining: budget.total - used };
}

// ---------------------------------------------------------------------------
// Time budget
// ---------------------------------------------------------------------------

/**
 * Wall-clock budget. The engine never mutates this; it queries
 * `elapsedMs(now)` / `remainingMs(now)` against an injected clock.
 * Defaulted per mode (`ModeProfile.defaultTimeBudgetMs`) but overrideable
 * per run.
 */
export interface TimeBudget {
  readonly totalMs: number;
  readonly startedAtEpochMs: number;
}

export function createTimeBudget(totalMs: number, nowEpochMs: number): TimeBudget {
  if (!Number.isFinite(totalMs) || totalMs <= 0) {
    throw new RangeError(
      `TimeBudget.totalMs must be > 0; received ${totalMs}.`,
    );
  }
  if (!Number.isFinite(nowEpochMs)) {
    throw new RangeError("TimeBudget startedAt must be a finite epoch ms.");
  }
  return { totalMs, startedAtEpochMs: nowEpochMs };
}

export function elapsedMs(budget: TimeBudget, nowEpochMs: number): number {
  return Math.max(0, nowEpochMs - budget.startedAtEpochMs);
}

export function remainingMs(budget: TimeBudget, nowEpochMs: number): number {
  return Math.max(0, budget.totalMs - elapsedMs(budget, nowEpochMs));
}

export function isTimeBudgetExhausted(
  budget: TimeBudget,
  nowEpochMs: number,
): boolean {
  return remainingMs(budget, nowEpochMs) <= 0;
}

// ---------------------------------------------------------------------------
// View shape (for UI counters)
// ---------------------------------------------------------------------------

/**
 * What the webview/status-line renders. Pure projection.
 */
export interface BudgetView {
  pass: { total: number; used: number; remaining: number };
  time: { totalMs: number; usedMs: number; remainingMs: number };
}

export function deriveBudgetView(
  pass: PassBudget,
  time: TimeBudget,
  nowEpochMs: number,
): BudgetView {
  return {
    pass: { total: pass.total, used: pass.used, remaining: pass.remaining },
    time: {
      totalMs: time.totalMs,
      usedMs: elapsedMs(time, nowEpochMs),
      remainingMs: remainingMs(time, nowEpochMs),
    },
  };
}
