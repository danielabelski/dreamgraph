"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — Slice 2 orchestrator tests.
//
// Drives `runCopilotCli` end-to-end using in-memory fakes for every
// IO port. Covers the happy path, every pre-spawn rejection, every
// post-spawn failure mode, and the cleanup invariants.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const index_js_1 = require("../architect-core/adapters/copilot-cli/index.js");
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
function makeFakeFs(opts = {}) {
    const log = {
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
    const reads = opts.readFiles !== undefined
        ? { ...opts.readFiles }
        : { [`${homeDir}/.copilot/config.json`]: LOGGED_IN_CONFIG_JSON };
    const fs = {
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
            return Object.prototype.hasOwnProperty.call(reads, path) ? reads[path] : null;
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
function makeFakeProcess(opts = {}) {
    const log = {
        resolveCalls: [],
        helpCalls: 0,
        spawnCalls: [],
    };
    const process = {
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
            if (opts.spawnThrows)
                throw opts.spawnThrows;
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
function makeFakeCrypto() {
    return {
        randomToken(_n) {
            return "tok-deadbeef";
        },
        randomRunId() {
            return "run-fixture-001";
        },
    };
}
function makeFakeClock() {
    let t = 1_700_000_000_000;
    return {
        nowMs() {
            const now = t;
            t += 50;
            return now;
        },
    };
}
function makeFakeRegistry(opts = {}) {
    return {
        async listAuthoritativeToolNames() {
            return opts.liveTools ?? [...index_js_1.COPILOT_REQUIRED_AUTHORITATIVE_TOOLS];
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
function makeFakeAudit(recorded = []) {
    const log = { starts: [], finishes: [] };
    let drained = false;
    const port = {
        async startRecording(runId) {
            log.starts.push(runId);
        },
        async finishRecording(runId) {
            log.finishes.push(runId);
            if (drained)
                return [];
            drained = true;
            return recorded;
        },
    };
    return { port, log };
}
function defaultInput(over = {}) {
    return {
        prompt: "Plan a refactor.",
        model: "claude-sonnet-4.5",
        invocationCwd: "/work/run",
        timeoutMs: 60_000,
        baseEnv: { PATH: "/usr/bin", HOME: "/home/user" },
        ...over,
    };
}
function makeDeps(over = {}) {
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
(0, node_test_1.default)("orchestrator: happy path runs all six steps and returns ok=true", async () => {
    const { fs, log: fsLog } = makeFakeFs();
    const { process, log: procLog } = makeFakeProcess();
    const recorded = [
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
    const result = await (0, index_js_1.runCopilotCli)(defaultInput(), makeDeps({ fs, process, mcpAudit }));
    strict_1.default.equal(result.ok, true);
    strict_1.default.equal(result.failure, undefined);
    strict_1.default.equal(result.provider, "copilot-cli");
    strict_1.default.equal(result.runId, "run-fixture-001");
    strict_1.default.ok(result.totalDurationMs >= 0);
    // Step 1: resolve + help probe.
    strict_1.default.deepEqual(procLog.resolveCalls, ["copilot"]);
    strict_1.default.equal(procLog.helpCalls, 1);
    strict_1.default.ok(result.helpSurface?.required.prompt);
    // Step 3: scratch dir materialized with structured layout. The
    // adapter follows the LARGE PAYLOAD ISOLATION RULE — argv stays
    // tiny and all semantic payloads (MCP manifest, prompt,
    // authority policy, request manifest) are written to a per-run
    // directory whose `copilot-home/` subdir becomes the spawned
    // CLI's `COPILOT_HOME`.
    strict_1.default.equal(fsLog.mkdtemp.length, 1);
    const scratch = fsLog.mkdtemp[0];
    const runHome = `${scratch}/copilot-home`;
    // copilot-home + artifacts dirs created.
    strict_1.default.ok(fsLog.mkdir.some((m) => m.path === runHome && m.recursive === true));
    strict_1.default.ok(fsLog.mkdir.some((m) => m.path === `${scratch}/artifacts` && m.recursive === true));
    // User's source COPILOT_HOME cloned into the per-run home,
    // skipping `mcp-config.json`.
    strict_1.default.equal(fsLog.copyDir.length, 1);
    strict_1.default.equal(fsLog.copyDir[0].src, `${FAKE_HOME_DIR}/.copilot`);
    strict_1.default.equal(fsLog.copyDir[0].dst, runHome);
    strict_1.default.deepEqual([...(fsLog.copyDir[0].excludeNames ?? [])], ["mcp-config.json"]);
    // Four writes: mcp-config.json (in run home), prompt.md,
    // authority-policy.json, request.json.
    const writePaths = fsLog.writes.map((w) => w.path);
    strict_1.default.deepEqual(writePaths, [
        `${runHome}/mcp-config.json`,
        `${scratch}/prompt.md`,
        `${scratch}/authority-policy.json`,
        `${scratch}/request.json`,
    ]);
    for (const w of fsLog.writes)
        strict_1.default.equal(w.mode, 0o600);
    const mcpFileWrite = fsLog.writes[0];
    strict_1.default.match(mcpFileWrite.contents, /tok-deadbeef/);
    strict_1.default.match(mcpFileWrite.contents, /run-fixture-001/);
    // Pretty-printed (multi-line, trailing newline).
    strict_1.default.ok(mcpFileWrite.contents.endsWith("\n"));
    strict_1.default.ok(mcpFileWrite.contents.includes("\n  "));
    const mcpFileParsed = JSON.parse(mcpFileWrite.contents);
    strict_1.default.ok("dreamgraph" in mcpFileParsed.mcpServers);
    // Step 4: spawn invoked with built argv. Per the Large Payload
    // Isolation Rule, argv carries ONLY small fixed-vocabulary
    // control flags — no JSON, no schemas, no MCP manifest. The
    // CLI's `COPILOT_HOME` is pinned to the per-run cloned home so
    // it reads the per-run `mcp-config.json` from the documented
    // data-plane path while keeping the user's persistent auth.
    strict_1.default.equal(procLog.spawnCalls.length, 1);
    const spawned = procLog.spawnCalls[0];
    strict_1.default.equal(spawned.command, "/usr/local/bin/copilot");
    strict_1.default.equal(spawned.env.COPILOT_HOME, runHome);
    strict_1.default.equal(spawned.env.PATH, "/usr/bin");
    strict_1.default.deepEqual([...spawned.args], [...result.argvPlan.args]);
    strict_1.default.ok(spawned.args.includes("--allow-tool"));
    strict_1.default.ok(spawned.args.includes("dreamgraph(query_resource)"));
    strict_1.default.ok(spawned.args.includes("--allow-all-tools"));
    // No `--additional-mcp-config` on argv — MCP config travels by file.
    strict_1.default.equal(spawned.args.includes("--additional-mcp-config"), false);
    // No JSON payload anywhere on argv.
    for (const a of spawned.args) {
        strict_1.default.ok(!a.includes("\n"), `argv token must be single-line: ${a}`);
        strict_1.default.ok(!(a.startsWith("{") && a.includes("mcpServers")), `argv token must not carry MCP JSON: ${a}`);
    }
    // Step 5: audit started + finished exactly once for the runId.
    strict_1.default.deepEqual(auditLog.starts, ["run-fixture-001"]);
    strict_1.default.deepEqual(auditLog.finishes, ["run-fixture-001"]);
    strict_1.default.equal(result.toolCalls.length, 4);
    strict_1.default.equal(result.toolCalls[0].classification, "dreamgraph_authoritative");
    strict_1.default.equal(result.toolCalls[1].classification, "dreamgraph_rejected");
    strict_1.default.equal(result.toolCalls[2].classification, "provider_inline_tool");
    strict_1.default.equal(result.toolCalls[3].classification, "generic_context_mcp");
    // Step 6: transcript normalized.
    strict_1.default.equal(result.transcript?.assistantText, "Plan looks good.");
    strict_1.default.equal(result.transcript?.diagnostics.length, 0);
    // Cleanup: scratch dir removed.
    strict_1.default.deepEqual(fsLog.rmRecursive, [scratch]);
});
// ---------------------------------------------------------------------------
// Pre-spawn failures
// ---------------------------------------------------------------------------
(0, node_test_1.default)("orchestrator: missing binary → COPILOT_CLI_NOT_FOUND, no spawn", async () => {
    const { process, log } = makeFakeProcess({ resolve: null });
    const { fs, log: fsLog } = makeFakeFs();
    const result = await (0, index_js_1.runCopilotCli)(defaultInput(), makeDeps({ process, fs }));
    strict_1.default.equal(result.ok, false);
    strict_1.default.equal(result.failure?.code, "COPILOT_CLI_NOT_FOUND");
    strict_1.default.equal(result.failure?.preSpawn, true);
    strict_1.default.equal(log.spawnCalls.length, 0);
    strict_1.default.equal(fsLog.mkdtemp.length, 0);
});
(0, node_test_1.default)("orchestrator: incomplete help surface → COPILOT_HELP_SURFACE_UNSUPPORTED", async () => {
    const { process, log } = makeFakeProcess({ helpText: "no useful flags here" });
    const result = await (0, index_js_1.runCopilotCli)(defaultInput(), makeDeps({ process }));
    strict_1.default.equal(result.ok, false);
    strict_1.default.equal(result.failure?.code, "COPILOT_HELP_SURFACE_UNSUPPORTED");
    strict_1.default.match(result.failure.message, /--prompt/);
    strict_1.default.equal(log.spawnCalls.length, 0);
});
(0, node_test_1.default)("orchestrator: missing Copilot config → COPILOT_NOT_LOGGED_IN, no spawn", async () => {
    // No `readFiles` override → fake fs returns null for every path,
    // including <homeDir>/.copilot/config.json. Simulates a fresh user
    // who has installed the CLI but never run `copilot login`.
    const { fs } = makeFakeFs({ readFiles: {} });
    const { process, log } = makeFakeProcess();
    const result = await (0, index_js_1.runCopilotCli)(defaultInput(), makeDeps({ fs, process }));
    strict_1.default.equal(result.ok, false);
    strict_1.default.equal(result.failure?.code, "COPILOT_NOT_LOGGED_IN");
    strict_1.default.equal(result.failure?.preSpawn, true);
    strict_1.default.match(result.failure.message, /copilot login/);
    strict_1.default.match(result.failure.message, /config\.json/);
    strict_1.default.equal(log.spawnCalls.length, 0);
});
(0, node_test_1.default)("orchestrator: config.json with empty loggedInUsers → COPILOT_NOT_LOGGED_IN", async () => {
    const { fs } = makeFakeFs({
        readFiles: {
            [`${FAKE_HOME_DIR}/.copilot/config.json`]: JSON.stringify({ loggedInUsers: [] }),
        },
    });
    const { process, log } = makeFakeProcess();
    const result = await (0, index_js_1.runCopilotCli)(defaultInput(), makeDeps({ fs, process }));
    strict_1.default.equal(result.ok, false);
    strict_1.default.equal(result.failure?.code, "COPILOT_NOT_LOGGED_IN");
    strict_1.default.equal(log.spawnCalls.length, 0);
});
(0, node_test_1.default)("orchestrator: COPILOT_HOME env override is honoured by the login check", async () => {
    // User overrides COPILOT_HOME → orchestrator must look for config.json
    // there, NOT in <homeDir>/.copilot.
    const { fs, log: fsLog } = makeFakeFs({
        readFiles: {
            "/custom/copilot/config.json": LOGGED_IN_CONFIG_JSON,
        },
    });
    const { process } = makeFakeProcess();
    const result = await (0, index_js_1.runCopilotCli)(defaultInput({ baseEnv: { PATH: "/usr/bin", COPILOT_HOME: "/custom/copilot" } }), makeDeps({ fs, process }));
    strict_1.default.equal(result.ok, true);
    strict_1.default.ok(fsLog.reads.includes("/custom/copilot/config.json"));
});
(0, node_test_1.default)("orchestrator: missing required MCP tool → DREAMGRAPH_TOOL_REGISTRY_MISMATCH", async () => {
    const partial = index_js_1.COPILOT_REQUIRED_AUTHORITATIVE_TOOLS.slice(0, -1);
    const registry = makeFakeRegistry({ liveTools: partial });
    const { process, log } = makeFakeProcess();
    const result = await (0, index_js_1.runCopilotCli)(defaultInput(), makeDeps({ process, registry }));
    strict_1.default.equal(result.ok, false);
    strict_1.default.equal(result.failure?.code, "DREAMGRAPH_TOOL_REGISTRY_MISMATCH");
    strict_1.default.match(result.failure.message, new RegExp(index_js_1.COPILOT_REQUIRED_AUTHORITATIVE_TOOLS[index_js_1.COPILOT_REQUIRED_AUTHORITATIVE_TOOLS.length - 1]));
    strict_1.default.equal(log.spawnCalls.length, 0);
});
// ---------------------------------------------------------------------------
// Post-spawn failures
// ---------------------------------------------------------------------------
(0, node_test_1.default)("orchestrator: nonzero exit → COPILOT_RUN_NONZERO_EXIT, transcript captured", async () => {
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
    const result = await (0, index_js_1.runCopilotCli)(defaultInput(), makeDeps({ process }));
    strict_1.default.equal(result.ok, false);
    strict_1.default.equal(result.failure?.code, "COPILOT_RUN_NONZERO_EXIT");
    strict_1.default.match(result.failure.message, /code 2/);
    strict_1.default.match(result.failure.message, /bad model name/);
    strict_1.default.ok(result.transcript?.hasStderrErrors);
});
(0, node_test_1.default)("orchestrator: empty-output nonzero exit includes spawn context", async () => {
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
    const result = await (0, index_js_1.runCopilotCli)(defaultInput(), makeDeps({ process }));
    strict_1.default.equal(result.ok, false);
    strict_1.default.equal(result.failure?.code, "COPILOT_RUN_NONZERO_EXIT");
    strict_1.default.match(result.failure.message, /code 1/);
    strict_1.default.match(result.failure.message, /no output captured on stdout or stderr/);
    strict_1.default.match(result.failure.message, /spawn-context:/);
    strict_1.default.match(result.failure.message, /command: \/usr\/local\/bin\/copilot/);
    strict_1.default.match(result.failure.message, /cwd: \/work\/run/);
    strict_1.default.match(result.failure.message, /timeoutMs: 60000/);
    strict_1.default.match(result.failure.message, /args:/);
});
(0, node_test_1.default)("orchestrator: timeout → TIMEOUT", async () => {
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
    const result = await (0, index_js_1.runCopilotCli)(defaultInput(), makeDeps({ process }));
    strict_1.default.equal(result.ok, false);
    strict_1.default.equal(result.failure?.code, "TIMEOUT");
});
(0, node_test_1.default)("orchestrator: abort → CANCELLED", async () => {
    const { process } = makeFakeProcess({
        spawnResult: {
            exitCode: null,
            signal: "SIGTERM",
            aborted: true,
            timedOut: false,
        },
    });
    const result = await (0, index_js_1.runCopilotCli)(defaultInput(), makeDeps({ process }));
    strict_1.default.equal(result.ok, false);
    strict_1.default.equal(result.failure?.code, "CANCELLED");
});
(0, node_test_1.default)("orchestrator: signal w/o abort/timeout → COPILOT_RUN_SIGNALED", async () => {
    const { process } = makeFakeProcess({
        spawnResult: {
            exitCode: null,
            signal: "SIGKILL",
            aborted: false,
            timedOut: false,
        },
    });
    const result = await (0, index_js_1.runCopilotCli)(defaultInput(), makeDeps({ process }));
    strict_1.default.equal(result.ok, false);
    strict_1.default.equal(result.failure?.code, "COPILOT_RUN_SIGNALED");
    strict_1.default.match(result.failure.message, /SIGKILL/);
});
// ---------------------------------------------------------------------------
// Cleanup invariants
// ---------------------------------------------------------------------------
(0, node_test_1.default)("orchestrator: spawn throws → scratch dir still cleaned + audit drained", async () => {
    const boom = new Error("spawn ENOENT");
    const { process } = makeFakeProcess({ spawnThrows: boom });
    const { fs, log: fsLog } = makeFakeFs();
    const { port: mcpAudit, log: auditLog } = makeFakeAudit();
    await strict_1.default.rejects(() => (0, index_js_1.runCopilotCli)(defaultInput(), makeDeps({ process, fs, mcpAudit })), /spawn ENOENT/);
    // mkdtemp ran before spawn → cleanup must have happened.
    strict_1.default.equal(fsLog.mkdtemp.length, 1);
    strict_1.default.deepEqual(fsLog.rmRecursive, [fsLog.mkdtemp[0]]);
    // Audit was started and then drained in finally.
    strict_1.default.deepEqual(auditLog.starts, ["run-fixture-001"]);
    strict_1.default.deepEqual(auditLog.finishes, ["run-fixture-001"]);
});
(0, node_test_1.default)("orchestrator: rejects empty prompt / cwd / invalid timeout", async () => {
    await strict_1.default.rejects(() => (0, index_js_1.runCopilotCli)(defaultInput({ prompt: "" }), makeDeps()), /prompt is required/);
    await strict_1.default.rejects(() => (0, index_js_1.runCopilotCli)(defaultInput({ invocationCwd: "" }), makeDeps()), /invocationCwd is required/);
    await strict_1.default.rejects(() => (0, index_js_1.runCopilotCli)(defaultInput({ timeoutMs: 0 }), makeDeps()), /timeoutMs must be > 0/);
});
// ---------------------------------------------------------------------------
// Transcript normalizer (pure)
// ---------------------------------------------------------------------------
(0, node_test_1.default)("transcript: strips ANSI, trims, surfaces stderr diagnostics", () => {
    const t = (0, index_js_1.normalizeCopilotTranscript)({
        stdout: "\u001B[31mPlan\u001B[0m looks good.\r\n   \r\n",
        stderr: "warning: model is preview\nError: budget low\n\n",
    });
    strict_1.default.equal(t.assistantText, "Plan looks good.");
    strict_1.default.deepEqual([...t.diagnostics], [
        "warning: model is preview",
        "Error: budget low",
    ]);
    strict_1.default.equal(t.hasStderrErrors, true);
});
(0, node_test_1.default)("transcript: clean stderr → hasStderrErrors=false", () => {
    const t = (0, index_js_1.normalizeCopilotTranscript)({
        stdout: "ok",
        stderr: "info: done\nnotice: complete",
    });
    strict_1.default.equal(t.hasStderrErrors, false);
    strict_1.default.equal(t.diagnostics.length, 2);
});
// ---------------------------------------------------------------------------
// Authoritative-server constant guard
// ---------------------------------------------------------------------------
(0, node_test_1.default)("orchestrator: classifier wired to dreamgraph authoritative server", () => {
    // Cheap structural assertion to keep the orchestrator and the
    // classifier pointed at the same server name forever.
    strict_1.default.equal(index_js_1.DREAMGRAPH_AUTHORITATIVE_SERVER_NAME, "dreamgraph");
});
//# sourceMappingURL=copilot-cli-orchestrator.test.js.map