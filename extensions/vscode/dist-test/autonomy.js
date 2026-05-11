"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MODE_PROFILES = void 0;
exports.createAutonomyState = createAutonomyState;
exports.isPassCountingActive = isPassCountingActive;
exports.decrementPassBudget = decrementPassBudget;
exports.deriveAutonomyStatusView = deriveAutonomyStatusView;
exports.getModeProfile = getModeProfile;
exports.applyModeProfileToState = applyModeProfileToState;
exports.rankRecommendedActions = rankRecommendedActions;
exports.computeDoAllEligibility = computeDoAllEligibility;
exports.chooseActionForMode = chooseActionForMode;
exports.shouldContinueAfterPass = shouldContinueAfterPass;
exports.getAutonomyInstructionBlock = getAutonomyInstructionBlock;
function createAutonomyState(mode = 'cautious', totalAuthorizedPasses, timeBudgetTotalMs, timeBudgetStartedAtEpochMs) {
    const remaining = typeof totalAuthorizedPasses === 'number' && totalAuthorizedPasses > 0 ? totalAuthorizedPasses : 0;
    const hasTime = typeof timeBudgetTotalMs === 'number' && timeBudgetTotalMs > 0;
    return {
        mode,
        remainingAutoPasses: remaining,
        completedAutoPasses: 0,
        totalAuthorizedPasses: totalAuthorizedPasses && totalAuthorizedPasses > 0 ? totalAuthorizedPasses : undefined,
        timeBudgetTotalMs: hasTime ? timeBudgetTotalMs : undefined,
        timeBudgetStartedAtEpochMs: hasTime ? (timeBudgetStartedAtEpochMs ?? Date.now()) : undefined,
    };
}
function isPassCountingActive(state) {
    return !!state && ((state.totalAuthorizedPasses ?? 0) > 0 || state.completedAutoPasses > 0 || state.remainingAutoPasses > 0);
}
function decrementPassBudget(state) {
    const hadBudget = typeof state.totalAuthorizedPasses === 'number' && state.totalAuthorizedPasses > 0;
    return {
        ...state,
        completedAutoPasses: state.completedAutoPasses + 1,
        remainingAutoPasses: hadBudget ? Math.max(0, state.remainingAutoPasses - 1) : state.remainingAutoPasses,
    };
}
function deriveAutonomyStatusView(state) {
    const countingActive = isPassCountingActive(state);
    const total = state.totalAuthorizedPasses;
    const summary = countingActive
        ? `Mode: ${state.mode} · Passes: ${state.completedAutoPasses}/${total ?? state.completedAutoPasses + state.remainingAutoPasses} · Remaining: ${state.remainingAutoPasses}`
        : `Mode: ${state.mode}`;
    return {
        mode: state.mode,
        countingActive,
        completed: state.completedAutoPasses,
        remaining: state.remainingAutoPasses,
        totalAuthorized: total,
        timeBudgetTotalMs: state.timeBudgetTotalMs,
        timeBudgetStartedAtEpochMs: state.timeBudgetStartedAtEpochMs,
        summary,
    };
}
exports.MODE_PROFILES = Object.freeze({
    cautious: Object.freeze({ mode: 'cautious', defaultPassBudget: 3, defaultTimeBudgetMs: 2 * 60 * 1000 }),
    conscientious: Object.freeze({ mode: 'conscientious', defaultPassBudget: 8, defaultTimeBudgetMs: 5 * 60 * 1000 }),
    eager: Object.freeze({ mode: 'eager', defaultPassBudget: 20, defaultTimeBudgetMs: 10 * 60 * 1000 }),
    autonomous: Object.freeze({ mode: 'autonomous', defaultPassBudget: 50, defaultTimeBudgetMs: 30 * 60 * 1000 }),
});
function getModeProfile(mode) {
    return exports.MODE_PROFILES[mode];
}
/**
 * Build a fresh `AutonomyState` from a mode's profile (pass budget + time
 * budget started now). Used when the user explicitly switches mode via the
 * header dropdown — explicit selection means "start a new session under this
 * mode's policy".
 */
function applyModeProfileToState(mode, nowEpochMs = Date.now()) {
    const profile = getModeProfile(mode);
    return createAutonomyState(mode, profile.defaultPassBudget, profile.defaultTimeBudgetMs, nowEpochMs);
}
function rankRecommendedActions(actions) {
    const eligible = actions.filter((action) => action.eligible && action.withinScope);
    const sorted = [...eligible].sort((a, b) => a.priority - b.priority || a.label.localeCompare(b.label));
    return {
        actions: sorted,
        doAllEligible: computeDoAllEligibility(sorted),
        topActionId: sorted[0]?.id,
    };
}
function computeDoAllEligibility(actions) {
    if (actions.length < 2)
        return false;
    for (const action of actions) {
        if (!action.eligible || !action.withinScope)
            return false;
        const mutex = new Set(action.mutuallyExclusiveWith ?? []);
        for (const other of actions) {
            if (other.id === action.id)
                continue;
            if (mutex.has(other.id))
                return false;
        }
    }
    return true;
}
function chooseActionForMode(mode, actionSet, signal) {
    if (!actionSet.topActionId)
        return undefined;
    if (mode === 'cautious')
        return signal.nextStepIsNearTrivial ? actionSet.topActionId : undefined;
    if (mode === 'conscientious')
        return signal.uncertainty === 'low' ? actionSet.topActionId : undefined;
    if (mode === 'eager')
        return signal.uncertainty === 'high' ? undefined : actionSet.topActionId;
    return signal.uncertainty === 'high' ? undefined : actionSet.topActionId;
}
function shouldContinueAfterPass(state, signal, actionSet) {
    if (signal.goalSufficientlyReached) {
        return { shouldContinue: false, reason: 'Stopped: original goal sufficiently reached.', selectionMode: 'none' };
    }
    if (signal.progressStatus === 'stalled') {
        return { shouldContinue: false, reason: 'Stopped: progress has stalled.', selectionMode: 'none' };
    }
    if (signal.hasBlockingFailure) {
        return { shouldContinue: false, reason: 'Stopped: blocking failure encountered.', selectionMode: 'none' };
    }
    // Counter-spam guard: two passes in a row that produced no tool calls,
    // no file edits, and no real report — force user confirmation rather
    // than burning more pass budget on a model that is silently failing.
    if ((state.consecutiveEmptyPasses ?? 0) >= 2) {
        return { shouldContinue: false, reason: 'Paused: two empty passes in a row — select an action or type "resume" to continue.', selectionMode: 'user' };
    }
    if (!signal.hasClearNextStep) {
        // Pause for user selection rather than hard-stopping. The webview will show
        // any action chips that were broadcast; the user can select one or type "resume".
        return { shouldContinue: false, reason: 'Paused: no clear next step identified — select an action or type "resume" to continue.', selectionMode: 'user' };
    }
    if (!signal.nextStepWithinScope) {
        return { shouldContinue: false, reason: 'Stopped: next step is outside current scope.', selectionMode: 'none' };
    }
    if (state.totalAuthorizedPasses && state.remainingAutoPasses <= 0) {
        return { shouldContinue: false, reason: 'Stopped: pass budget exhausted.', selectionMode: 'none' };
    }
    if (signal.uncertainty === 'high') {
        return { shouldContinue: false, reason: 'Stopped: uncertainty too high for safe continuation.', selectionMode: 'none' };
    }
    if (state.mode === 'cautious') {
        if (signal.uncertainty !== 'low' || !signal.nextStepIsNearTrivial) {
            return { shouldContinue: false, reason: 'Paused: cautious mode prefers user confirmation.', selectionMode: 'user' };
        }
        return { shouldContinue: true, reason: 'Continuing automatically: near-trivial next step with low uncertainty.', selectionMode: 'self' };
    }
    if (state.mode === 'conscientious') {
        if (signal.uncertainty === 'low') {
            const selected = chooseActionForMode(state.mode, actionSet ?? { actions: [], doAllEligible: false }, signal);
            return { shouldContinue: true, reason: 'Continuing automatically: clear bounded next step.', selectionMode: selected ? 'self' : 'user' };
        }
        return { shouldContinue: false, reason: 'Paused: conscientious mode requires clearer bounds.', selectionMode: 'user' };
    }
    if (state.mode === 'eager') {
        if (signal.uncertainty === 'medium' && !signal.nextStepIsDefining) {
            return { shouldContinue: false, reason: 'Paused: eager mode needs a defining or lower-risk next step.', selectionMode: 'user' };
        }
        return { shouldContinue: true, reason: 'Continuing automatically: strong aligned next step available.', selectionMode: 'self' };
    }
    return { shouldContinue: true, reason: 'Continuing automatically: autonomous mode with bounded in-scope next step.', selectionMode: 'self' };
}
function getAutonomyInstructionBlock(state) {
    if (!state?.enabled)
        return '';
    const status = deriveAutonomyStatusView(state);
    return [
        '## Autonomy Contract',
        `- **Autonomy mode:** ${state.mode}`,
        status.countingActive ? `- **Pass counters:** completed ${status.completed}, remaining ${status.remaining}, total authorized ${status.totalAuthorized ?? status.completed + status.remaining}` : '- **Pass counters:** inactive',
        '- In all modes, DreamGraph must output into chat after each pass.',
        '- Continue automatically only when host policy allows and the next step is clear, in scope, and safe for the current mode.',
        '- Stop when the original goal has sufficiently been reached.',
        '- Stop when progress has stalled.',
        '- When pass counting is active, counters must remain visible.',
        '- Emit recommended next steps in a structured/selectable form when available.',
        '- In higher-autonomy modes, self-select the strongest eligible next action when policy allows; otherwise pause for user selection.',
    ].join('\n');
}
//# sourceMappingURL=autonomy.js.map