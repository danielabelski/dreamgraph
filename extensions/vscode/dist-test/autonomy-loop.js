"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inferPassOutcomeSignal = inferPassOutcomeSignal;
exports.buildContinuationPrompt = buildContinuationPrompt;
exports.analyzePass = analyzePass;
exports.advanceAutonomyStateIfContinued = advanceAutonomyStateIfContinued;
const autonomy_js_1 = require("./autonomy.js");
function inferPassOutcomeSignal(content) {
    // Continuation passes can legitimately contain no assistant text (the model
    // emitted only tool calls, or the response was cancelled). Treat that as a
    // neutral signal rather than crashing on `undefined.toLowerCase()`.
    const lower = (content ?? '').toLowerCase();
    const goalSufficientlyReached = /ready for commit|done and verified|goal sufficiently reached|completed successfully/.test(lower);
    // Intentionally narrow — broad terms like "error:" and standalone "failed" fire
    // on too much normal prose ("error: none", "what failed was"). Only trigger on
    // phrases that unambiguously indicate an unrecoverable stop condition.
    const hasBlockingFailure = /blocking failure|build failed|unrecoverable error|fatal error/.test(lower)
        || (/\bfailed\b/.test(lower) && /cannot proceed|cannot continue|still failing|remains broken/.test(lower));
    const stalled = /stalled progress|no further progress|cannot proceed|stuck/.test(lower);
    const uncertainty = /uncertain|not sure|insufficient data|confidence: low/.test(lower) ? 'high'
        : /partial|likely|appears|confidence: medium/.test(lower) ? 'medium'
            : 'low';
    const hasClearNextStep = /recommended next step|next step|i can continue|continue into the next slice|proceed next/.test(lower) || goalSufficientlyReached;
    const nextStepWithinScope = !/outside current scope|out of scope/.test(lower);
    const nextStepIsNearTrivial = /minor follow-up|small cleanup|trivial next step|quick verification/.test(lower);
    const nextStepIsDefining = /defining next step|significant|structural next slice|host-controlled continuation loop|clickable recommended/.test(lower);
    const progressStatus = stalled ? 'stalled' : /partial progress|slowing|some progress/.test(lower) ? 'slowing' : 'advancing';
    return {
        hasClearNextStep,
        uncertainty,
        hasBlockingFailure,
        nextStepWithinScope,
        goalSufficientlyReached,
        progressStatus,
        nextStepIsNearTrivial,
        nextStepIsDefining,
    };
}
function buildContinuationPrompt(selectedAction) {
    // Patch #1 (renderer invariant — continuation half): the next tool MUST be
    // declared specifically, not implied. The model must either invoke the
    // named tool with bound arguments OR emit a structured envelope explaining
    // why it cannot. No ambiguous prose continuations.
    if (!selectedAction) {
        return [
            'Continue with your strongest in-scope recommended next step.',
            '',
            'Continuation contract:',
            '- If a single tool can advance the goal, invoke it directly this turn.',
            '- Then emit one structured json envelope. Each `recommended_next_steps[*]`',
            '  that maps to a single tool call MUST set both `tool` (exact snake_case',
            '  name) and `tool_args` (object). Do not propose a step without a tool',
            '  binding when one is available.',
            '- Stop only if the original goal is sufficiently reached or progress stalls.',
        ].join('\n');
    }
    const toolName = selectedAction.tool;
    const argsJson = selectedAction.toolArgs
        ? JSON.stringify(selectedAction.toolArgs)
        : null;
    const lines = [
        `Continue with the recommended next step: ${selectedAction.label}.`,
        '',
        'Continuation contract:',
    ];
    if (toolName) {
        lines.push(`- Invoke the tool \`${toolName}\` directly this turn.`);
        if (argsJson) {
            lines.push(`- Pre-bound arguments: \`${argsJson}\`. Adjust only if clearly wrong.`);
        }
    }
    else {
        lines.push('- Identify the single tool that advances this step and invoke it directly this turn.');
    }
    lines.push('- Then emit one structured json envelope. Every recommended_next_steps[*]', '  that maps to a single tool call MUST set `tool` (exact snake_case name)', '  and `tool_args` (object). Do not propose a step without a tool binding', '  when one is available.', '- Stop only if the original goal is sufficiently reached or progress stalls.');
    return lines.join('\n');
}
function analyzePass(state, input) {
    const proseSignal = inferPassOutcomeSignal(input.content);
    const hasActions = (input.actions?.length ?? 0) > 0;
    const env = input.envelope;
    const toolCalls = input.toolCallCount ?? 0;
    const fileEdits = input.fileEditCount ?? 0;
    const summaryHasContent = !!env?.summary && env.summary.trim().length > 0;
    // "Empty pass": no real work and no real report. Pure counter-spam.
    const isEmptyPass = toolCalls === 0 && fileEdits === 0 && !hasActions && !summaryHasContent
        && (input.content?.trim().length ?? 0) < 200;
    // Structured envelope fields are authoritative over prose-regex equivalents.
    // Prose is the fallback when no structured block was emitted.
    const signal = {
        ...proseSignal,
        // Action presence is definitive evidence of a clear next step.
        hasClearNextStep: hasActions || proseSignal.hasClearNextStep,
        // Structured overrides when present.
        goalSufficientlyReached: (env?.goalStatus === 'complete') || proseSignal.goalSufficientlyReached,
        progressStatus: env?.progressStatus ?? proseSignal.progressStatus,
        uncertainty: env?.uncertainty ?? proseSignal.uncertainty,
        // "blocked" from a structured envelope is a turn-local signal, not a
        // terminal one — only treat it as a hard stop when progress is also
        // stalled. Otherwise the loop dies the first time the model self-reports
        // a transient block while still advancing toward the goal.
        hasBlockingFailure: env
            ? (env.goalStatus === 'blocked' && env.progressStatus === 'stalled')
            : proseSignal.hasBlockingFailure,
        isEmptyPass,
    };
    // Track consecutive empty passes on a copy of the state so the caller
    // can persist it. shouldContinueAfterPass uses this to short-circuit.
    const nextEmptyCount = isEmptyPass ? (state.consecutiveEmptyPasses ?? 0) + 1 : 0;
    const stateForDecision = { ...state, consecutiveEmptyPasses: nextEmptyCount };
    const actionSet = (0, autonomy_js_1.rankRecommendedActions)(input.actions ?? []);
    const decision = (0, autonomy_js_1.shouldContinueAfterPass)(stateForDecision, signal, actionSet);
    const selectedActionId = decision.selectionMode === 'self' ? actionSet.topActionId : undefined;
    const selectedAction = actionSet.actions.find((a) => a.id === selectedActionId);
    return {
        signal,
        actionSet,
        selectedActionId,
        decision,
        nextPrompt: decision.shouldContinue ? buildContinuationPrompt(selectedAction) : undefined,
    };
}
function advanceAutonomyStateIfContinued(state, decision, signal) {
    const next = decision.shouldContinue ? (0, autonomy_js_1.decrementPassBudget)(state) : state;
    if (signal) {
        return {
            ...next,
            consecutiveEmptyPasses: signal.isEmptyPass ? (state.consecutiveEmptyPasses ?? 0) + 1 : 0,
        };
    }
    return next;
}
//# sourceMappingURL=autonomy-loop.js.map