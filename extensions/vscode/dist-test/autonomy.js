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
exports.isRecommendedActionRunnable = isRecommendedActionRunnable;
exports.applyRecommendedActionCapabilityGuards = applyRecommendedActionCapabilityGuards;
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
    const eligible = actions.filter((action) => isRecommendedActionRunnable(action));
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
        if (!isRecommendedActionRunnable(action))
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
function isRecommendedActionRunnable(action) {
    return action.eligible && action.withinScope && (action.blockers?.length ?? 0) === 0;
}
function applyRecommendedActionCapabilityGuards(actions, context = {}) {
    const availableTools = new Set((context.availableToolNames ?? []).map((name) => name.toLowerCase()));
    const hasTool = (name) => availableTools.has(name.toLowerCase()) || availableTools.has(`dreamgraph:${name}`.toLowerCase());
    const hasSecret = (name) => {
        const value = context.env?.[name];
        return typeof value === 'string' && value.trim().length > 0;
    };
    return actions.map((action) => {
        const label = action.label.trim();
        const blockers = [...(action.blockers ?? [])];
        const requiresTools = new Set(action.requiresTools ?? []);
        const requiresSecrets = new Set(action.requiresSecrets ?? []);
        if (requiresGraphReleaseWrite(label, action)) {
            requiresTools.add('enrich_seed_data');
        }
        if (requiresMarketplacePublishSecret(label)) {
            requiresSecrets.add('VSCE_PAT');
        }
        if (looksLikeExternalCredentialSetup(label)) {
            blockers.push({
                id: 'external_secret_setup',
                kind: 'external',
                label: 'Requires user-side credential setup outside this chat surface.',
            });
        }
        for (const toolName of requiresTools) {
            if (!hasTool(toolName)) {
                blockers.push({
                    id: `missing_tool:${toolName}`,
                    kind: 'missing_tool',
                    label: `Requires MCP tool ${toolName}; the current tool surface cannot perform this action.`,
                });
            }
        }
        const marketplaceSecretSatisfied = hasSecret('VSCE_PAT') || hasSecret('AZURE_DEVOPS_EXT_PAT');
        for (const secretName of requiresSecrets) {
            if (secretName === 'VSCE_PAT' && marketplaceSecretSatisfied)
                continue;
            if (!hasSecret(secretName)) {
                blockers.push({
                    id: `missing_secret:${secretName}`,
                    kind: 'missing_secret',
                    label: `Requires ${secretName} in the host environment before this action can run.`,
                });
            }
        }
        const uniqueBlockers = dedupeBlockers(blockers);
        return {
            ...action,
            requiresTools: requiresTools.size > 0 ? [...requiresTools] : action.requiresTools,
            requiresSecrets: requiresSecrets.size > 0 ? [...requiresSecrets] : action.requiresSecrets,
            blockers: uniqueBlockers.length > 0 ? uniqueBlockers : undefined,
            eligible: uniqueBlockers.length > 0 ? false : action.eligible,
        };
    });
}
function dedupeBlockers(blockers) {
    const seen = new Set();
    const out = [];
    for (const blocker of blockers) {
        const key = blocker.id || `${blocker.kind}:${blocker.label}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(blocker);
    }
    return out;
}
function requiresGraphReleaseWrite(label, action) {
    const text = `${label} ${action.rationale ?? ''}`.toLowerCase();
    if (text.includes('enrich_seed_data'))
        return true;
    const mentionsRelease = /\brelease\b|\bvsix\b|\bv\d+\.\d+\.\d+\b/.test(text);
    const mentionsGraph = /\bknowledge graph\b|\bdreamgraph graph\b|\bgraph\b/.test(text);
    const writeIntent = /\brecord\b|\bwrite\b|\badd\b|\bpatch\b|\bcurate\b|\benrich\b|\binvoke\b/.test(text);
    return mentionsRelease && mentionsGraph && writeIntent;
}
function requiresMarketplacePublishSecret(label) {
    const text = label.toLowerCase();
    return /\bpublish\b/.test(text)
        && (/\bvsix\b/.test(text) || /\bmarketplace\b/.test(text) || /\bvs code marketplace\b/.test(text));
}
function looksLikeExternalCredentialSetup(label) {
    const text = label.toLowerCase();
    return /\b(configure|generate|create|set)\b/.test(text)
        && (/\bvsce_pat\b/.test(text) || /\bpersonal access token\b/.test(text) || /\bpat\b/.test(text))
        && !/\bretry\b|\brun\b|\bpublish\b/.test(text);
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
    if (signal.awaitingUserInput) {
        // The assistant explicitly handed control back to the user (asked
        // a confirmation question, presented a final report and offered
        // follow-up options, etc.). Auto-continuation here would talk
        // over the user and run another full pass while they are still
        // composing a reply. Surface action chips if any were broadcast,
        // but do NOT spawn the next pass.
        return { shouldContinue: false, reason: 'Paused: assistant is awaiting user input.', selectionMode: 'user' };
    }
    if (signal.progressStatus === 'stalled') {
        return { shouldContinue: false, reason: 'Stopped: progress has stalled.', selectionMode: 'none' };
    }
    if (signal.hasBlockingFailure) {
        return { shouldContinue: false, reason: 'Stopped: blocking failure encountered.', selectionMode: 'none' };
    }
    // NOTE: post-anchor re-reading is NOT a stop condition. The token-economy
    // remedy at task level is structural pressure (write-reservation prompt in
    // the inner agentic loop, anchor-aware continuation prompt, write-tool
    // binding on apply/patch actions, and tool-catalog narrowing toward
    // write+verify on the second sticky-anchor locate-only pass) — not a hard
    // halt. The architect's design is "no failure: keep going until done";
    // stopping the loop just because the model has not yet selected a write
    // tool would punish the model instead of giving it what it needs to
    // succeed. See chat-panel.ts (Phase A write reservation, Lever 1 narrowing,
    // Lever 2 action binding) and autonomy-loop.ts (anchor-aware prompt).
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