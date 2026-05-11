"use strict";
// STRICT ISOLATION (ADR-140 + ADR-171): no import from v1; no
// mcp_dreamgraph_* anywhere in this file. Graph reads/writes go through
// ProjectGraphReader / ProjectGraphRecorder ports.
//
// Slice 8A.1 — Orchestrator pass loop.
//
// `runPass` is the single entry point. It is async (ports do real I/O)
// but contains no I/O of its own. Every effect is delegated to a port.
//
// Canonical sequence (one pass):
//   1. Build context envelope         (ContextBuilder port)
//   2. Compose prompt                 (PromptComposer port)
//   3. Call provider                  (Executor port)
//   4. Derive next action             (Slice 3 deriveNextAction, pure)
//   5. If continue:
//        a. Resolve operating capability from selected action
//        b. Execute capability         (Executor port)
//        c. Plan verifications        (Slice 7 planVerifications, pure)
//        d. Execute each verification  (Executor port, one per step)
//        e. Classify completion       (Slice 7 classifyCompletion, pure)
//        f. Build cards               (Slice 5 factories, pure)
//   6. Append PassRecord -> new TaskState
//   7. Compute metrics                (Slice 7 computeMetrics, pure)
//   8. Persist via Memory + Recorder  (Memory + ProjectGraphRecorder ports)
//   9. Return PassResult
//
// Multi-action passes are out of scope for the skeleton: we operate on
// the top-ranked action only.
Object.defineProperty(exports, "__esModule", { value: true });
exports.richnessToGraphBound = richnessToGraphBound;
exports.runPass = runPass;
exports.resolveCapabilityFromAction = resolveCapabilityFromAction;
const index_js_1 = require("../autonomy/index.js");
const index_js_2 = require("../capabilities/index.js");
const index_js_3 = require("../execution/index.js");
const index_js_4 = require("../verification/index.js");
const index_js_5 = require("../cards/index.js");
const ZERO_REPAIR_COUNTERS = Object.freeze({
    build: 0,
    test: 0,
    type: 0,
    lint: 0,
    mcp_verify: 0,
    invariant: 0,
});
/**
 * Conservative default pill set used by the loop when assembling cards
 * outside the `computePills` derivation path (stop / pause / blocker /
 * decision / edit / verification scaffolding). Every field is a real,
 * type-correct value so `pillsLine` never emits `"undefined"`. The
 * orchestrator overlays richer information when it is available; this
 * is the floor that guarantees a coherent card surface.
 */
function buildLoopDefaultPills(args) {
    return Object.freeze({
        certainty: "medium",
        mode: args.taskState.mode,
        provider: args.providerProfile.id,
        graphBound: args.graphBound ?? "no",
        autonomyState: args.taskState.status,
        tier: null,
        fallbackReason: null,
        verificationStatus: null,
    });
}
/**
 * Map a global GraphRichness signal into the GraphBound pill value.
 * Graph-first invariant: if the project graph reports any usable
 * richness, every downstream card MUST advertise graph:yes/partial so
 * the user can see the agent is grounded.
 */
function richnessToGraphBound(richness) {
    switch (richness) {
        case "rich":
            return "yes";
        case "partial":
            return "partial";
        case "sparse":
            return "partial";
        case "absent":
        case undefined:
            return "no";
        default: {
            const _exhaustive = richness;
            return _exhaustive;
        }
    }
}
async function runPass(input) {
    const { taskState, userIntent, providerProfile, ports } = input;
    const startedAtEpochMs = ports.clock.nowEpochMs();
    // Graph-first invariant: probe the project graph BEFORE any
    // capability decision so every card surfaces real graph state. The
    // probe is `safe`: failures fall back to graph:no but never throw.
    let globalRichness;
    try {
        const sig = await ports.projectGraphReader.getRichnessSignal({
            kind: "global",
        });
        globalRichness = sig.richness;
    }
    catch {
        globalRichness = undefined;
    }
    const passGraphBound = richnessToGraphBound(globalRichness);
    const EMPTY_PILLS = buildLoopDefaultPills({
        taskState,
        providerProfile,
        graphBound: passGraphBound,
    });
    // 1-2. Context + prompt.
    // ADR-174: composer declares requirements first; assembler fulfills.
    // The composer is graph-aware (knows what kinds it wants) but not
    // graph-active (does not retrieve). The assembler is the only cognition
    // site. Capability hint comes from the continuation when present;
    // fresh user turns leave it undefined.
    const requirements = ports.promptComposer.declareRequirements({
        taskState,
        userIntent,
        capabilityHint: requirementsCapabilityHint(userIntent),
    });
    const contextEnvelope = await ports.contextBuilder.buildContext({
        taskState,
        userIntent,
        providerProfile,
        requirements,
        windowTokens: input.windowTokens,
    });
    const prompt = await ports.promptComposer.composePrompt({
        contextEnvelope,
        userIntent,
        providerProfile,
        autonomyContract: buildAutonomyContract(taskState),
    });
    // 3. Provider proposes ranked candidates.
    const inventory = buildLocalInventory();
    const proposal = await ports.executor.callProvider({
        prompt,
        providerProfile,
        inventory,
    });
    // 4. Pure decision.
    const decision = (0, index_js_1.deriveNextAction)({
        taskState,
        inventory,
        candidates: proposal.candidates,
        nowEpochMs: ports.clock.nowEpochMs(),
    });
    // ---- Non-continue paths ----
    if (decision.kind === "stop") {
        const summary = composeTerminalSummary(stopConditionSummary(decision), proposal.rationale);
        return finalize({
            ports,
            taskState,
            userIntent,
            startedAtEpochMs,
            cards: [
                (0, index_js_5.createCompletionCard)({
                    id: cardId(taskState.id, "completion"),
                    taskId: taskState.id,
                    nowEpochMs: ports.clock.nowEpochMs(),
                    pills: EMPTY_PILLS,
                }, { summary, artifacts: [] }),
            ],
            outcomes: [],
            classifications: [],
            enrichmentDrained: 0,
            enrichmentQueued: [],
            newStatus: "stopped",
            goalReached: decision.condition.kind === "goal_reached",
            deltaSummary: summary,
            continuation: undefined,
            decisionRecord: undefined,
            outcomeRecords: [],
            trailingNote: undefined,
        });
    }
    if (decision.kind === "pause_for_user") {
        const summary = composeTerminalSummary(decision.note, proposal.rationale);
        return finalize({
            ports,
            taskState,
            userIntent,
            startedAtEpochMs,
            cards: [
                (0, index_js_5.createCompletionCard)({
                    id: cardId(taskState.id, "pause"),
                    taskId: taskState.id,
                    nowEpochMs: ports.clock.nowEpochMs(),
                    pills: EMPTY_PILLS,
                }, { summary, artifacts: [] }),
            ],
            outcomes: [],
            classifications: [],
            enrichmentDrained: 0,
            enrichmentQueued: [],
            newStatus: "paused_for_user",
            goalReached: false,
            deltaSummary: summary,
            continuation: undefined,
            decisionRecord: undefined,
            outcomeRecords: [],
            trailingNote: undefined,
        });
    }
    // 5. Continue path.
    const action = decision.need.selectedAction;
    // 5.0. Synthetic reply path. The executor adapter emits a
    // `architect.reply` candidate whenever the model produced prose, so
    // every textual answer flows through this branch. It carries no
    // CapabilityId because no MCP tool is dispatched — we just surface
    // the model's text as a Completion card and stop. This is the only
    // way a non-tool turn can reach the user without tripping the
    // capability gate below.
    if (action.tool === "architect.reply") {
        const replyText = proposal.rationale && proposal.rationale.trim().length > 0
            ? proposal.rationale
            : action.rationale;
        return finalize({
            ports,
            taskState,
            userIntent,
            startedAtEpochMs,
            cards: [
                (0, index_js_5.createCompletionCard)({
                    id: cardId(taskState.id, "completion"),
                    taskId: taskState.id,
                    nowEpochMs: ports.clock.nowEpochMs(),
                    pills: EMPTY_PILLS,
                }, { summary: replyText, artifacts: [] }),
            ],
            outcomes: [],
            classifications: [],
            enrichmentDrained: 0,
            enrichmentQueued: [],
            newStatus: "stopped",
            goalReached: true,
            deltaSummary: replyText,
            continuation: undefined,
            decisionRecord: undefined,
            outcomeRecords: [],
            trailingNote: undefined,
        });
    }
    const capabilityId = resolveCapabilityFromAction(action);
    if (!capabilityId) {
        return finalize({
            ports,
            taskState,
            userIntent,
            startedAtEpochMs,
            cards: [
                (0, index_js_5.createBlockerCard)({
                    id: cardId(taskState.id, "blocker"),
                    taskId: taskState.id,
                    nowEpochMs: ports.clock.nowEpochMs(),
                    pills: EMPTY_PILLS,
                }, {
                    reason: `No CapabilityId resolves from action ${action.id} (tool=${action.tool})`,
                    blockedBy: [...action.requiresCapabilities],
                }),
            ],
            outcomes: [],
            classifications: [],
            enrichmentDrained: 0,
            enrichmentQueued: [],
            newStatus: "stopped",
            goalReached: false,
            deltaSummary: "Selected action references unknown capability.",
            continuation: undefined,
            decisionRecord: undefined,
            outcomeRecords: [],
            trailingNote: proposal.rationale,
        });
    }
    const cards = [];
    const outcomes = [];
    const classifications = [];
    const enrichmentTasks = [];
    // ADR-171: density now comes from the ProjectGraphReader port, not from
    // a static density probe owned by the orchestrator. Slice 6's
    // GraphDensity vocabulary is preserved.
    const richnessSignal = await ports.projectGraphReader.getRichnessSignal({
        kind: "capability",
        capabilityId,
    });
    const density = richnessToDensity(richnessSignal.richness);
    // Decision card. Dedupe alternatives by label and drop the chosen
    // entry — providers sometimes emit duplicates or include the chosen
    // action in the considered set, which clutters the rendered card.
    const dedupedAlternatives = Array.from(new Set(decision.need.alternativesConsidered
        .map((a) => a.label)
        .filter((label) => label !== action.label)));
    const decisionCardId = cardId(taskState.id, "decision");
    cards.push((0, index_js_5.createDecisionCard)({
        id: decisionCardId,
        taskId: taskState.id,
        nowEpochMs: ports.clock.nowEpochMs(),
        pills: EMPTY_PILLS,
    }, {
        question: "Next action",
        chosen: action.label,
        alternatives: dedupedAlternatives,
        rationale: decision.need.reasoningTrace,
    }));
    const decisionRecord = {
        id: decisionCardId,
        taskId: taskState.id,
        atEpochMs: ports.clock.nowEpochMs(),
        chosen: action.label,
        alternatives: dedupedAlternatives,
        rationale: decision.need.reasoningTrace,
    };
    // 5b. Execute the chosen capability.
    const mutationOutcome = await ports.executor.executeCapability({
        capabilityId,
        toolName: action.tool,
        toolArgs: action.toolArgs,
        invocationReason: { kind: "user_action" },
    });
    outcomes.push(mutationOutcome);
    if (mutationOutcome.kind === "success" && (0, index_js_3.outcomeProducedArtifacts)(mutationOutcome)) {
        cards.push((0, index_js_5.createEditCard)({
            id: cardId(taskState.id, "edit"),
            taskId: taskState.id,
            nowEpochMs: ports.clock.nowEpochMs(),
            pills: EMPTY_PILLS,
        }, {
            artifacts: mutationOutcome.artifacts,
            diffSummary: `${mutationOutcome.tool} produced ${mutationOutcome.artifacts.length} artifact(s).`,
        }));
    }
    else if (mutationOutcome.kind === "success" ||
        mutationOutcome.kind === "partial") {
        // Read-only / non-mutating successes (e.g. `query_resource`,
        // `cognitive_status`, `list_directory`) produce no artifacts but do
        // return a payload. Surface that payload via an OutcomeCard so the
        // user can see what the tool actually returned — without this the
        // pipeline reports "success" with no visible content.
        cards.push((0, index_js_5.createOutcomeCard)({
            id: cardId(taskState.id, "outcome"),
            taskId: taskState.id,
            nowEpochMs: ports.clock.nowEpochMs(),
        }, {
            certainty: EMPTY_PILLS.certainty,
            mode: EMPTY_PILLS.mode,
            provider: EMPTY_PILLS.provider,
            autonomyState: EMPTY_PILLS.autonomyState,
        }, mutationOutcome));
    }
    // 5c-d. Plan + execute verifications.
    const vplan = (0, index_js_4.planVerifications)(capabilityId, mutationOutcome);
    const evidenceByKind = {};
    for (const step of vplan.steps) {
        const vOutcome = await ports.executor.executeCapability({
            capabilityId: step.performedBy,
            invocationReason: { kind: "verification", verificationKind: step.kind },
        });
        outcomes.push(vOutcome);
        if (vOutcome.kind === "success" && vOutcome.evidence) {
            evidenceByKind[step.kind] = vOutcome.evidence;
            cards.push((0, index_js_5.createVerificationCard)({
                id: cardId(taskState.id, `verify-${step.kind}`),
                taskId: taskState.id,
                nowEpochMs: ports.clock.nowEpochMs(),
                pills: EMPTY_PILLS,
            }, vOutcome.evidence));
        }
    }
    // 5e. Classify.
    const classification = (0, index_js_4.classifyCompletion)({
        mutationOutcome,
        plan: vplan,
        evidence: evidenceByKind,
        repairAttemptsByKind: ZERO_REPAIR_COUNTERS,
        autonomyBudget: { continuationsRemaining: taskState.passBudget.remaining },
    });
    classifications.push(classification);
    if (classification.kind === "blocked") {
        cards.push((0, index_js_5.createBlockerCard)({
            id: cardId(taskState.id, "blocker"),
            taskId: taskState.id,
            nowEpochMs: ports.clock.nowEpochMs(),
            pills: EMPTY_PILLS,
        }, {
            reason: classification.blocker.description,
            blockedBy: classification.blocker.requiredCapability
                ? [classification.blocker.requiredCapability]
                : [classification.blocker.kind],
        }));
    }
    // Sparse-mode / gap enrichment (Slice 6).
    if (density === "absent" || density === "sparse") {
        const task = (0, index_js_2.buildEnrichmentTask)(capabilityId, density === "absent" ? "graph_only_gap" : "sparse_mode_used");
        if (task)
            enrichmentTasks.push(task);
    }
    // Continuation: from classifier (repair) or carry the original decision.
    const continuation = classification.kind === "repair_recommended"
        ? classification.continuation
        : decision.need;
    if (continuation) {
        cards.push((0, index_js_5.createNextStepCard)({
            id: cardId(taskState.id, "next-step"),
            taskId: taskState.id,
            nowEpochMs: ports.clock.nowEpochMs(),
            pills: EMPTY_PILLS,
        }, continuation));
    }
    // Build OutcomeRecord per executor outcome (graph-native; touchedNodeIds
    // stay opaque ids — adapters translate).
    const outcomeRecords = outcomes.map((o, i) => ({
        id: `${taskState.id}:outcome:${ports.clock.nowEpochMs()}:${i}`,
        taskId: taskState.id,
        atEpochMs: o.executedAtEpochMs,
        tool: o.tool,
        succeeded: o.kind === "success",
        summary: o.kind === "success"
            ? `${o.tool} succeeded (${o.artifacts.length} artifact(s)).`
            : o.kind === "failure"
                ? `${o.tool} failed: ${o.failureReason}`
                : `${o.tool} partial: blocked by ${o.blockedBy}`,
        touchedNodeIds: collectTouchedNodeIds(o),
    }));
    return finalize({
        ports,
        taskState,
        userIntent,
        startedAtEpochMs,
        cards,
        outcomes,
        classifications,
        enrichmentDrained: 0,
        enrichmentQueued: enrichmentTasks,
        newStatus: "running",
        goalReached: false,
        deltaSummary: summarizeOutcome(mutationOutcome, classification),
        continuation,
        decisionRecord,
        outcomeRecords,
        trailingNote: proposal.rationale,
    });
}
async function finalize(input) {
    const { ports, taskState } = input;
    const finishedAtEpochMs = ports.clock.nowEpochMs();
    const passIndex = taskState.passes.length;
    const endingArtifacts = [];
    for (const o of input.outcomes) {
        if (o.kind !== "success")
            continue;
        for (const a of o.artifacts) {
            const snap = artifactRefToSnapshot(a, finishedAtEpochMs);
            if (snap)
                endingArtifacts.push(snap);
        }
    }
    const passRecord = {
        index: passIndex,
        startedAtEpochMs: input.startedAtEpochMs,
        finishedAtEpochMs,
        deltaSummary: input.deltaSummary,
        endingArtifacts,
        hadVerification: input.classifications.some((c) => c.kind === "completed" ||
            c.kind === "repair_recommended" ||
            c.kind === "failed_verification"),
        goalReached: input.goalReached,
    };
    const newTaskState = {
        ...taskState,
        passBudget: (0, index_js_1.consumePass)(taskState.passBudget),
        passes: [...taskState.passes, passRecord],
        status: input.newStatus,
    };
    const metrics = (0, index_js_4.computeMetrics)({
        outcomes: input.outcomes,
        capabilityPlans: [],
        verificationPlans: [],
        classifications: input.classifications,
        priorRepairAttemptsByKind: ZERO_REPAIR_COUNTERS,
        enrichmentTasksDrained: input.enrichmentDrained,
    });
    // Memory port (8A.4 implements).
    await ports.memory.saveTaskState(newTaskState);
    await ports.memory.appendPassLog(taskState.id, {
        passIndex,
        endedAtEpochMs: finishedAtEpochMs,
        cardIds: input.cards.map((c) => c.id),
        toolsInvoked: input.outcomes.map((o) => o.tool),
    });
    // ADR-171: project-graph recorder writes. NullProjectGraphRecorder is
    // a no-op; the orchestrator never branches on whether a real backend
    // is wired.
    await ports.projectGraphRecorder.recordCards(input.cards);
    if (input.decisionRecord) {
        await ports.projectGraphRecorder.recordDecision(input.decisionRecord);
    }
    for (const r of input.outcomeRecords) {
        await ports.projectGraphRecorder.recordOutcome(r);
    }
    if (input.continuation) {
        await ports.projectGraphRecorder.recordContinuation(input.continuation);
    }
    return {
        newTaskState,
        cards: input.cards,
        outcomes: input.outcomes,
        classifications: input.classifications,
        metrics,
        continuation: input.continuation,
        deltaSummary: input.deltaSummary,
        trailingNote: input.trailingNote,
    };
}
function artifactRefToSnapshot(a, observedAtEpochMs) {
    if (a.kind !== "file" && a.kind !== "mcp_entity" && a.kind !== "verification") {
        return undefined;
    }
    return {
        kind: a.kind,
        id: a.id,
        hash: a.hash ?? "",
        observedAtEpochMs,
    };
}
function collectTouchedNodeIds(outcome) {
    if (outcome.kind === "failure")
        return [];
    // Use the artifact id as the ProjectGraphNodeId; adapters reconcile to
    // their own id scheme. This keeps the orchestrator graph-shape-agnostic.
    return outcome.artifacts.map((a) => a.id);
}
/**
 * Compose a terminal completion-card summary by folding any free-form\n * model rationale into the structured decision note. Provider-neutral:\n * runs `sanitizeFreeText` so any echoed tool-envelope JSON is stripped\n * before the text reaches the user-visible card body.\n */
function composeTerminalSummary(decisionNote, rationale) {
    const head = decisionNote.trim();
    const tail = (0, index_js_5.sanitizeFreeText)(rationale ?? "");
    if (tail.length === 0)
        return head;
    if (head.length === 0)
        return tail;
    // Avoid duplicating identical text the decision module may have
    // already lifted from the rationale.
    if (head === tail || head.includes(tail) || tail.includes(head))
        return head;
    return `${head}\n\n${tail}`;
}
function buildAutonomyContract(taskState) {
    return [
        `Mode: ${taskState.mode}.`,
        `Pass budget remaining: ${taskState.passBudget.remaining}.`,
        `Confidence threshold: ${taskState.profile.confidenceThreshold.toFixed(2)}.`,
        `Verification strictness: ${taskState.profile.verificationStrictness}.`,
    ].join(" ");
}
function buildLocalInventory() {
    // CapabilityInventory enumerates the CapabilityIds the orchestrator is
    // willing to attempt this pass. CAPABILITY_MATRIX is a frozen ARRAY of
    // CapabilityRecord, so `Object.keys(CAPABILITY_MATRIX)` would yield
    // the array indices ("0", "1", ...), NOT the capability ids — a bug
    // that left the inventory empty and silently zeroed the provider's
    // tool roster. Enumerate `.id` explicitly.
    const ids = index_js_2.CAPABILITY_MATRIX.map((r) => r.id);
    const set = new Set(ids);
    return {
        has: (cap) => set.has(cap),
        list: () => ids.slice().sort(),
    };
}
function resolveCapabilityFromAction(action) {
    // 1) Explicit requirement — must be a real CapabilityId, checked
    //    against array members (NOT `in` against array indices).
    if (action.requiresCapabilities.length > 0) {
        for (const cap of action.requiresCapabilities) {
            if (CAPABILITY_BY_ID.has(cap)) {
                return cap;
            }
        }
    }
    // 2) Tool-name path — map tool -> intent (from the static native
    //    catalog) -> CapabilityId (via the matrix's intent lists). This
    //    is the path real provider tool calls take; the executor no
    //    longer asserts a capability requirement on each candidate.
    const desc = TOOL_TO_DESCRIPTOR.get(action.tool);
    if (desc) {
        const cap = INTENT_TO_CAPABILITY.get(desc.intent);
        if (cap)
            return cap;
        // 3) Documented escape hatch (ADR-157): a tool exists in the
        //    native catalog but its intent has no graph-first/fallback
        //    record in the capability matrix. Route it through
        //    `env.lm.invoke_tool` so the orchestrator can dispatch and the
        //    executor's tool-name path takes over (Path A in
        //    executor-adapter.executeCapability). Without this branch the
        //    orchestrator would emit a BLOCKER for every cataloged tool
        //    not editorially listed in the matrix.
        return ESCAPE_HATCH_CAPABILITY;
    }
    return undefined;
}
// Documented escape hatch capability (matrix §2.6 / ADR-157). Resolved
// once at module load so the lookup cost stays O(1).
const ESCAPE_HATCH_CAPABILITY = 'env.lm.invoke_tool';
// Reverse indices over CAPABILITY_MATRIX + NATIVE_TOOL_CATALOG. Built
// once at module load. These are pure data lookups; no port required.
const CAPABILITY_BY_ID = new Set(index_js_2.CAPABILITY_MATRIX.map((r) => r.id));
const INTENT_TO_CAPABILITY = (() => {
    const m = new Map();
    for (const rec of index_js_2.CAPABILITY_MATRIX) {
        for (const intent of rec.graphFirst)
            m.set(intent, rec.id);
        for (const intent of rec.fallback) {
            // graphFirst wins on conflict (it is the preferred binding).
            if (!m.has(intent))
                m.set(intent, rec.id);
        }
    }
    return m;
})();
const TOOL_TO_DESCRIPTOR = new Map(index_js_3.NATIVE_TOOL_CATALOG.map((d) => [d.tool, d]));
/**
 * Capability hint for ADR-174 requirement declaration. Continuations
 * carry the action they intend to retry; we extract its first known
 * capability so the composer can ask for capability-shaped context.
 * Fresh turns return undefined.
 */
function requirementsCapabilityHint(userIntent) {
    const action = userIntent.continuation?.selectedAction;
    if (!action)
        return undefined;
    return resolveCapabilityFromAction(action);
}
function richnessToDensity(richness) {
    // Direct 1:1 mapping today; kept as a function so the port-side
    // vocabulary can evolve independently of Slice 6's internal one.
    switch (richness) {
        case "rich":
            return "rich";
        case "partial":
            return "partial";
        case "sparse":
            return "sparse";
        case "absent":
            return "absent";
        default: {
            const _exhaustive = richness;
            return _exhaustive;
        }
    }
}
function stopConditionSummary(decision) {
    const c = decision.condition;
    switch (c.kind) {
        case "goal_reached":
            return "Goal reached.";
        case "pass_budget_exhausted":
            return "Pass budget exhausted.";
        case "time_budget_exhausted":
            return "Time budget exhausted.";
        case "no_progress":
            return `Stopped: no progress over ${c.passesWithoutDelta} passes.`;
        case "no_viable_action":
            return "Stopped: no eligible candidate action.";
        case "blocker":
            return `Stopped: ${c.blocker.description}`;
        case "verification_failed":
            return `Stopped: verification failed (${c.failure.kind}).`;
        case "mode_threshold_unmet":
            return `Stopped: top confidence ${c.topConfidence.toFixed(2)} below threshold ${c.threshold.toFixed(2)}.`;
        case "user_paused":
            return "Stopped: user paused.";
        default: {
            const _exhaustive = c;
            return `Stopped: ${_exhaustive.kind}`;
        }
    }
}
function summarizeOutcome(outcome, classification) {
    const tool = outcome.tool;
    switch (classification.kind) {
        case "completed":
            return `${tool} completed (${classification.evidence.length} verification(s) passed).`;
        case "completed_no_verification_needed":
            return `${tool} completed (read-only).`;
        case "repair_recommended":
            return `${tool} produced ${classification.failedSteps.length} failed verification(s); repair queued.`;
        case "blocked":
            return `${tool}: blocked — ${classification.blocker.description}`;
        case "failed_verification":
            return `${tool}: verification unavailable (${classification.missingKinds.join(", ")}).`;
        case "mutation_failed":
            return `${tool}: mutation failed — ${classification.description}`;
        default: {
            const _exhaustive = classification;
            return `${tool}: ${_exhaustive.kind}`;
        }
    }
}
function cardId(taskId, kind) {
    return `${taskId}:${kind}:${Math.random().toString(36).slice(2, 10)}`;
}
//# sourceMappingURL=loop.js.map