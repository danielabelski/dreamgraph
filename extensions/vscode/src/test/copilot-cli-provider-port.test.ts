// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — Slice 4 ProviderPort tests.
//
// Drives `createCopilotCliProviderPort` against in-memory fakes for
// every effectful port. Verifies:
//   • prompt is serialized from the architect-core conversation
//   • model / cwd / timeout / baseEnv flow through to runCopilotCli
//   • abortSignal forwards to the spawn port
//   • successful runs project to a `ProviderProposal` with empty
//     `toolCalls` and the cleaned transcript text
//   • the assistant text is delivered through `onStreamChunk`
//   • orchestrator failures throw an annotated Error
//   • `onRunResult` fires for both ok and failed runs
//   • observer exceptions never crash the pass driver
//   • `getCapabilities` returns text-only / image-disabled
//   • `port.llm` is the injected reference
//   • options validation rejects missing / malformed inputs

import test from "node:test";
import assert from "node:assert/strict";

import {
  COPILOT_AUTHORITATIVE_TOOL_CATALOG,
  COPILOT_MINIMUM_AUTHORITATIVE_TOOLS,
  createCopilotCliProviderPort,
  type CopilotCliClockPort,
  type CopilotCliCryptoPort,
  type CopilotCliDeps,
  type CopilotCliFsPort,
  type CopilotCliMcpAuditPort,
  type CopilotCliProcessPort,
  type CopilotCliProviderPortOptions,
  type CopilotCliRegistryPort,
  type CopilotCliResolveResult,
  type CopilotCliSpawnInput,
  type CopilotCliSpawnResult,
} from "../architect-core/adapters/copilot-cli/index.js";
import type { ArchitectLlm, ArchitectMessage } from "../architect-llm.js";
import type { CallProviderInput } from "../architect-core/ports.js";

const FULL_HELP = `
Usage: copilot [options]

Options:
  -p, --prompt <text>            The prompt to send
      --model <model>            Model identifier
      --allow-tool <spec>        Permit a tool
      --deny-tool <spec>         Forbid a tool
      --available-tools <list>   Restrict the visible tool set
      --allow-all-tools          Permit every tool (DANGEROUS)
      --disallow-temp-dir        Refuse to create temporary directories
      --additional-mcp-config <json>  Augment ~/.copilot/mcp-config.json
`;

/** JSON the fake fs returns for the synthetic Copilot config so the login check passes. */
const LOGGED_IN_CONFIG_JSON = JSON.stringify({
  loggedInUsers: [{ host: "https://github.com", login: "tester" }],
});

interface FakeProcessOptions {
  readonly resolve?: CopilotCliResolveResult | null;
  readonly spawnResult?: Partial<CopilotCliSpawnResult>;
}

function makeFakeFs(): CopilotCliFsPort {
  let counter = 0;
  return {
    async mkdtemp(prefix) {
      return `/tmp/${prefix}${++counter}`;
    },
    async mkdir() {},
    async writeFile() {},
    async rmRecursive() {},
    async copyDirRecursive() {},
    async readFileUtf8(path) {
      // Pretend the persistent Copilot config records a logged-in user
      // so the orchestrator's pre-spawn login check passes. Anything
      // else is reported absent.
      if (path.endsWith("/.copilot/config.json")) return LOGGED_IN_CONFIG_JSON;
      return null;
    },
    homeDir() {
      return "/home/user";
    },
    joinPath(...segments) {
      return segments.join("/");
    },
  };
}

interface FakeProcessLog {
  spawnCalls: CopilotCliSpawnInput[];
}

function makeFakeProcess(opts: FakeProcessOptions = {}): {
  port: CopilotCliProcessPort;
  log: FakeProcessLog;
} {
  const log: FakeProcessLog = { spawnCalls: [] };
  const port: CopilotCliProcessPort = {
    async resolveExecutable(name) {
      if (opts.resolve === undefined) {
        return { executablePath: `/usr/local/bin/${name}`, versionString: "copilot 1.4.2" };
      }
      return opts.resolve;
    },
    async runHelp() {
      return { helpText: FULL_HELP, versionString: "copilot 1.4.2" };
    },
    async spawn(input) {
      log.spawnCalls.push(input);
      return {
        stdout: "Plan complete.\n",
        stderr: "",
        exitCode: 0,
        signal: null,
        durationMs: 250,
        timedOut: false,
        aborted: false,
        ...opts.spawnResult,
      };
    },
  };
  return { port, log };
}

function makeFakeCrypto(): CopilotCliCryptoPort {
  return {
    randomToken() {
      return "tok-deadbeef";
    },
    randomRunId() {
      return "run-fixture-001";
    },
  };
}

function makeFakeClock(): CopilotCliClockPort {
  let t = 1_700_000_000_000;
  return {
    nowMs() {
      const v = t;
      t += 50;
      return v;
    },
  };
}

function makeFakeRegistry(liveTools: readonly string[] = COPILOT_AUTHORITATIVE_TOOL_CATALOG): CopilotCliRegistryPort {
  return {
    async listAuthoritativeToolNames() {
      return [...liveTools];
    },
    async describeBridgeSpawn() {
      return { command: "node", args: ["./mcp-bridge.js"], env: {} };
    },
  };
}

function makeFakeAudit(): CopilotCliMcpAuditPort {
  return {
    async startRecording() {},
    async finishRecording() {
      return [];
    },
  };
}

function makeDeps(over: Partial<CopilotCliDeps> = {}): CopilotCliDeps {
  return {
    fs: over.fs ?? makeFakeFs(),
    process: over.process ?? makeFakeProcess().port,
    crypto: over.crypto ?? makeFakeCrypto(),
    clock: over.clock ?? makeFakeClock(),
    registry: over.registry ?? makeFakeRegistry(),
    mcpAudit: over.mcpAudit ?? makeFakeAudit(),
  };
}

const FAKE_LLM = { provider: "anthropic" } as unknown as ArchitectLlm;

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

// ---------------------------------------------------------------------------

test("provider-port: getCapabilities reports text-only / images-disabled", () => {
  const port = createCopilotCliProviderPort({
    hostLlm: FAKE_LLM,
    invocationCwd: "/work",
    timeoutMs: 60_000,
    baseEnv: { PATH: "/usr/bin" },
    deps: makeDeps(),
  });
  const caps = port.getCapabilities();
  assert.equal(caps.textAttachments, false);
  assert.equal(caps.imageAttachments, false);
});

test("provider-port: exposes hostLlm reference verbatim through `llm`", () => {
  const port = createCopilotCliProviderPort({
    hostLlm: FAKE_LLM,
    invocationCwd: "/work",
    timeoutMs: 60_000,
    baseEnv: {},
    deps: makeDeps(),
  });
  assert.equal(port.llm, FAKE_LLM);
});

test("provider-port: callProvider serializes the conversation into --prompt", async () => {
  const proc = makeFakeProcess();
  const port = createCopilotCliProviderPort({
    hostLlm: FAKE_LLM,
    invocationCwd: "/work/run",
    timeoutMs: 30_000,
    baseEnv: { PATH: "/usr/bin", FOO: "bar" },
    deps: makeDeps({ process: proc.port }),
    model: "claude-sonnet-4.5",
  });

  const proposal = await port.callProvider(makeCallInput());

  assert.equal(proc.log.spawnCalls.length, 1);
  const spawn = proc.log.spawnCalls[0]!;
  // Prompt argv contains the serialized conversation including both
  // role headers and the system text.
  const promptArgIdx = spawn.args.findIndex((a) => a === "--prompt");
  assert.ok(promptArgIdx >= 0);
  const promptValue = spawn.args[promptArgIdx + 1]!;
  assert.match(promptValue, /\[system\]\nyou are an architect/);
  // Provider-port defaults `markCurrentTurn=true`; the final user turn
  // is wrapped with the CURRENT TURN markers so the single-shot CLI
  // model can identify the active request even when prior turns are
  // also in the file.
  assert.match(promptValue, /\[user\]\n===== CURRENT TURN[\s\S]*\ndesign a queue\n===== END CURRENT TURN =====/);
  // Model flag forwarded.
  assert.ok(spawn.args.includes("--model"));
  assert.ok(spawn.args.includes("claude-sonnet-4.5"));
  // Cwd forwarded.
  assert.equal(spawn.cwd, "/work/run");
  // baseEnv flows through; the orchestrator pins COPILOT_HOME to a
  // per-run isolated copy of the user's source HOME so the per-run
  // `mcp-config.json` it writes there is the only manifest the CLI
  // sees while the persistent GitHub auth is preserved verbatim.
  assert.equal(spawn.env["FOO"], "bar");
  assert.match(spawn.env["COPILOT_HOME"]!, /dreamgraph-copilot-cli-run-.*\/copilot-home$/);

  // Proposal projection.
  assert.equal(proposal.toolCalls.length, 0);
  assert.equal(proposal.response.stopReason, "end_turn");
  assert.equal(proposal.response.content, "Plan complete.");
  assert.equal(proposal.response.toolCalls.length, 0);
});

test("provider-port: advertises the live authoritative tool catalog to Copilot CLI", async () => {
  const proc = makeFakeProcess();
  const port = createCopilotCliProviderPort({
    hostLlm: FAKE_LLM,
    invocationCwd: "/work/run",
    timeoutMs: 30_000,
    baseEnv: { PATH: "/usr/bin" },
    deps: makeDeps({ process: proc.port }),
    cliToolsManifest: {
      server: "dreamgraph",
      tools: COPILOT_AUTHORITATIVE_TOOL_CATALOG,
    },
  });

  await port.callProvider(makeCallInput());

  const spawn = proc.log.spawnCalls[0]!;
  const promptValue = spawn.args[spawn.args.findIndex((a) => a === "--prompt") + 1]!;
  assert.match(promptValue, /Available dreamgraph tools/);
  assert.match(promptValue, /  - query_resource/);
  assert.match(promptValue, /  - edit_entity/);
  assert.match(promptValue, /  - patch_markdown_chapter/);
  assert.match(promptValue, /  - run_command/);
  assert.doesNotMatch(promptValue, /cli:powershell .*available/);
  assert.match(promptValue, /dreamgraph:run_command .*available.*ONLY supported shell execution route/);
  assert.match(promptValue, /File\/entity mutations\s+→ prefer dreamgraph:edit_entity/);
  assert.match(promptValue, /Verification \/ build \/ tests\s+→ dreamgraph:run_command/);
  assert.match(promptValue, /Copilot CLI adapter authority override/);
  assert.match(promptValue, /ADR-aware task policy: for every repository task/);
  assert.match(promptValue, /Graph sync policy: after any source or project-state mutation/);
  assert.match(promptValue, /HARD DENIAL .* DO NOT EXIST in this run .* cli:powershell, cli:bash, cli:cmd/);
  assert.ok(!spawn.args.includes("powershell"));
  assert.ok(spawn.args.includes("dreamgraph(edit_entity)"));
  assert.ok(spawn.args.includes("dreamgraph(patch_markdown_chapter)"));
  assert.ok(spawn.args.includes("dreamgraph(run_command)"));
});

test("provider-port: keeps bridge-local run_command visible with read-only upstream tools", async () => {
  const proc = makeFakeProcess();
  const port = createCopilotCliProviderPort({
    hostLlm: FAKE_LLM,
    invocationCwd: "/work/run",
    timeoutMs: 30_000,
    baseEnv: { PATH: "/usr/bin" },
    deps: makeDeps({
      process: proc.port,
      registry: makeFakeRegistry(COPILOT_MINIMUM_AUTHORITATIVE_TOOLS),
    }),
    cliToolsManifest: {
      server: "dreamgraph",
      tools: COPILOT_AUTHORITATIVE_TOOL_CATALOG,
    },
  });

  await port.callProvider(makeCallInput());

  const spawn = proc.log.spawnCalls[0]!;
  const promptValue = spawn.args[spawn.args.findIndex((a) => a === "--prompt") + 1]!;
  assert.match(promptValue, /  - query_resource/);
  assert.match(promptValue, /  - run_command/);
  assert.doesNotMatch(promptValue, /cli:powershell .*available/);
  assert.match(promptValue, /dreamgraph:run_command .*available.*ONLY supported shell execution route/);
  assert.match(promptValue, /Verification \/ build \/ tests\s+→ dreamgraph:run_command/);
  assert.ok(!spawn.args.includes("powershell"));
  assert.ok(spawn.args.includes("dreamgraph(run_command)"));
});

test("provider-port: callProvider forwards onStreamChunk with full assistant text", async () => {
  const port = createCopilotCliProviderPort({
    hostLlm: FAKE_LLM,
    invocationCwd: "/work",
    timeoutMs: 30_000,
    baseEnv: {},
    deps: makeDeps(),
  });

  const chunks: string[] = [];
  await port.callProvider(makeCallInput({ onStreamChunk: (c) => chunks.push(c) }));

  assert.deepEqual(chunks, ["Plan complete."]);
});

test("provider-port: callProvider forwards abortSignal to the spawn port", async () => {
  const proc = makeFakeProcess();
  const port = createCopilotCliProviderPort({
    hostLlm: FAKE_LLM,
    invocationCwd: "/work",
    timeoutMs: 30_000,
    baseEnv: {},
    deps: makeDeps({ process: proc.port }),
  });
  const ac = new AbortController();
  await port.callProvider(makeCallInput({ abortSignal: ac.signal }));
  // The provider-port wraps the external signal in an internal
  // controller so it can additionally abort on dreamgraph-MCP-failed
  // events. Reference equality no longer holds; assert propagation
  // instead: aborting the external signal must abort the forwarded
  // one.
  const forwarded = proc.log.spawnCalls[0]!.abortSignal as AbortSignal | undefined;
  assert.ok(forwarded instanceof AbortSignal, "spawn port received an AbortSignal");
  assert.equal(forwarded!.aborted, false);
  ac.abort();
  assert.equal(forwarded!.aborted, true);
});

test("provider-port: callProvider throws annotated Error when orchestrator returns ok=false", async () => {
  const port = createCopilotCliProviderPort({
    hostLlm: FAKE_LLM,
    invocationCwd: "/work",
    timeoutMs: 30_000,
    baseEnv: {},
    // No `copilot` binary on PATH → orchestrator returns COPILOT_CLI_NOT_FOUND.
    deps: makeDeps({ process: makeFakeProcess({ resolve: null }).port }),
  });
  await assert.rejects(port.callProvider(makeCallInput()), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /COPILOT_CLI_NOT_FOUND/);
    const tagged = err as Error & { copilotCliFailureCode?: string };
    assert.equal(tagged.copilotCliFailureCode, "COPILOT_CLI_NOT_FOUND");
    return true;
  });
});

test("provider-port: onRunResult fires for both ok and failed runs", async () => {
  const okResults: number[] = [];
  const okPort = createCopilotCliProviderPort({
    hostLlm: FAKE_LLM,
    invocationCwd: "/work",
    timeoutMs: 30_000,
    baseEnv: {},
    deps: makeDeps(),
    onRunResult: (r) => okResults.push(r.ok ? 1 : 0),
  });
  await okPort.callProvider(makeCallInput());
  assert.deepEqual(okResults, [1]);

  const failResults: number[] = [];
  const failPort = createCopilotCliProviderPort({
    hostLlm: FAKE_LLM,
    invocationCwd: "/work",
    timeoutMs: 30_000,
    baseEnv: {},
    deps: makeDeps({ process: makeFakeProcess({ resolve: null }).port }),
    onRunResult: (r) => failResults.push(r.ok ? 1 : 0),
  });
  await assert.rejects(failPort.callProvider(makeCallInput()));
  assert.deepEqual(failResults, [0]);
});

test("provider-port: onRunResult exceptions are swallowed", async () => {
  const port = createCopilotCliProviderPort({
    hostLlm: FAKE_LLM,
    invocationCwd: "/work",
    timeoutMs: 30_000,
    baseEnv: {},
    deps: makeDeps(),
    onRunResult: () => {
      throw new Error("observer blew up");
    },
  });
  const proposal = await port.callProvider(makeCallInput());
  assert.equal(proposal.response.content, "Plan complete.");
});

test("provider-port: rejects missing or malformed options", () => {
  // @ts-expect-error testing invalid input
  assert.throws(() => createCopilotCliProviderPort());
  assert.throws(() =>
    createCopilotCliProviderPort({
      hostLlm: FAKE_LLM,
      invocationCwd: "",
      timeoutMs: 1,
      baseEnv: {},
      deps: makeDeps(),
    }),
  );
  assert.throws(() =>
    createCopilotCliProviderPort({
      hostLlm: FAKE_LLM,
      invocationCwd: "/x",
      timeoutMs: 0,
      baseEnv: {},
      deps: makeDeps(),
    }),
  );
  assert.throws(() =>
    createCopilotCliProviderPort({
      hostLlm: FAKE_LLM,
      invocationCwd: "/x",
      timeoutMs: Number.POSITIVE_INFINITY,
      baseEnv: {},
      deps: makeDeps(),
    }),
  );
  // @ts-expect-error missing hostLlm
  const missingHostLlm: CopilotCliProviderPortOptions = {
    invocationCwd: "/x",
    timeoutMs: 100,
    baseEnv: {},
    deps: makeDeps(),
  };
  assert.throws(() => createCopilotCliProviderPort(missingHostLlm));
});
