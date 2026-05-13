"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isReadOnlyTool = isReadOnlyTool;
exports.inferPassOutcomeSignal = inferPassOutcomeSignal;
exports.buildContinuationPrompt = buildContinuationPrompt;
exports.analyzePass = analyzePass;
exports.advanceAutonomyStateIfContinued = advanceAutonomyStateIfContinued;
const autonomy_js_1 = require("./autonomy.js");
// Tools that read state without changing it. Anything not in this set is
// treated as a potential write — conservative classification keeps the
// read-only detector from accidentally treating a mutation as a no-op.
const READ_TOOL_PREFIXES = [
    'read_', 'search_', 'query_', 'list_', 'get_', 'view_', 'find_', 'fetch_',
    'inspect_', 'graph_rag_', 'shortest_path', 'extract_api_', 'cognitive_status',
    'git_log', 'git_blame', 'terminal_', 'screenshot_', 'hover_', 'evaluate_debug_',
    'get_debug_', 'get_changed_', 'get_python_', 'get_vscode_', 'resolve_memory_',
    'tool_search', 'semantic_search', 'file_search', 'grep_search', 'list_dir',
    'read_local_file', 'read_source_code', 'read_markdown_', 'list_markdown_',
    'list_directory', 'list_schedules', 'get_schedule_', 'get_workflow',
    'get_dream_', 'get_temporal_', 'get_causal_', 'get_remediation_',
    'get_system_', 'get_cognitive_', 'webhook_list', 'webhook_dead_',
];
function isReadOnlyTool(toolName) {
    if (!toolName)
        return false;
    const lower = toolName.toLowerCase();
    return READ_TOOL_PREFIXES.some((p) => lower.startsWith(p));
}
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
    // A pass is a logical step, not a single tool call. The model is expected to
    // batch every tool call the step requires (parallel reads, sequential edits,
    // then a verification call) into the same turn. Pre-bound arguments are a
    // suggestion, not a prescription — the model may add, reorder, or replace
    // calls as long as the step is genuinely advanced.
    if (!selectedAction) {
        return [
            'Continue with your strongest in-scope recommended next step.',
            '',
            'Continuation contract:',
            '- Complete the entire next step this turn. Issue ALL tool calls it needs',
            '  in the same pass: parallel reads, sequential edits, then a verification',
            '  call (build/test/read-back). Do not split one logical step across passes.',
            '- Before reading, check whether the file/entity was already read earlier in',
            '  this conversation. Do not re-read it. If you need more of the same file,',
            '  fetch a wider range in one call instead of many narrow probes.',
            '- Then emit one structured json envelope. Each `recommended_next_steps[*]`',
            '  that maps to tool calls MUST set both `tool` (exact snake_case name) and',
            '  `tool_args` (object). Do not propose a step without a tool binding when',
            '  one is available.',
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
        '- Complete the entire step this turn. Batch every tool call it requires',
        '  (parallel reads, sequential edits, then a verification call). Do not',
        '  split a single logical step across multiple passes.',
        '- Do not re-read files/entities already inspected earlier in this',
        '  conversation. Re-read only after a write, and prefer wide ranges.',
    ];
    if (toolName) {
        lines.push(`- Suggested entry tool: \`${toolName}\`. Use additional tools in the same turn as needed to finish the step.`);
        if (argsJson) {
            lines.push(`- Suggested args for the entry tool: \`${argsJson}\`. Adjust freely; they are a hint, not a contract.`);
        }
    }
    else {
        lines.push('- Choose whichever tools advance the step and invoke them in this turn.');
    }
    lines.push('- Then emit one structured json envelope. Every recommended_next_steps[*]', '  that maps to tool calls MUST set `tool` (exact snake_case name) and', '  `tool_args` (object). Do not propose a step without a tool binding when', '  one is available.', '- Stop only if the original goal is sufficiently reached or progress stalls.');
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
    const baseEmptyPass = toolCalls === 0 && fileEdits === 0 && !hasActions && !summaryHasContent
        && (input.content?.trim().length ?? 0) < 200;
    // Read/write classification for this pass.
    const toolNames = input.toolNames ?? [];
    const writeToolCalls = toolNames.filter((n) => !isReadOnlyTool(n)).length;
    const readOnlyPass = toolCalls > 0 && writeToolCalls === 0 && fileEdits === 0;
    // A patch anchor counts as established when:
    //  - a previous pass already established it (sticky), OR
    //  - this pass actually wrote something, OR
    //  - the model produced a recommended next step bound to a write tool
    //    (i.e. it knows exactly what to change next).
    const nextStepIsWrite = (input.actions ?? []).some((a) => typeof a.tool === 'string' && a.tool.length > 0 && !isReadOnlyTool(a.tool));
    const patchAnchorEstablished = !!state.patchAnchorEstablished || writeToolCalls > 0 || fileEdits > 0 || nextStepIsWrite;
    // Once the anchor is known, additional pure-read passes are non-progress.
    // They are the read-loop pattern that burns pass budget without advancing
    // (re-confirming facts already known, fetching one narrow range at a time,
    // "verifying anchors" instead of editing). Treat them as empty so the
    // existing 2-empty-pass guard in shouldContinueAfterPass kicks in.
    const isReadOnlyAfterAnchor = patchAnchorEstablished && readOnlyPass;
    const isEmptyPass = baseEmptyPass || isReadOnlyAfterAnchor;
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
    const stateForDecision = {
        ...state,
        consecutiveEmptyPasses: nextEmptyCount,
        patchAnchorEstablished,
    };
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
        patchAnchorEstablished,
    };
}
function advanceAutonomyStateIfContinued(state, decision, signal, patchAnchorEstablished) {
    const next = decision.shouldContinue ? (0, autonomy_js_1.decrementPassBudget)(state) : state;
    const anchor = patchAnchorEstablished ?? state.patchAnchorEstablished;
    if (signal) {
        return {
            ...next,
            consecutiveEmptyPasses: signal.isEmptyPass ? (state.consecutiveEmptyPasses ?? 0) + 1 : 0,
            // patchAnchorEstablished is sticky for the rest of the run — once the
            // architect knows what to change, that knowledge does not expire just
            // because a later pass happened to be read-only.
            patchAnchorEstablished: anchor,
        };
    }
    return { ...next, patchAnchorEstablished: anchor };
}
//# sourceMappingURL=autonomy-loop.js.map