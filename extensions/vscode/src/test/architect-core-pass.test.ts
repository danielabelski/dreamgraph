// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Phase 2 driver tests (ADR-089).
//
// Validates `runPass()` behavior against in-memory port fakes. Each
// fake records its inputs so ordering and payload invariants can be
// asserted; canned outputs let the test sequence the inner agentic
// loop deterministically. No real provider, no real tools, no I/O.

import test from "node:test";
import assert from "node:assert/strict";

import {
  runPass,
  type ArchitectCorePorts,
  type AttachmentPort,
  type AutonomyPort,
  type ContextBuilderPort,
  type ClockPort,
  type MemoryPort,
  type PromptComposerPort,
  type ProviderPort,
  type ToolExecutorPort,
} from "../architect-core/index.js";
import type {
  ArchitectMessage,
  ArchitectToolResponse,
  AutonomyContract,
  ProviderProposal,
  ToolInvocationRecord,
  ToolUseRequest,
  UserIntent,
} from "../architect-core/types.js";
import type { CallProviderInput, ComposePromptInput } from "../architect-core/ports.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeClock implements ClockPort {
  public ticks: number[] = [];
  private current = 1_000;
  nowEpochMs(): number {
    const value = this.current;
    this.ticks.push(value);
    this.current += 100;
    return value;
  }
}

class FakeContextBuilder implements ContextBuilderPort {
  public calls: Array<{ commandSource: string; intentText: string }> = [];
  async buildContext(input: { userIntent: UserIntent; commandSource: string }) {
    this.calls.push({ commandSource: input.commandSource, intentText: input.userIntent.text });
    return {
      envelope: null,
      assembledContext: "FAKE_CONTEXT",
      reasoningPacket: null,
      reasoningLens: undefined,
    };
  }
}

class FakePromptComposer implements PromptComposerPort {
  public lastInput?: ComposePromptInput;
  async composePrompt(input: ComposePromptInput) {
    this.lastInput = input;
    return {
      system: `SYS|${input.task}|extras=${input.additionalInstructions ?? ""}`,
      conversation: [
        ...input.priorMessages,
        { role: "user", content: input.userIntent.contentBlocks ?? input.userIntent.text },
      ] as readonly ArchitectMessage[],
    };
  }
}

class FakeProvider implements ProviderPort {
  public calls: CallProviderInput[] = [];
  public readonly llm = {} as unknown as import("../architect-llm.js").ArchitectLlm;
  private capabilities: { textAttachments: boolean; imageAttachments: boolean };
  constructor(
    private readonly script: ReadonlyArray<ArchitectToolResponse | Error>,
    capabilities: { textAttachments: boolean; imageAttachments: boolean } = {
      textAttachments: true,
      imageAttachments: true,
    },
  ) {
    this.capabilities = capabilities;
  }
  async callProvider(input: CallProviderInput): Promise<ProviderProposal> {
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

class FakeToolExecutor implements ToolExecutorPort {
  public executed: ToolUseRequest[] = [];
  async executeTool(input: { call: ToolUseRequest }): Promise<ToolInvocationRecord> {
    this.executed.push(input.call);
    return {
      call: input.call,
      resultText: `result-of-${input.call.name}`,
      isError: false,
      durationMs: 5,
    };
  }
}

class FakeMemory implements MemoryPort {
  public events: Array<{ kind: string; payload: unknown }> = [];
  async persistUserMessage(text: string, contentBlocks?: readonly unknown[]) {
    this.events.push({ kind: "user", payload: { text, contentBlocks } });
  }
  async persistAssistantMessage(args: {
    content: string;
    verdict?: { level: string; summary: string };
    providerRawAssistant?: readonly unknown[];
  }) {
    this.events.push({ kind: "assistant", payload: args });
  }
}

class FakeAttachments implements AttachmentPort {
  public clearedTimes = 0;
  public readonly buildCalls: string[] = [];
  constructor(
    private readonly blocks: readonly unknown[] | undefined = undefined,
    private readonly dropped: readonly string[] = [],
    private readonly summary: string = "",
  ) {}
  buildContentBlocksForTurn(text: string): readonly unknown[] | undefined {
    this.buildCalls.push(text);
    return this.blocks;
  }
  attachmentsDroppedThisTurn(): readonly string[] {
    return this.dropped;
  }
  async clearAfterDispatch(): Promise<void> {
    this.clearedTimes += 1;
  }
  summaryForPrompt(): string {
    return this.summary;
  }
}

class FakeAutonomy implements AutonomyPort {
  public completed: Array<{ assistantText: string; toolInvocations: number }> = [];
  public readonly contract: AutonomyContract = {
    enabled: false,
    mode: "cautious",
    remainingAutoPasses: 0,
    completedAutoPasses: 0,
  };
  contractForTurn(_promptText: string): AutonomyContract {
    return this.contract;
  }
  async recordPassCompleted(args: { assistantText: string; toolInvocations: number }) {
    this.completed.push(args);
  }
}

interface BuiltPorts {
  ports: ArchitectCorePorts;
  clock: FakeClock;
  context: FakeContextBuilder;
  composer: FakePromptComposer;
  provider: FakeProvider;
  tools: FakeToolExecutor;
  memory: FakeMemory;
  attachments: FakeAttachments;
  autonomy: FakeAutonomy;
}

function buildPorts(opts: {
  providerScript: ReadonlyArray<ArchitectToolResponse | Error>;
  attachments?: FakeAttachments;
  capabilities?: { textAttachments: boolean; imageAttachments: boolean };
}): BuiltPorts {
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

function intent(text: string): UserIntent {
  return { text };
}

function toolResp(content: string, toolCalls: ToolUseRequest[] = [], rawItems?: unknown[]): ArchitectToolResponse {
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
  priorMessages: [] as readonly ArchitectMessage[],
  task: "chat" as const,
  provider: "anthropic" as const,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("runPass: text-only turn calls ports in canonical order and stops on no tool calls", async () => {
  const built = buildPorts({ providerScript: [toolResp("hello world")] });
  const result = await runPass({ ...baseRunInput, userIntent: intent("hi"), ports: built.ports });

  assert.equal(result.stopReason, "complete");
  assert.equal(result.iterations.length, 1);
  assert.equal(result.assistantMessage.content, "hello world");
  assert.equal(result.toolInvocations.length, 0);
  assert.deepEqual(built.context.calls, [{ commandSource: "chat", intentText: "hi" }]);
  // user persisted before clearAfterDispatch, both before provider
  const userIdx = built.memory.events.findIndex((e) => e.kind === "user");
  const assistantIdx = built.memory.events.findIndex((e) => e.kind === "assistant");
  assert.ok(userIdx < assistantIdx, "user persisted before assistant");
  assert.equal(built.attachments.clearedTimes, 1);
  assert.equal(built.autonomy.completed.length, 1);
  assert.equal(built.autonomy.completed[0].toolInvocations, 0);
});

test("runPass: forwards content blocks to composer when attachments present", async () => {
  const blocks = [{ type: "text", text: "hi" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }];
  const att = new FakeAttachments(blocks, [], "1 image attached");
  const built = buildPorts({ providerScript: [toolResp("ok")], attachments: att });

  const result = await runPass({ ...baseRunInput, userIntent: intent("look"), ports: built.ports });

  assert.deepEqual(built.composer.lastInput?.userIntent.contentBlocks, blocks);
  assert.match(built.composer.lastInput?.additionalInstructions ?? "", /1 image attached/);
  assert.equal(result.droppedAttachments.length, 0);
});

test("runPass: surfaces dropped attachments without posting them itself", async () => {
  const att = new FakeAttachments(undefined, ["screenshot.png", "diagram.png"], "");
  const built = buildPorts({
    providerScript: [toolResp("text-only reply")],
    attachments: att,
    capabilities: { textAttachments: true, imageAttachments: false },
  });

  const result = await runPass({ ...baseRunInput, userIntent: intent("see this"), ports: built.ports });

  assert.deepEqual(result.droppedAttachments, ["screenshot.png", "diagram.png"]);
});

test("runPass: clears attachments exactly once, after persistence and before provider", async () => {
  const att = new FakeAttachments();
  const built = buildPorts({ providerScript: [toolResp("ok")], attachments: att });
  await runPass({ ...baseRunInput, userIntent: intent("hi"), ports: built.ports });

  assert.equal(att.clearedTimes, 1);
  assert.equal(built.provider.calls.length, 1);
});

test("runPass: runs the inner agentic loop across many tool batches in service of one pass", async () => {
  // Three iterations: tools → tools → final text. Demonstrates "tens of
  // consecutive tool calls per pass" pattern; iteration history grows.
  const callA: ToolUseRequest = { id: "t1", name: "search", input: { q: "x" } };
  const callB: ToolUseRequest = { id: "t2", name: "read_file", input: { path: "a.ts" } };
  const callC: ToolUseRequest = { id: "t3", name: "edit", input: { path: "a.ts" } };
  const built = buildPorts({
    providerScript: [
      toolResp("planning…", [callA, callB]),
      toolResp("editing…", [callC]),
      toolResp("done."),
    ],
  });

  const result = await runPass({ ...baseRunInput, userIntent: intent("refactor"), ports: built.ports });

  assert.equal(result.stopReason, "complete");
  assert.equal(result.iterations.length, 3);
  assert.equal(result.toolInvocations.length, 3);
  assert.deepEqual(
    result.toolInvocations.map((r) => r.call.name),
    ["search", "read_file", "edit"],
  );
  // Provider sees growing iteration history per call
  assert.equal(built.provider.calls[0].iterationHistory.length, 0);
  assert.equal(built.provider.calls[1].iterationHistory.length, 1);
  assert.equal(built.provider.calls[2].iterationHistory.length, 2);
  assert.equal(result.assistantMessage.content, "planning…editing…done.");
  // Single autonomy notification with cumulative tool count
  assert.equal(built.autonomy.completed.length, 1);
  assert.equal(built.autonomy.completed[0].toolInvocations, 3);
});

test("runPass: stops at maxIterations cap when provider keeps requesting tools", async () => {
  const call: ToolUseRequest = { id: "t", name: "loop", input: {} };
  const built = buildPorts({
    providerScript: [toolResp("a", [call]), toolResp("b", [call]), toolResp("c", [call])],
  });

  const result = await runPass({
    ...baseRunInput,
    userIntent: intent("spin"),
    ports: built.ports,
    maxIterations: 2,
  });

  assert.equal(result.stopReason, "max-iterations");
  assert.equal(result.iterations.length, 2);
  assert.equal(result.toolInvocations.length, 2);
});

test("runPass: surfaces provider error as 'error' stop reason without throwing", async () => {
  const built = buildPorts({ providerScript: [new Error("boom")] });

  const result = await runPass({ ...baseRunInput, userIntent: intent("hi"), ports: built.ports });

  assert.equal(result.stopReason, "error");
  assert.match(result.assistantMessage.content, /boom/);
  assert.equal(built.autonomy.completed.length, 1, "autonomy still notified on error");
  assert.equal(built.memory.events.filter((e) => e.kind === "assistant").length, 1);
});

test("runPass: aborts mid-loop when abortSignal fires before next iteration", async () => {
  const call: ToolUseRequest = { id: "t", name: "noop", input: {} };
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

  const result = await runPass({
    ...baseRunInput,
    userIntent: intent("go"),
    ports: built.ports,
    abortSignal: controller.signal,
  });

  assert.equal(result.stopReason, "aborted");
  assert.equal(built.provider.calls.length, 1, "no second provider call after abort");
});

test("runPass: frames pass goal and task goal into composer additionalInstructions", async () => {
  const built = buildPorts({ providerScript: [toolResp("ok")] });
  await runPass({
    ...baseRunInput,
    userIntent: intent("work"),
    ports: built.ports,
    passGoal: { id: "p1", summary: "investigate auth flow", successCriteria: "found entry point" },
    taskGoal: { id: "T9", summary: "ship 2FA", completedPassGoals: [{ id: "p0", summary: "scope" }] },
  });

  const extras = built.composer.lastInput?.additionalInstructions ?? "";
  assert.match(extras, /Task goal \(id=T9\): ship 2FA/);
  assert.match(extras, /1 pass goal\(s\) already completed/);
  assert.match(extras, /Pass goal \(id=p1\): investigate auth flow/);
  assert.match(extras, /Success criteria: found entry point/);
  assert.match(extras, /coherent unit of progress/i);
  assert.match(extras, /cognitive continuity/i);
  assert.match(extras, /meaningful state transition/i);
});

test("runPass: propagates final iteration's providerRawAssistant unchanged to memory", async () => {
  const raw = [{ type: "reasoning", id: "r1" }, { type: "message", id: "m1" }];
  const built = buildPorts({
    providerScript: [toolResp("plan", [{ id: "t", name: "tool", input: {} }]), toolResp("final", [], raw)],
  });

  const result = await runPass({ ...baseRunInput, userIntent: intent("go"), ports: built.ports });

  assert.deepEqual(result.providerRawAssistant, raw);
  const assistantEvent = built.memory.events.find((e) => e.kind === "assistant") as
    | { payload: { providerRawAssistant?: unknown } }
    | undefined;
  assert.deepEqual(assistantEvent?.payload.providerRawAssistant, raw);
});
