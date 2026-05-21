"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isReadOnlyTool = isReadOnlyTool;
exports.extractProseAnchorPaths = extractProseAnchorPaths;
exports.setEqualsPaths = setEqualsPaths;
exports.inferPassOutcomeSignal = inferPassOutcomeSignal;
exports.buildContinuationPrompt = buildContinuationPrompt;
exports.analyzePass = analyzePass;
exports.advanceAutonomyStateIfContinued = advanceAutonomyStateIfContinued;
const autonomy_js_1 = require("./autonomy.js");
const tool_classification_js_1 = require("./tool-classification.js");
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
// Verbs that, when found in the same line as a concrete file path, indicate
// the architect has named a patch site even without binding a write tool to a
// recommended_next_step. This is the prose-anchor signal that complements the
// write-tool / file-edit / next-step-write anchor sources.
const EDIT_VERB_RE = /\b(patch|patche[ds]|replace[ds]?|insert[ed]?|append[ed]?|delete[ds]?|edit[ed]?|writ(?:e|es|ten)|add[s]?|chang(?:e|ed|es)|modif(?:y|ies|ied)|fix(?:es|ed)?|update[ds]?|apply|implement(?:s|ed|ing)?)\b/i;
// Concrete file path heuristic. Requires a slash or backslash and a 1–6 char
// extension to avoid catching prose words like "config.something" that aren't
// real paths. Keeps a list of common code/text/config extensions.
const FILE_PATH_RE = /(?<![\w./\\-])((?:[\w.-]+[\\/])+[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|html|py|java|cs|rs|go|rb|sh|ps1|yaml|yml|toml|sql|test\.ts))(?![\w./\\-])/gi;
// Inline-quoted file path heuristic. Catches `chat-panel.ts` / "autonomy.ts" /
// 'something.json' even without a directory prefix. The architect commonly
// reports anchors as bare filenames in backticks, e.g. "Patch `chat-panel.ts`
// at line 2944." A directory prefix is not required because the model is
// already constraining via the verb on the same line.
const QUOTED_FILE_PATH_RE = /[`'"]([\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|html|py|java|cs|rs|go|rb|sh|ps1|yaml|yml|toml|sql))[`'"]/gi;
/**
 * Extract concrete file paths the architect named on the same line as an
 * edit verb. Empty array means no prose anchor was detected. The result is
 * deduplicated, lower-cased only for paths that look case-insensitive (we
 * preserve original casing in the returned set so equality comparison across
 * passes is exact). Order is the order of first occurrence.
 */
function extractProseAnchorPaths(content) {
    if (!content)
        return [];
    const seen = new Set();
    const out = [];
    for (const rawLine of content.split(/\r?\n/)) {
        if (!EDIT_VERB_RE.test(rawLine))
            continue;
        // Sentence-level scope inside the line: prefer same-sentence co-occurrence
        // by splitting on `.`, `!`, `?`, `;` (keeping the verb test per-fragment).
        const fragments = rawLine.split(/(?<=[.!?;])\s+/);
        for (const fragment of fragments) {
            if (!EDIT_VERB_RE.test(fragment))
                continue;
            const matchers = [
                new RegExp(FILE_PATH_RE.source, FILE_PATH_RE.flags),
                new RegExp(QUOTED_FILE_PATH_RE.source, QUOTED_FILE_PATH_RE.flags),
            ];
            for (const re of matchers) {
                let m;
                while ((m = re.exec(fragment)) !== null) {
                    const path = m[1];
                    if (!path)
                        continue;
                    if (seen.has(path))
                        continue;
                    seen.add(path);
                    out.push(path);
                }
            }
        }
    }
    return out;
}
function setEqualsPaths(a, b) {
    // Reserved for prose-anchor comparison helpers in this module. Used by
    // tests and by future call sites that want to do the same set-equality
    // check without depending on autonomy.ts internals.
    const aa = a ?? [];
    const bb = b ?? [];
    if (aa.length !== bb.length)
        return false;
    if (aa.length === 0)
        return true;
    const sa = new Set(aa);
    for (const x of bb) {
        if (!sa.has(x))
            return false;
    }
    return true;
}
function inferPassOutcomeSignal(content) {
    // Continuation passes can legitimately contain no assistant text (the model
    // emitted only tool calls, or the response was cancelled). Treat that as a
    // neutral signal rather than crashing on `undefined.toLowerCase()`.
    const raw = content ?? '';
    const lower = raw.toLowerCase();
    const goalSufficientlyReached = /ready for commit|done and verified|goal sufficiently reached|completed successfully/.test(lower);
    // Awaiting-user detection. Catches the most common "the assistant
    // handed control back to the user" patterns: explicit confirmation
    // requests, choice prompts, "let me know" / "should I" sign-offs,
    // and trailing question marks near the end of the message. We
    // intentionally only check the tail of the message — phrases like
    // "should I" can appear mid-explanation; only the closing prose
    // is the actual hand-off to the user.
    const tail = raw.slice(Math.max(0, raw.length - 600)).toLowerCase().trim();
    const awaitingUserInput = /\blet me know\b|\bplease confirm\b|\bawaiting your\b|\bawait(?:ing)? confirmation\b|\bdo you want me\b|\bwould you like me\b|\bshall i\b|\bshould i (?:proceed|continue|go ahead|apply|run|commit|implement|fix|patch|delete|remove|create)\b|\bcan i (?:proceed|continue|go ahead)\b|\bwhich (?:option|approach|path) (?:do|would) you\b|\bplease (?:choose|select|pick|decide)\b/.test(tail)
        // Question-mark handoff: the message ends with a question (allowing
        // for trailing whitespace / closing markdown). Pure rhetorical
        // questions inside long explanations are not matched because we
        // anchor on the message tail.
        || /\?\s*[)*_`'"\]]*\s*$/.test(tail);
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
        awaitingUserInput,
    };
}
function buildContinuationPrompt(selectedAction, options = {}) {
    // A pass is a logical step, not a single tool call. The model is expected to
    // batch every tool call the step requires (parallel reads, sequential edits,
    // then a verification call) into the same turn. Pre-bound arguments are a
    // suggestion, not a prescription — the model may add, reorder, or replace
    // calls as long as the step is genuinely advanced.
    const anchorPreamble = options.patchAnchorEstablished
        ? [
            'The patch site is already known from the previous pass. Do NOT re-locate it.',
            'This pass MUST either issue the edit tool calls (e.g. `replace_string_in_file`,',
            '`multi_replace_string_in_file`, `create_file`, `patch_file`, `edit_file`,',
            '`edit_entity`) or set `goal_status` to `blocked` with the concrete missing',
            'prerequisite. Re-reading already-located files counts as no progress and will',
            'end the autonomy loop on token-economy grounds.',
            '',
        ]
        : [];
    if (!selectedAction) {
        return [
            ...anchorPreamble,
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
    // When the bound next-step tool is a write tool, OR a write tool is bound
    // and the anchor is already sticky from a prior pass, the model should
    // apply the change in this single pass — not re-discover the patch site
    // or split the write across turns. This is the "manual workaround"
    // ("and apply the patch in 1 step") promoted into the prompt itself so
    // the autonomy loop reliably binds and executes the write.
    const boundToolIsWrite = !!toolName && (0, tool_classification_js_1.isWriteToolName)(toolName);
    const writePush = boundToolIsWrite || options.patchAnchorEstablished === true;
    const lines = [
        ...anchorPreamble,
        `Continue with the recommended next step: ${selectedAction.label}${writePush ? ' — apply the patch in 1 step' : ''}.`,
        '',
        'Continuation contract:',
        '- Complete the entire step this turn. Batch every tool call it requires',
        '  (parallel reads, sequential edits, then a verification call). Do not',
        '  split a single logical step across multiple passes.',
        '- Do not re-read files/entities already inspected earlier in this',
        '  conversation. Re-read only after a write, and prefer wide ranges.',
    ];
    if (toolName) {
        if (boundToolIsWrite) {
            lines.push(`- The next step is a WRITE bound to \`${toolName}\`. Issue the write tool call(s) in THIS pass.`, '  Do not re-locate, re-read, or re-confirm anchors first. If the exact', '  anchor text drifted, do one wide re-read THEN the write in the same pass.');
            if (argsJson) {
                lines.push(`- Suggested args for the write tool: \`${argsJson}\`. Adjust as needed, but do not skip the write.`);
            }
        }
        else {
            lines.push(`- Suggested entry tool: \`${toolName}\`. Use additional tools in the same turn as needed to finish the step.`);
            if (argsJson) {
                lines.push(`- Suggested args for the entry tool: \`${argsJson}\`. Adjust freely; they are a hint, not a contract.`);
            }
        }
    }
    else if (writePush) {
        lines.push('- A patch anchor is already known. Issue the edit tool call(s) in THIS pass', '  (e.g. `replace_string_in_file`, `multi_replace_string_in_file`,', '  `create_file`, `patch_file`, `edit_file`, `edit_entity`). Do not split', '  the write across passes.');
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
    //    (i.e. it knows exactly what to change next), OR
    //  - the assistant prose names a concrete file path on the same line
    //    as an edit verb (prose anchor — DreamGraph's natural reporting
    //    style, e.g. "Patch `chat-panel.ts` to add the optimistic state").
    const nextStepIsWrite = (input.actions ?? []).some((a) => typeof a.tool === 'string' && a.tool.length > 0 && !isReadOnlyTool(a.tool));
    const proseAnchorPaths = extractProseAnchorPaths(input.content);
    const hasProseAnchor = proseAnchorPaths.length > 0;
    const patchAnchorEstablished = !!state.patchAnchorEstablished
        || writeToolCalls > 0
        || fileEdits > 0
        || nextStepIsWrite
        || hasProseAnchor;
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
    const isLocateOnlyThisPass = readOnlyPass; // tool calls > 0, all reads, no edits.
    const decision = (0, autonomy_js_1.shouldContinueAfterPass)(stateForDecision, signal, actionSet);
    const selectedActionId = decision.selectionMode === 'self' ? actionSet.topActionId : undefined;
    const selectedAction = actionSet.actions.find((a) => a.id === selectedActionId);
    return {
        signal,
        actionSet,
        selectedActionId,
        decision,
        nextPrompt: decision.shouldContinue
            ? buildContinuationPrompt(selectedAction, { patchAnchorEstablished })
            : undefined,
        patchAnchorEstablished,
        anchorPaths: proseAnchorPaths,
        isLocateOnlyThisPass,
    };
}
function advanceAutonomyStateIfContinued(state, decision, signal, patchAnchorEstablished, anchorPaths, isLocateOnlyThisPass) {
    const next = decision.shouldContinue ? (0, autonomy_js_1.decrementPassBudget)(state) : state;
    const anchor = patchAnchorEstablished ?? state.patchAnchorEstablished;
    // Carry forward the anchor-path set only when the current pass actually
    // produced one. An empty array on the current pass MUST NOT erase a
    // sticky prior anchor — the sticky anchor is what makes the two-strike
    // rule work across a follow-up locate-only pass that produced no new
    // prose anchor of its own.
    const carriedAnchorPaths = (anchorPaths && anchorPaths.length > 0)
        ? anchorPaths
        : state.lastAnchorPaths;
    // lastPassWasLocateOnly is per-pass and must reflect the just-completed
    // pass exactly. Default to existing state when not supplied.
    const carriedLocateOnly = typeof isLocateOnlyThisPass === 'boolean'
        ? isLocateOnlyThisPass
        : state.lastPassWasLocateOnly;
    if (signal) {
        return {
            ...next,
            consecutiveEmptyPasses: signal.isEmptyPass ? (state.consecutiveEmptyPasses ?? 0) + 1 : 0,
            // patchAnchorEstablished is sticky for the rest of the run — once the
            // architect knows what to change, that knowledge does not expire just
            // because a later pass happened to be read-only.
            patchAnchorEstablished: anchor,
            lastAnchorPaths: carriedAnchorPaths,
            lastPassWasLocateOnly: carriedLocateOnly,
        };
    }
    return {
        ...next,
        patchAnchorEstablished: anchor,
        lastAnchorPaths: carriedAnchorPaths,
        lastPassWasLocateOnly: carriedLocateOnly,
    };
}
//# sourceMappingURL=autonomy-loop.js.map