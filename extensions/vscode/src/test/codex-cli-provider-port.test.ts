// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Codex CLI adapter - Slice 4 ProviderPort tests.

import test from "node:test";
import assert from "node:assert/strict";

import {
  CODEX_AUTHORITATIVE_TOOL_CATALOG,
  CODEX_MINIMUM_AUTHORITATIVE_TOOLS,
  createCodexCliProviderPort,
  type CodexCliClockPort,
  type CodexCliCommandResult,
  type CodexCliCryptoPort,
  type CodexCliDeps,
  type CodexCliFsPort,
  type CodexCliMcpAuditPort,
  type CodexCliProcessPort,
  type CodexCliProviderPortOptions,
  type CodexCliRegistryPort,
  type RecordedMcpToolCall,
  type CodexCliResolveResult,
  type CodexCliSpawnInput,
  type CodexCliSpawnResult,
} from "../architect-core/adapters/codex-cli/index.js";
import type { ArchitectLlm, ArchitectMessage } from "../architect-llm.js";
import type { CallProviderInput } from "../architect-core/ports.js";

const ROOT_HELP = `
Codex CLI

Usage: codex [OPTIONS] [COMMAND]

Commands:
  exec    Run Codex non-interactively
  login   Manage login
  mcp     Manage MCP servers

Options:
  -a, --ask-for-approval <APPROVAL_POLICY>
                                             Possible values:
                                             - on-request: ask when needed
                                             - never: never ask
`;

const EXEC_HELP = `
Usage: codex exec [OPTIONS] [PROMPT]

Arguments:
  [PROMPT]  Prompt text. Use - to read the prompt from stdin.

Options:
      --json
  -m, --model <MODEL>
  -C, --cd <DIR>
  -s, --sandbox <SANDBOX_MODE>
                                             [possible values: read-only, workspace-write, danger-full-access]
  -a, --ask-for-approval <APPROVAL_POLICY>
                                             Possible values:
                                             - on-request: ask when needed
                                             - never: never ask
  -c, --config <KEY=VALUE>
  -p, --profile <PROFILE>
      --add-dir <DIR>
  -o, --output-last-message <PATH>
      --output-schema <PATH>
      --skip-git-repo-check
      --ignore-user-config
      --ignore-rules
      --ephemeral
`;

interface FakeProcessOptions {
  readonly resolve?: CodexCliResolveResult | null;
  readonly spawnResult?: Partial<CodexCliSpawnResult>;
  readonly stdoutChunks?: readonly string[];
  readonly stderrChunks?: readonly string[];
}

interface FakeProcessLog {
  readonly spawnCalls: CodexCliSpawnInput[];
}

function commandResult(over: Partial<CodexCliCommandResult> = {}): CodexCliCommandResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    signal: null,
    durationMs: 10,
    timedOut: false,
    aborted: false,
    ...over,
  };
}

function makeFakeFs(): CodexCliFsPort {
  let counter = 0;
  return {
    async mkdtemp(prefix) {
      counter += 1;
      return `C:\\Temp\\${prefix}${counter}`;
    },
    async mkdir() {},
    async writeFile() {},
    async readFileUtf8() {
      return null;
    },
    async rmRecursive() {},
    async copyDirRecursive() {
      return true;
    },
    homeDir() {
      return "C:\\Users\\tester";
    },
    joinPath(...segments) {
      return segments.join("\\");
    },
  };
}

function spawnResult(over: Partial<CodexCliSpawnResult> = {}): CodexCliSpawnResult {
  return {
    stdout: "Slice 4 complete.\n",
    stderr: "",
    exitCode: 0,
    signal: null,
    durationMs: 250,
    timeoutKind: null,
    timedOut: false,
    aborted: false,
    ...over,
  };
}

function makeFakeProcess(opts: FakeProcessOptions = {}): {
  readonly process: CodexCliProcessPort;
  readonly log: FakeProcessLog;
} {
  const log: FakeProcessLog = { spawnCalls: [] };
  const process: CodexCliProcessPort = {
    async resolveExecutable(name) {
      if (opts.resolve === undefined) {
        return { executablePath: `C:\\bin\\${name}.cmd`, versionString: "codex-cli 0.130.0" };
      }
      return opts.resolve;
    },
    async runRootHelp() {
      return commandResult({ stdout: ROOT_HELP });
    },
    async runExecHelp() {
      return commandResult({ stdout: EXEC_HELP });
    },
    async runLoginStatus() {
      return commandResult({ stderr: "Logged in using ChatGPT\n" });
    },
    async spawn(input) {
      log.spawnCalls.push(input);
      for (const chunk of opts.stdoutChunks ?? []) {
        input.onStdoutChunk?.(chunk);
      }
      for (const chunk of opts.stderrChunks ?? []) {
        input.onStderrChunk?.(chunk);
      }
      return spawnResult(opts.spawnResult);
    },
  };
  return { process, log };
}

function makeFakeCrypto(): CodexCliCryptoPort {
  return {
    randomToken() {
      return "tok-codex";
    },
    randomRunId() {
      return "codex-run-provider";
    },
  };
}

function makeFakeClock(): CodexCliClockPort {
  let now = 1_800_000_000_000;
  return {
    nowMs() {
      const current = now;
      now += 50;
      return current;
    },
  };
}

function makeFakeRegistry(liveTools: readonly string[] = CODEX_AUTHORITATIVE_TOOL_CATALOG): CodexCliRegistryPort {
  return {
    async listAuthoritativeToolNames() {
      return liveTools;
    },
    async describeBridgeSpawn() {
      return { command: "node", args: ["./codex-cli-bridge.js"], env: { DEBUG: "dreamgraph:codex" } };
    },
  };
}

function makeFakeAudit(): CodexCliMcpAuditPort {
  return {
    async startRecording() {},
    async finishRecording() {
      return [];
    },
  };
}

function makeDeps(over: Partial<CodexCliDeps> = {}): CodexCliDeps {
  return {
    fs: over.fs ?? makeFakeFs(),
    process: over.process ?? makeFakeProcess().process,
    crypto: over.crypto ?? makeFakeCrypto(),
    clock: over.clock ?? makeFakeClock(),
    registry: over.registry ?? makeFakeRegistry(),
    mcpAudit: over.mcpAudit ?? makeFakeAudit(),
  };
}

const FAKE_LLM = { provider: "openai" } as unknown as ArchitectLlm;

function makeCallInput(over: Partial<CallProviderInput> = {}): CallProviderInput {
  const conversation: ArchitectMessage[] = [
    { role: "system", content: "you are an architect" },
    { role: "user", content: "design a queue" },
  ];
  return {
    prompt: { system: "you are an architect", conversation },
    tools: [],
    iterationHistory: [],
    ...over,
  };
}

test("codex provider-port: getCapabilities reports text and image attachments", () => {
  const port = createCodexCliProviderPort({
    hostLlm: FAKE_LLM,
    invocationCwd: "C:\\work",
    timeoutMs: 60_000,
    baseEnv: { PATH: "C:\\bin" },
    deps: makeDeps(),
  });
  assert.deepEqual(port.getCapabilities(), { textAttachments: true, imageAttachments: true });
  assert.equal(port.llm, FAKE_LLM);
});

test("codex provider-port: invocation cwd is optional for multi-repo DreamGraph runs", async () => {
  const proc = makeFakeProcess();
  const port = createCodexCliProviderPort({
    hostLlm: FAKE_LLM,
    timeoutMs: 30_000,
    baseEnv: { PATH: "C:\\bin" },
    deps: makeDeps({ process: proc.process }),
  });

  await port.callProvider(makeCallInput());

  assert.equal(proc.log.spawnCalls.length, 1);
  assert.match(proc.log.spawnCalls[0]!.cwd, /^C:\\Temp\\dreamgraph-codex-cli-run-/);
  assert.ok(proc.log.spawnCalls[0]!.args.includes("--cd"));
  assert.match(
    proc.log.spawnCalls[0]!.args[proc.log.spawnCalls[0]!.args.indexOf("--cd") + 1] ?? "",
    /^C:\\Temp\\dreamgraph-codex-cli-run-/,
  );
});

test("codex provider-port: serializes conversation to stdin and projects proposal", async () => {
  const proc = makeFakeProcess();
  const port = createCodexCliProviderPort({
    hostLlm: FAKE_LLM,
    invocationCwd: "C:\\work\\repo",
    timeoutMs: 30_000,
    idleTimeoutMs: 3_000,
    baseEnv: { PATH: "C:\\bin", FOO: "bar" },
    deps: makeDeps({ process: proc.process }),
    model: "gpt-5.5",
    profile: "dreamgraph",
  });

  const proposal = await port.callProvider(makeCallInput());

  assert.equal(proc.log.spawnCalls.length, 1);
  const spawn = proc.log.spawnCalls[0]!;
  assert.match(spawn.cwd, /^C:\\Temp\\dreamgraph-codex-cli-run-/);
  assert.equal(spawn.env.FOO, "bar");
  assert.match(spawn.env.CODEX_HOME, /dreamgraph-codex-cli-run-.*\\codex-home$/);
  assert.match(spawn.stdin, /\[system\]\nyou are an architect/);
  assert.match(spawn.stdin, /\[user\]\n===== CURRENT TURN[\s\S]*\ndesign a queue\n===== END CURRENT TURN =====/);
  assert.ok(spawn.args.includes("--model"));
  assert.ok(spawn.args.includes("gpt-5.5"));
  assert.ok(spawn.args.includes("--profile"));
  assert.equal(spawn.args[spawn.args.length - 1], "-");
  assert.equal(spawn.idleTimeoutMs, 3_000);
  assert.equal(proposal.toolCalls.length, 0);
  assert.equal(proposal.response.toolCalls.length, 0);
  assert.equal(proposal.response.stopReason, "end_turn");
  assert.equal(proposal.response.content, "Slice 4 complete.");
});

test("codex provider-port: advertises DreamGraph prompt policies and diagnostics", async () => {
  const proc = makeFakeProcess();
  const diagnostics: unknown[] = [];
  const port = createCodexCliProviderPort({
    hostLlm: FAKE_LLM,
    invocationCwd: "C:\\work\\repo",
    timeoutMs: 30_000,
    baseEnv: { PATH: "C:\\bin" },
    deps: makeDeps({ process: proc.process }),
    cliToolsManifest: {
      server: "dreamgraph",
      tools: CODEX_AUTHORITATIVE_TOOL_CATALOG,
    },
    onPromptComposed: (info) => diagnostics.push(info),
  });

  await port.callProvider(makeCallInput());

  const prompt = proc.log.spawnCalls[0]!.stdin;
  assert.match(prompt, /Available dreamgraph tools/);
  assert.match(prompt, /  - query_resource/);
  assert.match(prompt, /  - edit_entity/);
  assert.match(prompt, /  - run_command/);
  assert.match(prompt, /dreamgraph:run_command .*available.*ONLY supported shell execution route/);
  assert.match(prompt, /File\/entity mutations\s+-> prefer dreamgraph:edit_entity/);
  assert.match(prompt, /Verification \/ build \/ tests\s+-> dreamgraph:run_command/);
  assert.match(prompt, /Codex CLI adapter authority override/);
  assert.match(prompt, /ADR-aware task policy: for every repository task/);
  assert.match(prompt, /Graph sync policy: after any source or project-state mutation/);
  assert.match(prompt, /HARD DENIAL .* DO NOT EXIST in this Codex run .* cli:powershell, cli:bash, cli:cmd/);
  assert.ok(!proc.log.spawnCalls[0]!.args.includes("--image"));
  assert.equal(diagnostics.length, 1);
  assert.equal((diagnostics[0] as { mcpServerAdvertised: string }).mcpServerAdvertised, "dreamgraph");
  assert.ok((diagnostics[0] as { mcpToolsAdvertised: number }).mcpToolsAdvertised > CODEX_MINIMUM_AUTHORITATIVE_TOOLS.length);
});

test("codex provider-port: keeps bridge-local run_command visible with read-only upstream tools", async () => {
  const proc = makeFakeProcess();
  const port = createCodexCliProviderPort({
    hostLlm: FAKE_LLM,
    invocationCwd: "C:\\work\\repo",
    timeoutMs: 30_000,
    baseEnv: { PATH: "C:\\bin" },
    deps: makeDeps({
      process: proc.process,
      registry: makeFakeRegistry(CODEX_MINIMUM_AUTHORITATIVE_TOOLS),
    }),
    cliToolsManifest: {
      server: "dreamgraph",
      tools: CODEX_AUTHORITATIVE_TOOL_CATALOG,
    },
  });

  await port.callProvider(makeCallInput());

  const prompt = proc.log.spawnCalls[0]!.stdin;
  assert.match(prompt, /  - query_resource/);
  assert.match(prompt, /  - run_command/);
  assert.match(prompt, /dreamgraph:run_command .*available.*ONLY supported shell execution route/);
  assert.match(prompt, /Verification \/ build \/ tests\s+-> dreamgraph:run_command/);
});

test("codex provider-port: forwards assistant text through onStreamChunk", async () => {
  const port = createCodexCliProviderPort({
    hostLlm: FAKE_LLM,
    invocationCwd: "C:\\work",
    timeoutMs: 30_000,
    baseEnv: {},
    deps: makeDeps(),
  });
  const chunks: string[] = [];
  await port.callProvider(makeCallInput({ onStreamChunk: (chunk) => chunks.push(chunk) }));
  assert.deepEqual(chunks, ["Slice 4 complete."]);
});

test("codex provider-port: streams Codex assistant deltas live without duplicating final text", async () => {
  const stdout = [
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "response.output_text.delta", delta: "Graph" }),
    JSON.stringify({ type: "assistant.message_delta", deltaContent: " health" }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: "Graph health" },
    }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n");
  const proc = makeFakeProcess({
    stdoutChunks: [stdout.slice(0, 90), stdout.slice(90)],
    spawnResult: { stdout },
  });
  const port = createCodexCliProviderPort({
    hostLlm: FAKE_LLM,
    invocationCwd: "C:\\work",
    timeoutMs: 30_000,
    baseEnv: {},
    deps: makeDeps({ process: proc.process }),
  });
  const chunks: string[] = [];

  const proposal = await port.callProvider(makeCallInput({ onStreamChunk: (chunk) => chunks.push(chunk) }));

  assert.deepEqual(chunks, ["Graph", " health"]);
  assert.equal(proposal.response.content, "Graph health");
});

test("codex provider-port: streams completed assistant message when no deltas are available", async () => {
  const stdout = [
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: "Completed message." },
    }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n");
  const proc = makeFakeProcess({
    stdoutChunks: [stdout],
    spawnResult: { stdout },
  });
  const port = createCodexCliProviderPort({
    hostLlm: FAKE_LLM,
    invocationCwd: "C:\\work",
    timeoutMs: 30_000,
    baseEnv: {},
    deps: makeDeps({ process: proc.process }),
  });
  const chunks: string[] = [];

  const proposal = await port.callProvider(makeCallInput({ onStreamChunk: (chunk) => chunks.push(chunk) }));

  assert.deepEqual(chunks, ["Completed message."]);
  assert.equal(proposal.response.content, "Completed message.");
});

test("codex provider-port: provider errors carry deterministic metadata", async () => {
  const port = createCodexCliProviderPort({
    hostLlm: FAKE_LLM,
    invocationCwd: "C:\\work",
    timeoutMs: 30_000,
    baseEnv: {},
    deps: makeDeps({ process: makeFakeProcess({ resolve: null }).process }),
  });

  await assert.rejects(port.callProvider(makeCallInput()), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /CODEX_CLI_NOT_FOUND/);
    const tagged = err as Error & { codexCliFailureCode?: string; codexCliRunResult?: unknown };
    assert.equal(tagged.codexCliFailureCode, "CODEX_CLI_NOT_FOUND");
    assert.ok(tagged.codexCliRunResult);
    return true;
  });
});

test("codex provider-port: streams live audit calls before final run reconciliation", async () => {
  const observed: string[] = [];
  const liveCall: RecordedMcpToolCall = Object.freeze({
    server: "dreamgraph",
    tool: "query_resource",
    inputJson: "{\"uri\":\"system://overview\"}",
    resultJson: "{\"success\":true}",
    isError: false,
    durationMs: 12,
    startedAtEpochMs: 1_800_000_000_123,
  });
  const port = createCodexCliProviderPort({
    hostLlm: FAKE_LLM,
    invocationCwd: "C:\\work",
    timeoutMs: 30_000,
    baseEnv: {},
    deps: makeDeps(),
    auditLive: {
      async subscribe(runId, handler) {
        observed.push(`subscribe:${runId}`);
        handler(liveCall);
        return {
          async close() {
            observed.push("close");
          },
        };
      },
    },
    onToolCall: (runId, call) => observed.push(`tool:${runId}:${call.server}:${call.tool}`),
    onRunResult: (result) => observed.push(`result:${result.runId}:${result.ok}`),
  });

  await port.callProvider(makeCallInput());

  assert.deepEqual(observed, [
    "subscribe:codex-run-provider",
    "tool:codex-run-provider:dreamgraph:query_resource",
    "close",
    "result:codex-run-provider:true",
  ]);
});

test("codex provider-port: streams transcript MCP witnesses when audit records are absent", async () => {
  const observed: string[] = [];
  const stderr = "mcp_tool_call failed: dreamgraph.query_resource\n";
  const proc = makeFakeProcess({
    stderrChunks: [stderr],
    spawnResult: {
      stderr,
      exitCode: 1,
    },
  });
  const port = createCodexCliProviderPort({
    hostLlm: FAKE_LLM,
    invocationCwd: "C:\\work",
    timeoutMs: 30_000,
    baseEnv: {},
    deps: makeDeps({ process: proc.process }),
    onToolWitness: (runId, witness) =>
      observed.push(`witness:${runId}:${witness.server}:${witness.tool}:${witness.status}`),
    onRunResult: (result) =>
      observed.push(`result:${result.runId}:${result.ok}:${result.toolCallWitnesses.length}`),
  });

  await assert.rejects(port.callProvider(makeCallInput()));

  assert.deepEqual(observed, [
    "witness:codex-run-provider:dreamgraph:query_resource:failed",
    "result:codex-run-provider:false:1",
  ]);
});

test("codex provider-port: onRunResult fires for ok and failed runs", async () => {
  const results: boolean[] = [];
  const okPort = createCodexCliProviderPort({
    hostLlm: FAKE_LLM,
    invocationCwd: "C:\\work",
    timeoutMs: 30_000,
    baseEnv: {},
    deps: makeDeps(),
    onRunResult: (result) => results.push(result.ok),
  });
  await okPort.callProvider(makeCallInput());

  const failPort = createCodexCliProviderPort({
    hostLlm: FAKE_LLM,
    invocationCwd: "C:\\work",
    timeoutMs: 30_000,
    baseEnv: {},
    deps: makeDeps({ process: makeFakeProcess({ resolve: null }).process }),
    onRunResult: (result) => results.push(result.ok),
  });
  await assert.rejects(failPort.callProvider(makeCallInput()));
  assert.deepEqual(results, [true, false]);
});

test("codex provider-port: rejects missing or malformed options", () => {
  // @ts-expect-error testing invalid input
  assert.throws(() => createCodexCliProviderPort());
  assert.throws(() =>
    createCodexCliProviderPort({
      hostLlm: FAKE_LLM,
      // @ts-expect-error testing invalid input
      invocationCwd: 42,
      timeoutMs: 1,
      baseEnv: {},
      deps: makeDeps(),
    }),
  );
  assert.throws(() =>
    createCodexCliProviderPort({
      hostLlm: FAKE_LLM,
      invocationCwd: "C:\\work",
      timeoutMs: 0,
      baseEnv: {},
      deps: makeDeps(),
    }),
  );
  // @ts-expect-error missing hostLlm
  const missingHostLlm: CodexCliProviderPortOptions = {
    invocationCwd: "C:\\work",
    timeoutMs: 100,
    baseEnv: {},
    deps: makeDeps(),
  };
  assert.throws(() => createCodexCliProviderPort(missingHostLlm));
});
