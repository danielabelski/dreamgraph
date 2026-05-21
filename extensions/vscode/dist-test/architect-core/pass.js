"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// architect-core/pass.ts — Phase 2 driver (ADR-089).
//
// `runPass()` is the seam's pure driver. It contains zero I/O — every
// effect is delegated to a port from `ArchitectCorePorts`.
//
// Scope of one pass:
//
//   A pass is **one coherent unit of progress toward the task goal.**
//   Each pass:
//     - has a focused sub-goal (the PassGoal),
//     - maintains cognitive continuity across its inner tool calls,
//     - allows many tool calls internally (tens, when they all serve
//       the sub-goal),
//     - and ends with a meaningful state transition that the verdict
//       layer can assess and the graph layer can record.
//
//   The driver owns the inner agentic loop:
//
//     provider call → tool batch → provider call → tool batch → …
//
//   terminating when the provider emits no more tool calls (the
//   natural stop — the model has reached the meaningful state
//   transition and is done with this pass), the inner-iteration cap is
//   hit, or an abort/error escapes. This mirrors v1 chat-panel's
//   `while (pass < maxPasses)` loop verbatim, just lifted behind the
//   seam. The same composed prompt is reused across iterations so
//   cognitive continuity is preserved — the model sees the running
//   tool dialogue via `iterationHistory` and stays inside the
//   sub-goal.
//
//   A task is the sum of many passes. Each pass advances the task by
//   one assessed, graph-recorded coherent unit of progress. The driver
//   does NOT iterate across passes — deciding what the next sub-goal
//   should be is the autonomy continuation engine's job, planning from
//   the graph state recorded after this pass. The driver receives a
//   TaskGoal so the composer can frame "pass N for task T" and so
//   PassResult can carry the goal back to the caller.
//
// What does NOT belong inside one pass:
//   - Two unrelated coherent units of progress (split into two passes).
//   - Speculation/planning with no assessable state transition (those
//     belong to context-builder reasoning, not to a pass).
//
// Discipline (ADR-089):
//   - No vscode imports. No globals. No empty stubs. Every step does
//     real work. Provider knowledge stays in the architect-llm adapter
//     behind ProviderPort — the driver names no provider.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_MAX_INNER_ITERATIONS = void 0;
exports.runPass = runPass;
/** Default cap for inner agentic-loop iterations within one pass.
 *  Matches chat-panel's existing `maxPasses = 12` ceiling so behavior
 *  stays identical when the seam is wired in Phase 3. */
exports.DEFAULT_MAX_INNER_ITERATIONS = 12;
async function runPass(input) {
    const { userIntent, ports, priorMessages, task, provider } = input;
    const tools = input.tools ?? [];
    const maxIterations = input.maxIterations ?? exports.DEFAULT_MAX_INNER_ITERATIONS;
    const startedAtEpochMs = ports.clock.nowEpochMs();
    // 1. Autonomy contract for this turn.
    const autonomyContract = ports.autonomy.contractForTurn(userIntent.text);
    // 2. Build the context envelope + assembled context block.
    const contextResult = await ports.contextBuilder.buildContext({
        userIntent,
        commandSource: "chat",
        budgetCoordinator: input.budgetCoordinator,
    });
    // 3. Resolve user content blocks and the dropped-attachment list.
    //    Both decisions are provider-agnostic here.
    const contentBlocks = ports.attachments.buildContentBlocksForTurn(userIntent.text);
    const droppedAttachments = ports.attachments.attachmentsDroppedThisTurn();
    // 4. Compose additional-instructions text. Pass + task goal framing
    //    is stacked alongside the attachment summary and any stop-context
    //    resume block. Empty parts are elided.
    const additionalInstructions = composeAdditionalInstructions({
        attachmentSummary: ports.attachments.summaryForPrompt(),
        stopContextBlock: userIntent.stopContextBlock,
        passGoal: input.passGoal,
        taskGoal: input.taskGoal,
    });
    // 5. Compose the prompt once. The same composed prompt is reused as
    //    the BASE for every inner iteration; iteration history is layered
    //    on top by the provider adapter via CallProviderInput.iterationHistory.
    const prompt = await ports.promptComposer.composePrompt({
        userIntent: contentBlocks
            ? { ...userIntent, contentBlocks: contentBlocks }
            : userIntent,
        contextResult,
        priorMessages,
        additionalInstructions,
        autonomyContract,
        task,
        provider,
        passGoal: input.passGoal,
        taskGoal: input.taskGoal,
    });
    // 6. Persist the user message BEFORE the network call so a crash
    //    mid-call does not lose the prompt that produced it.
    await ports.memory.persistUserMessage(userIntent.text, contentBlocks);
    // 7. Attachments are bound to the message that just shipped; clear
    //    them now (D3 invariant — exactly once per pass, before network).
    await ports.attachments.clearAfterDispatch();
    // 8. Inner agentic loop. Iterate until the provider emits no more
    //    tool calls, the cap is hit, the host aborts, or an error escapes.
    const iterations = [];
    let stopReason = "max-iterations";
    let lastProviderRawAssistant;
    try {
        for (let i = 1; i <= maxIterations; i++) {
            if (input.abortSignal?.aborted) {
                stopReason = "aborted";
                break;
            }
            const proposal = await ports.provider.callProvider({
                prompt,
                tools,
                // Snapshot history at call time — the array we mutate after this
                // point must not be visible to the adapter as the same reference.
                iterationHistory: Object.freeze(iterations.slice()),
                onStreamChunk: input.onStreamChunk,
                abortSignal: input.abortSignal,
            });
            const toolInvocations = [];
            let abortedDuringTools = false;
            for (const call of proposal.toolCalls) {
                if (input.abortSignal?.aborted) {
                    abortedDuringTools = true;
                    break;
                }
                const record = await ports.toolExecutor.executeTool({ call });
                toolInvocations.push(record);
            }
            const iteration = Object.freeze({
                index: i,
                assistantText: proposal.response.content,
                toolCalls: Object.freeze(proposal.toolCalls.slice()),
                toolInvocations: Object.freeze(toolInvocations.slice()),
                providerRawAssistant: proposal.response.providerRawAssistant
                    ? Object.freeze(proposal.response.providerRawAssistant.slice())
                    : undefined,
            });
            iterations.push(iteration);
            lastProviderRawAssistant = iteration.providerRawAssistant;
            if (abortedDuringTools) {
                stopReason = "aborted";
                break;
            }
            if (proposal.toolCalls.length === 0) {
                stopReason = "complete";
                break;
            }
            // else: provider asked for more tools — loop again. The adapter
            // will see the growing iterationHistory on the next call and
            // splice the assistant turn + tool_result batch into the wire
            // messages so the model sees the running dialogue.
        }
    }
    catch (err) {
        const isAbort = err instanceof Error && err.name === "AbortError";
        stopReason = isAbort ? "aborted" : "error";
        const message = err instanceof Error ? err.message : String(err);
        iterations.push(Object.freeze({
            index: iterations.length + 1,
            assistantText: `Pass aborted: ${message}`,
            toolCalls: Object.freeze([]),
            toolInvocations: Object.freeze([]),
            providerRawAssistant: undefined,
        }));
    }
    const assistantContent = iterations.map((it) => it.assistantText).filter(Boolean).join("");
    const flatToolInvocations = iterations
        .flatMap((it) => Array.from(it.toolInvocations));
    // 9. Persist the assistant turn. Content = concatenation across all
    //    iterations (matches chat-panel's existing `finalText`). The
    //    final iteration's providerRawAssistant items are forwarded so
    //    the next pass's replay logic keeps working.
    await ports.memory.persistAssistantMessage({
        content: assistantContent,
        providerRawAssistant: lastProviderRawAssistant,
    });
    // 10. Notify the autonomy subsystem so its pass-budget bookkeeping
    //     advances. Driver invariant: exactly once per pass, after
    //     persistence. The tool count is the cumulative total across all
    //     inner iterations of this pass.
    await ports.autonomy.recordPassCompleted({
        assistantText: assistantContent,
        toolInvocations: flatToolInvocations.length,
    });
    const endedAtEpochMs = ports.clock.nowEpochMs();
    return Object.freeze({
        startedAtEpochMs,
        endedAtEpochMs,
        assistantMessage: Object.freeze({
            content: assistantContent,
        }),
        iterations: Object.freeze(iterations.slice()),
        toolInvocations: Object.freeze(flatToolInvocations.slice()),
        stopReason,
        providerRawAssistant: lastProviderRawAssistant,
        nextStopContextBlock: undefined,
        droppedAttachments: Object.freeze(droppedAttachments.slice()),
        passGoal: input.passGoal,
        taskGoal: input.taskGoal,
    });
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Stack the optional framing sections into a single additional-
 * instructions block. Goals come first so the model frames its
 * reasoning around them; attachment + resume context follow.
 */
function composeAdditionalInstructions(parts) {
    const sections = [];
    if (parts.taskGoal) {
        const completed = parts.taskGoal.completedPassGoals?.length ?? 0;
        sections.push(`Task goal (id=${parts.taskGoal.id}): ${parts.taskGoal.summary}` +
            (completed > 0 ? ` — ${completed} pass goal(s) already completed for this task.` : ""));
    }
    if (parts.passGoal) {
        const criteria = parts.passGoal.successCriteria
            ? `\nSuccess criteria: ${parts.passGoal.successCriteria}`
            : "";
        sections.push(`Pass goal (id=${parts.passGoal.id}): ${parts.passGoal.summary}` +
            criteria +
            `\nThis pass is one coherent unit of progress toward the task goal. ` +
            `Maintain cognitive continuity across your tool calls and run as ` +
            `many as the sub-goal needs (read, search, patch, verify) before ` +
            `stopping. End the pass when you reach a meaningful state ` +
            `transition: produce a verdict on what changed and a next step. ` +
            `The transition will be assessed and recorded into the graph ` +
            `before the next pass plans; do not start a second unrelated ` +
            `unit of progress in this pass.`);
    }
    if (parts.attachmentSummary && parts.attachmentSummary.trim()) {
        sections.push(parts.attachmentSummary.trim());
    }
    if (parts.stopContextBlock && parts.stopContextBlock.trim()) {
        sections.push(parts.stopContextBlock.trim());
    }
    return sections.length > 0 ? sections.join("\n\n") : undefined;
}
//# sourceMappingURL=pass.js.map