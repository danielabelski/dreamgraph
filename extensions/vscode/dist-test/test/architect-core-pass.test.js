"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Phase 2 driver tests (ADR-089).
//
// Validates `runPass()` behavior against in-memory port fakes. Each
// fake records its inputs so ordering and payload invariants can be
// asserted; canned outputs let the test sequence the inner agentic
// loop deterministically. No real provider, no real tools, no I/O.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const index_js_1 = require("../architect-core/index.js");
// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------
class FakeClock {
    ticks = [];
    current = 1_000;
    nowEpochMs() {
        const value = this.current;
        this.ticks.push(value);
        this.current += 100;
        return value;
    }
}
class FakeContextBuilder {
    calls = [];
    async buildContext(input) {
        this.calls.push({ commandSource: input.commandSource, intentText: input.userIntent.text });
        return {
            envelope: null,
            assembledContext: "FAKE_CONTEXT",
            reasoningPacket: null,
            reasoningLens: undefined,
        };
    }
}
class FakePromptComposer {
    lastInput;
    async composePrompt(input) {
        this.lastInput = input;
        return {
            system: `SYS|${input.task}|extras=${input.additionalInstructions ?? ""}`,
            conversation: [
                ...input.priorMessages,
                { role: "user", content: input.userIntent.contentBlocks ?? input.userIntent.text },
            ],
        };
    }
}
class FakeProvider {
    script;
    calls = [];
    llm = {};
    capabilities;
    constructor(script, capabilities = {
        textAttachments: true,
        imageAttachments: true,
    }) {
        this.script = script;
        this.capabilities = capabilities;
    }
    async callProvider(input) {
        this.calls.push(input);
        const next = this.script[this.calls.length - 1];
        if (!next) {
            throw new Error(`FakeProvider: no scripted response for call #${this.calls.length}`);
        }
        if (next instanceof Error) {
            throw next;
        }
        return { response: next, toolCalls: next.toolCalls };
    }
    getCapabilities() {
        return this.capabilities;
    }
}
class FakeToolExecutor {
    executed = [];
    async executeTool(input) {
        this.executed.push(input.call);
        return {
            call: input.call,
            resultText: `result-of-${input.call.name}`,
            isError: false,
            durationMs: 5,
        };
    }
}
class FakeMemory {
    events = [];
    async persistUserMessage(text, contentBlocks) {
        this.events.push({ kind: "user", payload: { text, contentBlocks } });
    }
    async persistAssistantMessage(args) {
        this.events.push({ kind: "assistant", payload: args });
    }
}
class FakeAttachments {
    blocks;
    dropped;
    summary;
    clearedTimes = 0;
    buildCalls = [];
    constructor(blocks = undefined, dropped = [], summary = "") {
        this.blocks = blocks;
        this.dropped = dropped;
        this.summary = summary;
    }
    buildContentBlocksForTurn(text) {
        this.buildCalls.push(text);
        return this.blocks;
    }
    attachmentsDroppedThisTurn() {
        return this.dropped;
    }
    async clearAfterDispatch() {
        this.clearedTimes += 1;
    }
    summaryForPrompt() {
        return this.summary;
    }
}
class FakeAutonomy {
    completed = [];
    contract = {
        enabled: false,
        mode: "cautious",
        remainingAutoPasses: 0,
        completedAutoPasses: 0,
    };
    contractForTurn(_promptText) {
        return this.contract;
    }
    async recordPassCompleted(args) {
        this.completed.push(args);
    }
}
function buildPorts(opts) {
    const clock = new FakeClock();
    const context = new FakeContextBuilder();
    const composer = new FakePromptComposer();
    const provider = new FakeProvider(opts.providerScript, opts.capabilities);
    const tools = new FakeToolExecutor();
    const memory = new FakeMemory();
    const attachments = opts.attachments ?? new FakeAttachments();
    const autonomy = new FakeAutonomy();
    return {
        ports: {
            contextBuilder: context,
            promptComposer: composer,
            provider,
            toolExecutor: tools,
            memory,
            attachments,
            autonomy,
            clock,
        },
        clock,
        context,
        composer,
        provider,
        tools,
        memory,
        attachments,
        autonomy,
    };
}
function intent(text) {
    return { text };
}
function toolResp(content, toolCalls = [], rawItems) {
    return {
        content,
        promptTokens: 1,
        completionTokens: 1,
        durationMs: 1,
        toolCalls,
        stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn",
        providerRawAssistant: rawItems,
    };
}
const baseRunInput = {
    priorMessages: [],
    task: "chat",
    provider: "anthropic",
};
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
(0, node_test_1.default)("runPass: text-only turn calls ports in canonical order and stops on no tool calls", async () => {
    const built = buildPorts({ providerScript: [toolResp("hello world")] });
    const result = await (0, index_js_1.runPass)({ ...baseRunInput, userIntent: intent("hi"), ports: built.ports });
    strict_1.default.equal(result.stopReason, "complete");
    strict_1.default.equal(result.iterations.length, 1);
    strict_1.default.equal(result.assistantMessage.content, "hello world");
    strict_1.default.equal(result.toolInvocations.length, 0);
    strict_1.default.deepEqual(built.context.calls, [{ commandSource: "chat", intentText: "hi" }]);
    // user persisted before clearAfterDispatch, both before provider
    const userIdx = built.memory.events.findIndex((e) => e.kind === "user");
    const assistantIdx = built.memory.events.findIndex((e) => e.kind === "assistant");
    strict_1.default.ok(userIdx < assistantIdx, "user persisted before assistant");
    strict_1.default.equal(built.attachments.clearedTimes, 1);
    strict_1.default.equal(built.autonomy.completed.length, 1);
    strict_1.default.equal(built.autonomy.completed[0].toolInvocations, 0);
});
(0, node_test_1.default)("runPass: forwards content blocks to composer when attachments present", async () => {
    const blocks = [{ type: "text", text: "hi" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }];
    const att = new FakeAttachments(blocks, [], "1 image attached");
    const built = buildPorts({ providerScript: [toolResp("ok")], attachments: att });
    const result = await (0, index_js_1.runPass)({ ...baseRunInput, userIntent: intent("look"), ports: built.ports });
    strict_1.default.deepEqual(built.composer.lastInput?.userIntent.contentBlocks, blocks);
    strict_1.default.match(built.composer.lastInput?.additionalInstructions ?? "", /1 image attached/);
    strict_1.default.equal(result.droppedAttachments.length, 0);
});
(0, node_test_1.default)("runPass: surfaces dropped attachments without posting them itself", async () => {
    const att = new FakeAttachments(undefined, ["screenshot.png", "diagram.png"], "");
    const built = buildPorts({
        providerScript: [toolResp("text-only reply")],
        attachments: att,
        capabilities: { textAttachments: true, imageAttachments: false },
    });
    const result = await (0, index_js_1.runPass)({ ...baseRunInput, userIntent: intent("see this"), ports: built.ports });
    strict_1.default.deepEqual(result.droppedAttachments, ["screenshot.png", "diagram.png"]);
});
(0, node_test_1.default)("runPass: clears attachments exactly once, after persistence and before provider", async () => {
    const att = new FakeAttachments();
    const built = buildPorts({ providerScript: [toolResp("ok")], attachments: att });
    await (0, index_js_1.runPass)({ ...baseRunInput, userIntent: intent("hi"), ports: built.ports });
    strict_1.default.equal(att.clearedTimes, 1);
    strict_1.default.equal(built.provider.calls.length, 1);
});
(0, node_test_1.default)("runPass: runs the inner agentic loop across many tool batches in service of one pass", async () => {
    // Three iterations: tools → tools → final text. Demonstrates "tens of
    // consecutive tool calls per pass" pattern; iteration history grows.
    const callA = { id: "t1", name: "search", input: { q: "x" } };
    const callB = { id: "t2", name: "read_file", input: { path: "a.ts" } };
    const callC = { id: "t3", name: "edit", input: { path: "a.ts" } };
    const built = buildPorts({
        providerScript: [
            toolResp("planning…", [callA, callB]),
            toolResp("editing…", [callC]),
            toolResp("done."),
        ],
    });
    const result = await (0, index_js_1.runPass)({ ...baseRunInput, userIntent: intent("refactor"), ports: built.ports });
    strict_1.default.equal(result.stopReason, "complete");
    strict_1.default.equal(result.iterations.length, 3);
    strict_1.default.equal(result.toolInvocations.length, 3);
    strict_1.default.deepEqual(result.toolInvocations.map((r) => r.call.name), ["search", "read_file", "edit"]);
    // Provider sees growing iteration history per call
    strict_1.default.equal(built.provider.calls[0].iterationHistory.length, 0);
    strict_1.default.equal(built.provider.calls[1].iterationHistory.length, 1);
    strict_1.default.equal(built.provider.calls[2].iterationHistory.length, 2);
    strict_1.default.equal(result.assistantMessage.content, "planning…editing…done.");
    // Single autonomy notification with cumulative tool count
    strict_1.default.equal(built.autonomy.completed.length, 1);
    strict_1.default.equal(built.autonomy.completed[0].toolInvocations, 3);
});
(0, node_test_1.default)("runPass: stops at maxIterations cap when provider keeps requesting tools", async () => {
    const call = { id: "t", name: "loop", input: {} };
    const built = buildPorts({
        providerScript: [toolResp("a", [call]), toolResp("b", [call]), toolResp("c", [call])],
    });
    const result = await (0, index_js_1.runPass)({
        ...baseRunInput,
        userIntent: intent("spin"),
        ports: built.ports,
        maxIterations: 2,
    });
    strict_1.default.equal(result.stopReason, "max-iterations");
    strict_1.default.equal(result.iterations.length, 2);
    strict_1.default.equal(result.toolInvocations.length, 2);
});
(0, node_test_1.default)("runPass: surfaces provider error as 'error' stop reason without throwing", async () => {
    const built = buildPorts({ providerScript: [new Error("boom")] });
    const result = await (0, index_js_1.runPass)({ ...baseRunInput, userIntent: intent("hi"), ports: built.ports });
    strict_1.default.equal(result.stopReason, "error");
    strict_1.default.match(result.assistantMessage.content, /boom/);
    strict_1.default.equal(built.autonomy.completed.length, 1, "autonomy still notified on error");
    strict_1.default.equal(built.memory.events.filter((e) => e.kind === "assistant").length, 1);
});
(0, node_test_1.default)("runPass: aborts mid-loop when abortSignal fires before next iteration", async () => {
    const call = { id: "t", name: "noop", input: {} };
    const controller = new AbortController();
    // Abort right after first iteration's tool call records; we trigger via the executor.
    const built = buildPorts({
        providerScript: [toolResp("a", [call]), toolResp("b", [call])],
    });
    const realExec = built.tools.executeTool.bind(built.tools);
    built.tools.executeTool = async (input) => {
        const r = await realExec(input);
        controller.abort();
        return r;
    };
    const result = await (0, index_js_1.runPass)({
        ...baseRunInput,
        userIntent: intent("go"),
        ports: built.ports,
        abortSignal: controller.signal,
    });
    strict_1.default.equal(result.stopReason, "aborted");
    strict_1.default.equal(built.provider.calls.length, 1, "no second provider call after abort");
});
(0, node_test_1.default)("runPass: frames pass goal and task goal into composer additionalInstructions", async () => {
    const built = buildPorts({ providerScript: [toolResp("ok")] });
    await (0, index_js_1.runPass)({
        ...baseRunInput,
        userIntent: intent("work"),
        ports: built.ports,
        passGoal: { id: "p1", summary: "investigate auth flow", successCriteria: "found entry point" },
        taskGoal: { id: "T9", summary: "ship 2FA", completedPassGoals: [{ id: "p0", summary: "scope" }] },
    });
    const extras = built.composer.lastInput?.additionalInstructions ?? "";
    strict_1.default.match(extras, /Task goal \(id=T9\): ship 2FA/);
    strict_1.default.match(extras, /1 pass goal\(s\) already completed/);
    strict_1.default.match(extras, /Pass goal \(id=p1\): investigate auth flow/);
    strict_1.default.match(extras, /Success criteria: found entry point/);
    strict_1.default.match(extras, /coherent unit of progress/i);
    strict_1.default.match(extras, /cognitive continuity/i);
    strict_1.default.match(extras, /meaningful state transition/i);
});
(0, node_test_1.default)("runPass: propagates final iteration's providerRawAssistant unchanged to memory", async () => {
    const raw = [{ type: "reasoning", id: "r1" }, { type: "message", id: "m1" }];
    const built = buildPorts({
        providerScript: [toolResp("plan", [{ id: "t", name: "tool", input: {} }]), toolResp("final", [], raw)],
    });
    const result = await (0, index_js_1.runPass)({ ...baseRunInput, userIntent: intent("go"), ports: built.ports });
    strict_1.default.deepEqual(result.providerRawAssistant, raw);
    const assistantEvent = built.memory.events.find((e) => e.kind === "assistant");
    strict_1.default.deepEqual(assistantEvent?.payload.providerRawAssistant, raw);
});
//# sourceMappingURL=architect-core-pass.test.js.map