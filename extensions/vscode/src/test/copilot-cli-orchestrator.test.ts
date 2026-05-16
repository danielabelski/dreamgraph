// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — Slice 2 orchestrator tests.
//
// Drives `runCopilotCli` end-to-end using in-memory fakes for every
// IO port. Covers the happy path, every pre-spawn rejection, every
// post-spawn failure mode, and the cleanup invariants.

import test from "node:test";
import assert from "node:assert/strict";

import {
  COPILOT_REQUIRED_AUTHORITATIVE_TOOLS,
  DREAMGRAPH_AUTHORITATIVE_SERVER_NAME,
  normalizeCopilotTranscript,
  runCopilotCli,
  type CopilotCliClockPort,
  type CopilotCliCryptoPort,
  type CopilotCliDeps,
  type CopilotCliFsPort,
  type CopilotCliMcpAuditPort,
  type CopilotCliProcessPort,
  type CopilotCliRegistryPort,
  type CopilotCliResolveResult,
  type CopilotCliRunInput,
  type CopilotCliSpawnInput,
  type CopilotCliSpawnResult,
  type RecordedMcpToolCall,
} from "../architect-core/adapters/copilot-cli/index.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

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

/** Fake user home dir surfaced to the orchestrator's login check. */
const FAKE_HOME_DIR = "/home/user";
/** JSON the fake fs returns for `<homeDir>/.copilot/config.json` to satisfy login. */
const LOGGED_IN_CONFIG_JSON = JSON.stringify({
  loggedInUsers: [{ host: "https://github.com", login: "tester" }],
});

interface FakeFsLog {
  mkdtemp: string[];
  mkdir: Array<{ path: string; mode?: number; recursive?: boolean }>;
  writes: Array<{ path: string; contents: string; mode?: number }>;
  rmRecursive: string[];
  reads: string[];
  copyDir: Array<{ src: string; dst: string; excludeNames?: readonly string[] }>;
}

interface FakeFsOptions {
  /**
   * Override what `readFileUtf8` returns for any path. By default the
   * fake serves `LOGGED_IN_CONFIG_JSON` for `<FAKE_HOME_DIR>/.copilot/config.json`
   * and `null` for everything else, so existing tests transparently
   * pass the orchestrator's pre-spawn login check.
   */
  readonly readFiles?: Readonly<Record<string, string | null>>;
  /** Override the home dir reported by the fs port. */
  readonly homeDir?: string;
}

function makeFakeFs(opts: FakeFsOptions = {}): { fs: CopilotCliFsPort; log: FakeFsLog } {
  const log: FakeFsLog = {
    mkdtemp: [],
    mkdir: [],
    writes: [],
    rmRecursive: [],
    reads: [],
    copyDir: [],
  };
  let counter = 0;
  const homeDir = opts.homeDir ?? FAKE_HOME_DIR;
  // Default read map satisfies the orchestrator's pre-spawn login
  // check. Tests that need to simulate "no login" pass an explicit
  // (possibly empty) `readFiles` map; passing `readFiles` at all
  // disables the default so callers can model a fresh-install state.
  const reads: Record<string, string | null> =
    opts.readFiles !== undefined
      ? { ...opts.readFiles }
      : { [`${homeDir}/.copilot/config.json`]: LOGGED_IN_CONFIG_JSON };
  const fs: CopilotCliFsPort = {
    async mkdtemp(prefix) {
      const path = `/tmp/${prefix}${++counter}`;
      log.mkdtemp.push(path);
      return path;
    },
    async mkdir(path, opts) {
      log.mkdir.push({ path, mode: opts?.mode, recursive: opts?.recursive });
    },
    async writeFile(path, contents, opts) {
      log.writes.push({ path, contents, mode: opts?.mode });
    },
    async rmRecursive(path) {
      log.rmRecursive.push(path);
    },
    async copyDirRecursive(src, dst, opts) {
      log.copyDir.push({ src, dst, excludeNames: opts?.excludeNames });
    },
    async readFileUtf8(path) {
      log.reads.push(path);
      return Object.prototype.hasOwnProperty.call(reads, path) ? reads[path]! : null;
    },
    homeDir() {
      return homeDir;
    },
    joinPath(...segments) {
      return segments.join("/");
    },
  };
  return { fs, log };
}

interface FakeProcessOptions {
  readonly resolve?: CopilotCliResolveResult | null;
  readonly helpText?: string;
  readonly spawnResult?: Partial<CopilotCliSpawnResult>;
  readonly spawnThrows?: Error;
}

interface FakeProcessLog {
  resolveCalls: string[];
  helpCalls: number;
  spawnCalls: CopilotCliSpawnInput[];
}

function makeFakeProcess(opts: FakeProcessOptions = {}): {
  process: CopilotCliProcessPort;
  log: FakeProcessLog;
} {
  const log: FakeProcessLog = {
    resolveCalls: [],
    helpCalls: 0,
    spawnCalls: [],
  };
  const process: CopilotCliProcessPort = {
    async resolveExecutable(name) {
      log.resolveCalls.push(name);
      if (opts.resolve === undefined) {
        return { executablePath: `/usr/local/bin/${name}`, versionString: "copilot 1.4.2" };
      }
      return opts.resolve;
    },
    async runHelp(_input) {
      log.helpCalls += 1;
      return {
        helpText: opts.helpText ?? FULL_HELP,
        versionString: "copilot 1.4.2",
      };
    },
    async spawn(input) {
      log.spawnCalls.push(input);
      if (opts.spawnThrows) throw opts.spawnThrows;
      return {
        stdout: "Plan looks good.\n",
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
  return { process, log };
}

function makeFakeCrypto(): CopilotCliCryptoPort {
  return {
    randomToken(_n) {
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
      const now = t;
      t += 50;
      return now;
    },
  };
}

interface FakeRegistryOptions {
  readonly liveTools?: readonly string[];
}

function makeFakeRegistry(opts: FakeRegistryOptions = {}): CopilotCliRegistryPort {
  return {
    async listAuthoritativeToolNames() {
      return opts.liveTools ?? [...COPILOT_REQUIRED_AUTHORITATIVE_TOOLS];
    },
    async describeBridgeSpawn() {
      return {
        command: "node",
        args: ["./mcp-bridge.js"],
        env: { DEBUG: "dreamgraph:bridge" },
      };
    },
  };
}

interface FakeAuditLog {
  starts: string[];
  finishes: string[];
}

function makeFakeAudit(recorded: readonly RecordedMcpToolCall[] = []): {
  port: CopilotCliMcpAuditPort;
  log: FakeAuditLog;
} {
  const log: FakeAuditLog = { starts: [], finishes: [] };
  let drained = false;
  const port: CopilotCliMcpAuditPort = {
    async startRecording(runId) {
      log.starts.push(runId);
    },
    async finishRecording(runId) {
      log.finishes.push(runId);
      if (drained) return [];
      drained = true;
      return recorded;
    },
  };
  return { port, log };
}

function defaultInput(over: Partial<CopilotCliRunInput> = {}): CopilotCliRunInput {
  return {
    prompt: "Plan a refactor.",
    model: "claude-sonnet-4.5",
    invocationCwd: "/work/run",
    timeoutMs: 60_000,
    baseEnv: { PATH: "/usr/bin", HOME: "/home/user" },
    ...over,
  };
}

function makeDeps(over: Partial<CopilotCliDeps> = {}): CopilotCliDeps {
  return {
    fs: over.fs ?? makeFakeFs().fs,
    process: over.process ?? makeFakeProcess().process,
    crypto: over.crypto ?? makeFakeCrypto(),
    clock: over.clock ?? makeFakeClock(),
    registry: over.registry ?? makeFakeRegistry(),
    mcpAudit: over.mcpAudit ?? makeFakeAudit().port,
  };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test("orchestrator: happy path runs all six steps and returns ok=true", async () => {
  const { fs, log: fsLog } = makeFakeFs();
  const { process, log: procLog } = makeFakeProcess();
  const recorded: RecordedMcpToolCall[] = [
    {
      server: "dreamgraph",
      tool: "query_resource",
      inputJson: '{"uri":"system://overview"}',
      resultJson: '{"ok":true}',
      isError: false,
      durationMs: 12,
      startedAtEpochMs: 1_700_000_000_100,
    },
    {
      server: "dreamgraph",
      tool: "edit_file", // not allowlisted
      inputJson: "{}",
      resultJson: "{}",
      isError: true,
      durationMs: 3,
      startedAtEpochMs: 1_700_000_000_200,
    },
    {
      server: "<inline>",
      tool: "shell",
      inputJson: '{"cmd":"ls"}',
      resultJson: '{"denied":true}',
      isError: true,
      durationMs: 1,
      startedAtEpochMs: 1_700_000_000_210,
    },
    {
      server: "github",
      tool: "search_issues",
      inputJson: '{"q":"x"}',
      resultJson: "[]",
      isError: false,
      durationMs: 30,
      startedAtEpochMs: 1_700_000_000_220,
    },
  ];
  const { port: mcpAudit, log: auditLog } = makeFakeAudit(recorded);

  const result = await runCopilotCli(
    defaultInput(),
    makeDeps({ fs, process, mcpAudit }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.failure, undefined);
  assert.equal(result.provider, "copilot-cli");
  assert.equal(result.runId, "run-fixture-001");
  assert.ok(result.totalDurationMs >= 0);

  // Step 1: resolve + help probe.
  assert.deepEqual(procLog.resolveCalls, ["copilot"]);
  assert.equal(procLog.helpCalls, 1);
  assert.ok(result.helpSurface?.required.prompt);

  // Step 3: scratch dir materialized with structured layout. The
  // adapter follows the LARGE PAYLOAD ISOLATION RULE — argv stays
  // tiny and all semantic payloads (MCP manifest, prompt,
  // authority policy, request manifest) are written to a per-run
  // directory whose `copilot-home/` subdir becomes the spawned
  // CLI's `COPILOT_HOME`.
  assert.equal(fsLog.mkdtemp.length, 1);
  const scratch = fsLog.mkdtemp[0]!;
  const runHome = `${scratch}/copilot-home`;
  // copilot-home + artifacts dirs created.
  assert.ok(fsLog.mkdir.some((m) => m.path === runHome && m.recursive === true));
  assert.ok(fsLog.mkdir.some((m) => m.path === `${scratch}/artifacts` && m.recursive === true));
  // User's source COPILOT_HOME cloned into the per-run home,
  // skipping `mcp-config.json`.
  assert.equal(fsLog.copyDir.length, 1);
  assert.equal(fsLog.copyDir[0]!.src, `${FAKE_HOME_DIR}/.copilot`);
  assert.equal(fsLog.copyDir[0]!.dst, runHome);
  assert.deepEqual([...(fsLog.copyDir[0]!.excludeNames ?? [])], ["mcp-config.json"]);
  // Four writes: mcp-config.json (in run home), prompt.md,
  // authority-policy.json, request.json.
  const writePaths = fsLog.writes.map((w) => w.path);
  assert.deepEqual(writePaths, [
    `${runHome}/mcp-config.json`,
    `${scratch}/prompt.md`,
    `${scratch}/authority-policy.json`,
    `${scratch}/request.json`,
  ]);
  for (const w of fsLog.writes) assert.equal(w.mode, 0o600);
  const mcpFileWrite = fsLog.writes[0]!;
  assert.match(mcpFileWrite.contents, /tok-deadbeef/);
  assert.match(mcpFileWrite.contents, /run-fixture-001/);
  // Pretty-printed (multi-line, trailing newline).
  assert.ok(mcpFileWrite.contents.endsWith("\n"));
  assert.ok(mcpFileWrite.contents.includes("\n  "));
  const mcpFileParsed = JSON.parse(mcpFileWrite.contents) as {
    mcpServers: Record<string, unknown>;
  };
  assert.ok("dreamgraph" in mcpFileParsed.mcpServers);

  // Step 4: spawn invoked with built argv. Per the Large Payload
  // Isolation Rule, argv carries ONLY small fixed-vocabulary
  // control flags — no JSON, no schemas, no MCP manifest. The
  // CLI's `COPILOT_HOME` is pinned to the per-run cloned home so
  // it reads the per-run `mcp-config.json` from the documented
  // data-plane path while keeping the user's persistent auth.
  assert.equal(procLog.spawnCalls.length, 1);
  const spawned = procLog.spawnCalls[0]!;
  assert.equal(spawned.command, "/usr/local/bin/copilot");
  assert.equal(spawned.env.COPILOT_HOME, runHome);
  assert.equal(spawned.env.PATH, "/usr/bin");
  assert.deepEqual([...spawned.args], [...result.argvPlan!.args]);
  assert.ok(spawned.args.includes("--allow-tool"));
  assert.ok(spawned.args.includes("dreamgraph:query_resource"));
  assert.ok(spawned.args.includes("--allow-all-tools"));
  // No `--additional-mcp-config` on argv — MCP config travels by file.
  assert.equal(spawned.args.includes("--additional-mcp-config"), false);
  // No JSON payload anywhere on argv.
  for (const a of spawned.args) {
    assert.ok(!a.includes("\n"), `argv token must be single-line: ${a}`);
    assert.ok(
      !(a.startsWith("{") && a.includes("mcpServers")),
      `argv token must not carry MCP JSON: ${a}`,
    );
  }

  // Step 5: audit started + finished exactly once for the runId.
  assert.deepEqual(auditLog.starts, ["run-fixture-001"]);
  assert.deepEqual(auditLog.finishes, ["run-fixture-001"]);
  assert.equal(result.toolCalls.length, 4);
  assert.equal(result.toolCalls[0]!.classification, "dreamgraph_authoritative");
  assert.equal(result.toolCalls[1]!.classification, "dreamgraph_rejected");
  assert.equal(result.toolCalls[2]!.classification, "provider_inline_tool");
  assert.equal(result.toolCalls[3]!.classification, "generic_context_mcp");

  // Step 6: transcript normalized.
  assert.equal(result.transcript?.assistantText, "Plan looks good.");
  assert.equal(result.transcript?.diagnostics.length, 0);

  // Cleanup: scratch dir removed.
  assert.deepEqual(fsLog.rmRecursive, [scratch]);
});

// ---------------------------------------------------------------------------
// Pre-spawn failures
// ---------------------------------------------------------------------------

test("orchestrator: missing binary → COPILOT_CLI_NOT_FOUND, no spawn", async () => {
  const { process, log } = makeFakeProcess({ resolve: null });
  const { fs, log: fsLog } = makeFakeFs();
  const result = await runCopilotCli(defaultInput(), makeDeps({ process, fs }));
  assert.equal(result.ok, false);
  assert.equal(result.failure?.code, "COPILOT_CLI_NOT_FOUND");
  assert.equal(result.failure?.preSpawn, true);
  assert.equal(log.spawnCalls.length, 0);
  assert.equal(fsLog.mkdtemp.length, 0);
});

test("orchestrator: incomplete help surface → COPILOT_HELP_SURFACE_UNSUPPORTED", async () => {
  const { process, log } = makeFakeProcess({ helpText: "no useful flags here" });
  const result = await runCopilotCli(defaultInput(), makeDeps({ process }));
  assert.equal(result.ok, false);
  assert.equal(result.failure?.code, "COPILOT_HELP_SURFACE_UNSUPPORTED");
  assert.match(result.failure!.message, /--prompt/);
  assert.equal(log.spawnCalls.length, 0);
});

test("orchestrator: missing Copilot config → COPILOT_NOT_LOGGED_IN, no spawn", async () => {
  // No `readFiles` override → fake fs returns null for every path,
  // including <homeDir>/.copilot/config.json. Simulates a fresh user
  // who has installed the CLI but never run `copilot login`.
  const { fs } = makeFakeFs({ readFiles: {} });
  const { process, log } = makeFakeProcess();
  const result = await runCopilotCli(defaultInput(), makeDeps({ fs, process }));
  assert.equal(result.ok, false);
  assert.equal(result.failure?.code, "COPILOT_NOT_LOGGED_IN");
  assert.equal(result.failure?.preSpawn, true);
  assert.match(result.failure!.message, /copilot login/);
  assert.match(result.failure!.message, /config\.json/);
  assert.equal(log.spawnCalls.length, 0);
});

test("orchestrator: config.json with empty loggedInUsers → COPILOT_NOT_LOGGED_IN", async () => {
  const { fs } = makeFakeFs({
    readFiles: {
      [`${FAKE_HOME_DIR}/.copilot/config.json`]: JSON.stringify({ loggedInUsers: [] }),
    },
  });
  const { process, log } = makeFakeProcess();
  const result = await runCopilotCli(defaultInput(), makeDeps({ fs, process }));
  assert.equal(result.ok, false);
  assert.equal(result.failure?.code, "COPILOT_NOT_LOGGED_IN");
  assert.equal(log.spawnCalls.length, 0);
});

test("orchestrator: COPILOT_HOME env override is honoured by the login check", async () => {
  // User overrides COPILOT_HOME → orchestrator must look for config.json
  // there, NOT in <homeDir>/.copilot.
  const { fs, log: fsLog } = makeFakeFs({
    readFiles: {
      "/custom/copilot/config.json": LOGGED_IN_CONFIG_JSON,
    },
  });
  const { process } = makeFakeProcess();
  const result = await runCopilotCli(
    defaultInput({ baseEnv: { PATH: "/usr/bin", COPILOT_HOME: "/custom/copilot" } }),
    makeDeps({ fs, process }),
  );
  assert.equal(result.ok, true);
  assert.ok(fsLog.reads.includes("/custom/copilot/config.json"));
});

test("orchestrator: missing required MCP tool → DREAMGRAPH_TOOL_REGISTRY_MISMATCH", async () => {
  const partial = COPILOT_REQUIRED_AUTHORITATIVE_TOOLS.slice(0, -1);
  const registry = makeFakeRegistry({ liveTools: partial });
  const { process, log } = makeFakeProcess();
  const result = await runCopilotCli(defaultInput(), makeDeps({ process, registry }));
  assert.equal(result.ok, false);
  assert.equal(result.failure?.code, "DREAMGRAPH_TOOL_REGISTRY_MISMATCH");
  assert.match(
    result.failure!.message,
    new RegExp(
      COPILOT_REQUIRED_AUTHORITATIVE_TOOLS[
        COPILOT_REQUIRED_AUTHORITATIVE_TOOLS.length - 1
      ]!,
    ),
  );
  assert.equal(log.spawnCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Post-spawn failures
// ---------------------------------------------------------------------------

test("orchestrator: nonzero exit → COPILOT_RUN_NONZERO_EXIT, transcript captured", async () => {
  const { process } = makeFakeProcess({
    spawnResult: {
      stdout: "",
      stderr: "Error: bad model name\n",
      exitCode: 2,
      signal: null,
      timedOut: false,
      aborted: false,
    },
  });
  const result = await runCopilotCli(defaultInput(), makeDeps({ process }));
  assert.equal(result.ok, false);
  assert.equal(result.failure?.code, "COPILOT_RUN_NONZERO_EXIT");
  assert.match(result.failure!.message, /code 2/);
  assert.match(result.failure!.message, /bad model name/);
  assert.ok(result.transcript?.hasStderrErrors);
});

test("orchestrator: empty-output nonzero exit includes spawn context", async () => {
  const { process } = makeFakeProcess({
    spawnResult: {
      stdout: "",
      stderr: "",
      exitCode: 1,
      signal: null,
      timedOut: false,
      aborted: false,
    },
  });
  const result = await runCopilotCli(defaultInput(), makeDeps({ process }));
  assert.equal(result.ok, false);
  assert.equal(result.failure?.code, "COPILOT_RUN_NONZERO_EXIT");
  assert.match(result.failure!.message, /code 1/);
  assert.match(result.failure!.message, /no output captured on stdout or stderr/);
  assert.match(result.failure!.message, /spawn-context:/);
  assert.match(result.failure!.message, /command: \/usr\/local\/bin\/copilot/);
  assert.match(result.failure!.message, /cwd: \/work\/run/);
  assert.match(result.failure!.message, /timeoutMs: 60000/);
  assert.match(result.failure!.message, /args:/);
});

test("orchestrator: timeout → TIMEOUT", async () => {
  const { process } = makeFakeProcess({
    spawnResult: {
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: "SIGTERM",
      timedOut: true,
      aborted: false,
      durationMs: 60_000,
    },
  });
  const result = await runCopilotCli(defaultInput(), makeDeps({ process }));
  assert.equal(result.ok, false);
  assert.equal(result.failure?.code, "TIMEOUT");
});

test("orchestrator: abort → CANCELLED", async () => {
  const { process } = makeFakeProcess({
    spawnResult: {
      exitCode: null,
      signal: "SIGTERM",
      aborted: true,
      timedOut: false,
    },
  });
  const result = await runCopilotCli(defaultInput(), makeDeps({ process }));
  assert.equal(result.ok, false);
  assert.equal(result.failure?.code, "CANCELLED");
});

test("orchestrator: signal w/o abort/timeout → COPILOT_RUN_SIGNALED", async () => {
  const { process } = makeFakeProcess({
    spawnResult: {
      exitCode: null,
      signal: "SIGKILL",
      aborted: false,
      timedOut: false,
    },
  });
  const result = await runCopilotCli(defaultInput(), makeDeps({ process }));
  assert.equal(result.ok, false);
  assert.equal(result.failure?.code, "COPILOT_RUN_SIGNALED");
  assert.match(result.failure!.message, /SIGKILL/);
});

// ---------------------------------------------------------------------------
// Cleanup invariants
// ---------------------------------------------------------------------------

test("orchestrator: spawn throws → scratch dir still cleaned + audit drained", async () => {
  const boom = new Error("spawn ENOENT");
  const { process } = makeFakeProcess({ spawnThrows: boom });
  const { fs, log: fsLog } = makeFakeFs();
  const { port: mcpAudit, log: auditLog } = makeFakeAudit();
  await assert.rejects(
    () => runCopilotCli(defaultInput(), makeDeps({ process, fs, mcpAudit })),
    /spawn ENOENT/,
  );
  // mkdtemp ran before spawn → cleanup must have happened.
  assert.equal(fsLog.mkdtemp.length, 1);
  assert.deepEqual(fsLog.rmRecursive, [fsLog.mkdtemp[0]]);
  // Audit was started and then drained in finally.
  assert.deepEqual(auditLog.starts, ["run-fixture-001"]);
  assert.deepEqual(auditLog.finishes, ["run-fixture-001"]);
});

test("orchestrator: rejects empty prompt / cwd / invalid timeout", async () => {
  await assert.rejects(
    () => runCopilotCli(defaultInput({ prompt: "" }), makeDeps()),
    /prompt is required/,
  );
  await assert.rejects(
    () => runCopilotCli(defaultInput({ invocationCwd: "" }), makeDeps()),
    /invocationCwd is required/,
  );
  await assert.rejects(
    () => runCopilotCli(defaultInput({ timeoutMs: 0 }), makeDeps()),
    /timeoutMs must be > 0/,
  );
});

// ---------------------------------------------------------------------------
// Transcript normalizer (pure)
// ---------------------------------------------------------------------------

test("transcript: strips ANSI, trims, surfaces stderr diagnostics", () => {
  const t = normalizeCopilotTranscript({
    stdout: "\u001B[31mPlan\u001B[0m looks good.\r\n   \r\n",
    stderr: "warning: model is preview\nError: budget low\n\n",
  });
  assert.equal(t.assistantText, "Plan looks good.");
  assert.deepEqual([...t.diagnostics], [
    "warning: model is preview",
    "Error: budget low",
  ]);
  assert.equal(t.hasStderrErrors, true);
});

test("transcript: clean stderr → hasStderrErrors=false", () => {
  const t = normalizeCopilotTranscript({
    stdout: "ok",
    stderr: "info: done\nnotice: complete",
  });
  assert.equal(t.hasStderrErrors, false);
  assert.equal(t.diagnostics.length, 2);
});

// ---------------------------------------------------------------------------
// Authoritative-server constant guard
// ---------------------------------------------------------------------------

test("orchestrator: classifier wired to dreamgraph authoritative server", () => {
  // Cheap structural assertion to keep the orchestrator and the
  // classifier pointed at the same server name forever.
  assert.equal(DREAMGRAPH_AUTHORITATIVE_SERVER_NAME, "dreamgraph");
});
