export interface PassBudget {
    readonly total: number;
    readonly used: number;
    readonly remaining: number;
}
export declare function createPassBudget(total: number): PassBudget;
/**
 * Returns a new `PassBudget` with one more pass consumed. Throws if the
 * budget is already exhausted; callers are expected to check `remaining`
 * via `deriveNextAction()` before consuming.
 */
export declare function consumePass(budget: PassBudget): PassBudget;
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
export declare function createTimeBudget(totalMs: number, nowEpochMs: number): TimeBudget;
export declare function elapsedMs(budget: TimeBudget, nowEpochMs: number): number;
export declare function remainingMs(budget: TimeBudget, nowEpochMs: number): number;
export declare function isTimeBudgetExhausted(budget: TimeBudget, nowEpochMs: number): boolean;
/**
 * What the webview/status-line renders. Pure projection.
 */
export interface BudgetView {
    pass: {
        total: number;
        used: number;
        remaining: number;
    };
    time: {
        totalMs: number;
        usedMs: number;
        remainingMs: number;
    };
}
export declare function deriveBudgetView(pass: PassBudget, time: TimeBudget, nowEpochMs: number): BudgetView;
//# sourceMappingURL=budget.d.ts.map