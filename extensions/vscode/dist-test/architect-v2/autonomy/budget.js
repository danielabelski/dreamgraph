"use strict";
// architect-v2/autonomy/budget.ts
// Slice 3 — Pass budget + time budget shapes.
//
// STRICT ISOLATION (ADR-140): no import from v1.
//
// Per ADR-153: every autonomous run is bounded by BOTH a pass budget AND a
// wall-clock time budget. The run stops on whichever exhausts first. Both
// budgets expose `used` / `remaining` / `total` so the UI can display
// counters at all times (Slice 3 plan §1 carry-over).
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPassBudget = createPassBudget;
exports.consumePass = consumePass;
exports.createTimeBudget = createTimeBudget;
exports.elapsedMs = elapsedMs;
exports.remainingMs = remainingMs;
exports.isTimeBudgetExhausted = isTimeBudgetExhausted;
exports.deriveBudgetView = deriveBudgetView;
function createPassBudget(total) {
    if (!Number.isFinite(total) || total <= 0 || !Number.isInteger(total)) {
        throw new RangeError(`PassBudget.total must be a positive integer; received ${total}.`);
    }
    return { total, used: 0, remaining: total };
}
/**
 * Returns a new `PassBudget` with one more pass consumed. Throws if the
 * budget is already exhausted; callers are expected to check `remaining`
 * via `deriveNextAction()` before consuming.
 */
function consumePass(budget) {
    if (budget.remaining <= 0) {
        throw new RangeError("PassBudget already exhausted; cannot consume.");
    }
    const used = budget.used + 1;
    return { total: budget.total, used, remaining: budget.total - used };
}
function createTimeBudget(totalMs, nowEpochMs) {
    if (!Number.isFinite(totalMs) || totalMs <= 0) {
        throw new RangeError(`TimeBudget.totalMs must be > 0; received ${totalMs}.`);
    }
    if (!Number.isFinite(nowEpochMs)) {
        throw new RangeError("TimeBudget startedAt must be a finite epoch ms.");
    }
    return { totalMs, startedAtEpochMs: nowEpochMs };
}
function elapsedMs(budget, nowEpochMs) {
    return Math.max(0, nowEpochMs - budget.startedAtEpochMs);
}
function remainingMs(budget, nowEpochMs) {
    return Math.max(0, budget.totalMs - elapsedMs(budget, nowEpochMs));
}
function isTimeBudgetExhausted(budget, nowEpochMs) {
    return remainingMs(budget, nowEpochMs) <= 0;
}
function deriveBudgetView(pass, time, nowEpochMs) {
    return {
        pass: { total: pass.total, used: pass.used, remaining: pass.remaining },
        time: {
            totalMs: time.totalMs,
            usedMs: elapsedMs(time, nowEpochMs),
            remainingMs: remainingMs(time, nowEpochMs),
        },
    };
}
//# sourceMappingURL=budget.js.map