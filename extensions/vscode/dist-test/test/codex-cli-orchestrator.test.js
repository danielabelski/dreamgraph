"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Codex CLI adapter - Slice 3 orchestrator tests.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const index_js_1 = require("../architect-core/adapters/codex-cli/index.js");
const ROOT_HELP = `
Codex CLI

Usage: codex [OPTIONS] [COMMAND]

Commands:
  exec    Run Codex non-interactively
  login   Manage login
  mcp     Manage MCP servers
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
      --ephemeral
`;
const FAKE_HOME_DIR = "C:\\Users\\tester";
function makeFakeFs() {
    const log = { mkdtemp: [], mkdir: [], writes: [], reads: [], rmRecursive: [], copyDir: [] };
    const fs = {
        async mkdtemp(prefix) {
            const path = `C:\\Temp\\${prefix}001`;
            log.mkdtemp.push(path);
            return path;
        },
        async mkdir(path, opts) {
            log.mkdir.push({ path, mode: opts?.mode, recursive: opts?.recursive });
        },
        async writeFile(path, contents, opts) {
            log.writes.push({ path, contents, mode: opts?.mode });
        },
        async readFileUtf8(path) {
            log.reads.push(path);
            return null;
        },
        async rmRecursive(path) {
            log.rmRecursive.push(path);
        },
        async copyDirRecursive(src, dst, opts) {
            log.copyDir.push({ src, dst, excludeNames: opts?.excludeNames });
            return true;
        },
        homeDir() {
            return FAKE_HOME_DIR;
        },
        joinPath(...segments) {
            return segments.join("\\");
        },
    };
    return { fs, log };
}
function commandResult(over = {}) {
    return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        signal: null,
        durationMs: 25,
        timedOut: false,
        aborted: false,
        ...over,
    };
}
function spawnResult(over = {}) {
    return {
        stdout: "Implemented Slice 3.\n",
        stderr: "",
        exitCode: 0,
        signal: null,
        durationMs: 250,
        timedOut: false,
        timeoutKind: null,
        aborted: false,
        ...over,
    };
}
function makeFakeProcess(opts = {}) {
    const log = {
        resolveCalls: [],
        rootHelpCalls: 0,
        execHelpCalls: 0,
        loginStatusCalls: 0,
        spawnCalls: [],
    };
    const process = {
        async resolveExecutable(name) {
            log.resolveCalls.push(name);
            if (opts.resolve === undefined)
                return { executablePath: `C:\\bin\\${name}.cmd`, versionString: "codex-cli 0.130.0" };
            return opts.resolve;
        },
        async runRootHelp() {
            log.rootHelpCalls += 1;
            return commandResult({ stdout: ROOT_HELP, ...opts.rootHelp });
        },
        async runExecHelp() {
            log.execHelpCalls += 1;
            return commandResult({ stdout: EXEC_HELP, ...opts.execHelp });
        },
        async runLoginStatus() {
            log.loginStatusCalls += 1;
            return commandResult({ stderr: "Logged in using ChatGPT\n", ...opts.loginStatus });
        },
        async spawn(input) {
            log.spawnCalls.push(input);
            if (opts.spawnThrows)
                throw opts.spawnThrows;
            return spawnResult(opts.spawnResult);
        },
    };
    return { process, log };
}
function makeFakeCrypto() {
    return {
        randomToken(_byteLength) {
            return "tok-codex";
        },
        randomRunId() {
            return "codex-run-001";
        },
    };
}
function makeFakeClock() {
    let now = 1_800_000_000_000;
    return {
        nowMs() {
            const current = now;
            now += 50;
            return current;
        },
    };
}
function makeFakeRegistry(liveTools = index_js_1.CODEX_AUTHORITATIVE_TOOL_CATALOG) {
    return {
        async listAuthoritativeToolNames() {
            return liveTools;
        },
        async describeBridgeSpawn() {
            return { command: "node", args: ["./codex-cli-bridge.js"], env: { DEBUG: "dreamgraph:codex" } };
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
        prompt: "Begin Slice 3 Codex runner and auth recovery wiring",
        invocationCwd: "C:\\repo\\dreamgraph",
        timeoutMs: 60_000,
        idleTimeoutMs: 3_000,
        model: "gpt-5.5",
        profile: "dreamgraph",
        baseEnv: { PATH: "C:\\bin", USERPROFILE: FAKE_HOME_DIR },
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
(0, node_test_1.default)("codex orchestrator: success writes isolated config, spawns codex exec with stdin dash, and cleans up", async () => {
    const { fs, log: fsLog } = makeFakeFs();
    const { process, log: processLog } = makeFakeProcess();
    const recorded = [
        { server: "dreamgraph", tool: "query_resource", inputJson: "{}", resultJson: "{}", isError: false, durationMs: 5, startedAtEpochMs: 1 },
        { server: "dreamgraph", tool: "not_allowed", inputJson: "{}", resultJson: "{}", isError: true, durationMs: 1, startedAtEpochMs: 2 },
        { server: index_js_1.CODEX_INLINE_TOOL_SERVER, tool: "shell", inputJson: "{}", resultJson: "{}", isError: true, durationMs: 1, startedAtEpochMs: 3 },
    ];
    const { port: mcpAudit, log: auditLog } = makeFakeAudit(recorded);
    const result = await (0, index_js_1.runCodexCli)(defaultInput(), makeDeps({ fs, process, mcpAudit }));
    strict_1.default.equal(result.ok, true);
    strict_1.default.equal(result.provider, "codex-cli");
    strict_1.default.equal(result.runId, "codex-run-001");
    strict_1.default.equal(result.failure, undefined);
    strict_1.default.deepEqual(processLog.resolveCalls, ["codex"]);
    strict_1.default.equal(processLog.rootHelpCalls, 1);
    strict_1.default.equal(processLog.execHelpCalls, 1);
    strict_1.default.equal(processLog.loginStatusCalls, 1);
    const scratch = fsLog.mkdtemp[0];
    const runHome = `${scratch}\\codex-home`;
    strict_1.default.ok(fsLog.mkdir.some((m) => m.path === runHome && m.mode === 0o700));
    strict_1.default.deepEqual(fsLog.copyDir, [{ src: `${FAKE_HOME_DIR}\\.codex`, dst: runHome, excludeNames: ["config.toml"] }]);
    strict_1.default.ok(fsLog.writes.some((w) => w.path === `${runHome}\\config.toml` && w.contents.includes("DREAMGRAPH_MCP_TOKEN = \"tok-codex\"")));
    strict_1.default.ok(fsLog.writes.some((w) => w.path === `${scratch}\\request.json` && w.contents.includes("outputLastMessagePath")));
    strict_1.default.equal(processLog.spawnCalls.length, 1);
    const spawned = processLog.spawnCalls[0];
    strict_1.default.equal(spawned.command, "C:\\bin\\codex.cmd");
    strict_1.default.equal(spawned.stdin, defaultInput().prompt);
    strict_1.default.equal(spawned.env.CODEX_HOME, runHome);
    strict_1.default.deepEqual([...spawned.args].slice(0, 9), ["exec", "--json", "--cd", "C:\\repo\\dreamgraph", "--sandbox", "read-only", "--ask-for-approval", "never", "--model"]);
    strict_1.default.equal(spawned.args[spawned.args.length - 1], "-");
    strict_1.default.equal(spawned.timeoutMs, 60_000);
    strict_1.default.equal(spawned.idleTimeoutMs, 3_000);
    strict_1.default.deepEqual(auditLog.starts, ["codex-run-001"]);
    strict_1.default.deepEqual(auditLog.finishes, ["codex-run-001"]);
    strict_1.default.equal(result.toolCalls[0].classification, "dreamgraph_authoritative");
    strict_1.default.equal(result.toolCalls[1].classification, "dreamgraph_rejected");
    strict_1.default.equal(result.toolCalls[2].classification, "provider_inline_tool");
    strict_1.default.deepEqual(fsLog.rmRecursive, [scratch]);
});
(0, node_test_1.default)("codex orchestrator: missing binary fails before spawn", async () => {
    const { process, log } = makeFakeProcess({ resolve: null });
    const result = await (0, index_js_1.runCodexCli)(defaultInput(), makeDeps({ process }));
    strict_1.default.equal(result.ok, false);
    strict_1.default.equal(result.failure?.code, "CODEX_CLI_NOT_FOUND");
    strict_1.default.equal(result.failure?.cause, "missing-binary");
    strict_1.default.equal(log.spawnCalls.length, 0);
});
(0, node_test_1.default)("codex orchestrator: unsupported help surface fails before spawn", async () => {
    const { process, log } = makeFakeProcess({ execHelp: { stdout: "Usage: codex exec" } });
    const result = await (0, index_js_1.runCodexCli)(defaultInput(), makeDeps({ process }));
    strict_1.default.equal(result.ok, false);
    strict_1.default.equal(result.failure?.code, "CODEX_HELP_SURFACE_UNSUPPORTED");
    strict_1.default.match(result.failure.message, /--json/);
    strict_1.default.equal(log.spawnCalls.length, 0);
});
(0, node_test_1.default)("codex orchestrator: codex login status failure returns clickable login recovery metadata", async () => {
    const { process, log } = makeFakeProcess({
        loginStatus: { exitCode: 1, stderr: "Error: not logged in. Please run codex login.\n" },
    });
    const result = await (0, index_js_1.runCodexCli)(defaultInput(), makeDeps({ process }));
    strict_1.default.equal(result.ok, false);
    strict_1.default.equal(result.failure?.code, "CODEX_NOT_LOGGED_IN");
    strict_1.default.equal(result.failure?.cause, "not-logged-in");
    strict_1.default.equal(result.failure?.recoveryAction?.command, "codex login");
    strict_1.default.equal(result.failure?.recoveryAction?.label, "Run codex login");
    strict_1.default.equal(log.spawnCalls.length, 0);
});
(0, node_test_1.default)("codex orchestrator: login status policy noise is advisory unless it reports auth failure", async () => {
    const { process, log } = makeFakeProcess({
        loginStatus: {
            exitCode: 1,
            stdout: "SUCCESS: The process with PID 22852 (child process of PID 24560) has been terminated.\n",
            stderr: [
                "2026-05-21T13:34:16.333679Z ERROR rmcp::transport::async_rw: Error reading from stream: serde error EOF while parsing a value at line 1 column 0",
                "2026-05-21T13:34:30.489369Z ERROR codex_core::tools::router: error=\"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -Command \"if (Test-Path package.json) { Get-Content package.json -Raw } else { 'NO_PACKAGE_JSON' }\" rejected: blocked by policy",
            ].join("\n"),
        },
        spawnResult: {
            stdout: [
                JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
                JSON.stringify({ type: "turn.started" }),
                JSON.stringify({
                    type: "item.completed",
                    item: { id: "item_0", type: "agent_message", text: "Project state assessed." },
                }),
                JSON.stringify({ type: "turn.completed" }),
            ].join(" "),
        },
    });
    const result = await (0, index_js_1.runCodexCli)(defaultInput(), makeDeps({ process }));
    strict_1.default.equal(result.ok, true);
    strict_1.default.equal(result.failure, undefined);
    strict_1.default.equal(log.spawnCalls.length, 1);
    strict_1.default.equal(result.transcript?.assistantText, "Project state assessed.");
});
(0, node_test_1.default)("codex orchestrator: codex login status exit 0 is authoritative even with misleading noise", async () => {
    // Reproduces the live regression where `codex login status` succeeded (exit 0)
    // but tools::router noise containing the substring "please run codex login"
    // tripped the heuristic and aborted the run as CODEX_NOT_LOGGED_IN.
    const { process, log } = makeFakeProcess({
        loginStatus: {
            exitCode: 0,
            stdout: "SUCCESS: The process with PID 22852 (child process of PID 24560) has been terminated.\n",
            stderr: [
                "2026-05-21T13:34:16.333679Z ERROR rmcp::transport::async_rw: Error reading from stream: serde error EOF while parsing a value at line 1 column 0",
                "2026-05-21T13:34:30.489369Z ERROR codex_core::tools::router: rejected: blocked by policy; please run codex login if needed",
                "Authentication required for sandboxed shell tool",
            ].join("\n"),
        },
        spawnResult: {
            stdout: [
                JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
                JSON.stringify({ type: "turn.started" }),
                JSON.stringify({
                    type: "item.completed",
                    item: { id: "item_0", type: "agent_message", text: "Project state assessed." },
                }),
                JSON.stringify({ type: "turn.completed" }),
            ].join(" "),
        },
    });
    const result = await (0, index_js_1.runCodexCli)(defaultInput(), makeDeps({ process }));
    strict_1.default.equal(result.ok, true);
    strict_1.default.equal(result.failure, undefined);
    strict_1.default.equal(log.spawnCalls.length, 1);
    strict_1.default.equal(result.transcript?.assistantText, "Project state assessed.");
});
(0, node_test_1.default)("codex orchestrator: exec MCP runtime failure fails closed instead of accepting ungrounded output", async () => {
    const { process, log } = makeFakeProcess({
        spawnResult: {
            stdout: [
                JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
                JSON.stringify({ type: "turn.started" }),
                JSON.stringify({
                    type: "item.completed",
                    item: { id: "item_0", type: "agent_message", text: "Project state assessed without tools." },
                }),
                JSON.stringify({ type: "turn.completed" }),
            ].join("\n"),
            stderr: "2026-05-21T14:29:57.280897Z ERROR codex_mcp_server::client: " +
                "failed to load MCP server `dreamgraph`: bridge exited before completing initialize\n",
        },
    });
    const result = await (0, index_js_1.runCodexCli)(defaultInput(), makeDeps({ process }));
    strict_1.default.equal(log.spawnCalls.length, 1);
    strict_1.default.equal(result.ok, false);
    strict_1.default.equal(result.failure?.code, "MCP_PROBE_FAILED");
    strict_1.default.equal(result.failure?.cause, "mcp-load-failed");
    strict_1.default.equal(result.failure?.preSpawn, false);
    strict_1.default.equal(result.toolCalls.length, 0);
    strict_1.default.match(result.failure.message, /without any audited DreamGraph MCP calls/);
});
(0, node_test_1.default)("codex orchestrator: rmcp transport EOF on shutdown is teardown noise, not a load failure", async () => {
    // Regression: Codex taskkills its MCP child servers at the end of every run,
    // which produces a benign "rmcp::transport::async_rw: Error reading from
    // stream: serde error EOF" line on stderr. A previous version of the
    // MCP_RUNTIME_FAILURE_RE matched that line and aborted otherwise-successful
    // runs with a false MCP_PROBE_FAILED whenever the model answered inline
    // without invoking a tool. Teardown noise must NOT fail the run.
    const { process, log } = makeFakeProcess({
        spawnResult: {
            stdout: [
                JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
                JSON.stringify({ type: "turn.started" }),
                JSON.stringify({
                    type: "item.completed",
                    item: { id: "item_0", type: "agent_message", text: "Graph health summary." },
                }),
                JSON.stringify({ type: "turn.completed" }),
            ].join("\n"),
            stderr: [
                "SUCCESS: The process with PID 6400 (child process of PID 14160) has been terminated.",
                "2026-05-21T18:46:35.595268Z ERROR rmcp::transport::async_rw: Error reading from stream: serde error EOF while parsing a value at line 1 column 0",
            ].join("\n"),
        },
    });
    const result = await (0, index_js_1.runCodexCli)(defaultInput(), makeDeps({ process }));
    strict_1.default.equal(log.spawnCalls.length, 1);
    strict_1.default.equal(result.ok, true);
    strict_1.default.equal(result.failure, undefined);
    strict_1.default.equal(result.transcript?.assistantText, "Graph health summary.");
});
(0, node_test_1.default)("codex orchestrator: missing required DreamGraph tool fails closed", async () => {
    const missing = index_js_1.CODEX_MINIMUM_AUTHORITATIVE_TOOLS[0];
    const live = index_js_1.CODEX_AUTHORITATIVE_TOOL_CATALOG.filter((tool) => tool !== missing);
    const { process, log } = makeFakeProcess();
    const result = await (0, index_js_1.runCodexCli)(defaultInput(), makeDeps({ process, registry: makeFakeRegistry(live) }));
    strict_1.default.equal(result.ok, false);
    strict_1.default.equal(result.failure?.code, "DREAMGRAPH_TOOL_REGISTRY_MISMATCH");
    strict_1.default.match(result.failure.message, new RegExp(missing));
    strict_1.default.equal(log.spawnCalls.length, 0);
});
(0, node_test_1.default)("codex orchestrator: wall timeout and idle timeout remain distinguishable", async () => {
    const wall = makeFakeProcess({ spawnResult: { exitCode: null, signal: "SIGTERM", timedOut: true, timeoutKind: "wall", durationMs: 60_000 } });
    const wallResult = await (0, index_js_1.runCodexCli)(defaultInput(), makeDeps({ process: wall.process }));
    strict_1.default.equal(wallResult.ok, false);
    strict_1.default.equal(wallResult.failure?.code, "TIMEOUT");
    strict_1.default.equal(wallResult.failure?.cause, "wall-timeout");
    const idle = makeFakeProcess({ spawnResult: { exitCode: null, signal: "SIGTERM", timedOut: true, timeoutKind: "idle", durationMs: 3_000 } });
    const idleResult = await (0, index_js_1.runCodexCli)(defaultInput(), makeDeps({ process: idle.process }));
    strict_1.default.equal(idleResult.ok, false);
    strict_1.default.equal(idleResult.failure?.code, "TIMEOUT");
    strict_1.default.equal(idleResult.failure?.cause, "idle-timeout");
});
(0, node_test_1.default)("codex orchestrator: cancellation, signal, nonzero, and not-logged-in exec failures are classified", async () => {
    const cancelled = makeFakeProcess({ spawnResult: { exitCode: null, signal: "SIGTERM", aborted: true } });
    const cancelledResult = await (0, index_js_1.runCodexCli)(defaultInput(), makeDeps({ process: cancelled.process }));
    strict_1.default.equal(cancelledResult.failure?.code, "CANCELLED");
    strict_1.default.equal(cancelledResult.failure?.cause, "user-cancelled");
    const signaled = makeFakeProcess({ spawnResult: { exitCode: null, signal: "SIGKILL" } });
    const signaledResult = await (0, index_js_1.runCodexCli)(defaultInput(), makeDeps({ process: signaled.process }));
    strict_1.default.equal(signaledResult.failure?.code, "CODEX_RUN_SIGNALED");
    strict_1.default.equal(signaledResult.failure?.cause, "process-signal");
    const nonzero = makeFakeProcess({ spawnResult: { exitCode: 2, stderr: "Error: bad model\n" } });
    const nonzeroResult = await (0, index_js_1.runCodexCli)(defaultInput(), makeDeps({ process: nonzero.process }));
    strict_1.default.equal(nonzeroResult.failure?.code, "CODEX_RUN_NONZERO_EXIT");
    strict_1.default.match(nonzeroResult.failure.message, /bad model/);
    const auth = makeFakeProcess({ spawnResult: { exitCode: 1, stderr: "Error: not logged in. Please run codex login.\n" } });
    const authResult = await (0, index_js_1.runCodexCli)(defaultInput(), makeDeps({ process: auth.process }));
    strict_1.default.equal(authResult.failure?.code, "CODEX_NOT_LOGGED_IN");
    strict_1.default.equal(authResult.failure?.recoveryAction?.command, "codex login");
});
(0, node_test_1.default)("codex orchestrator: thrown spawn still drains audit and cleans scratch", async () => {
    const { fs, log: fsLog } = makeFakeFs();
    const { process } = makeFakeProcess({ spawnThrows: new Error("spawn exploded") });
    const { port: mcpAudit, log: auditLog } = makeFakeAudit();
    const result = await (0, index_js_1.runCodexCli)(defaultInput(), makeDeps({ fs, process, mcpAudit }));
    strict_1.default.equal(result.ok, false);
    strict_1.default.equal(result.failure?.cause, "spawn-error");
    strict_1.default.deepEqual(auditLog.starts, ["codex-run-001"]);
    strict_1.default.deepEqual(auditLog.finishes, ["codex-run-001"]);
    strict_1.default.deepEqual(fsLog.rmRecursive, [fsLog.mkdtemp[0]]);
});
(0, node_test_1.default)("codex orchestrator: validates required input", async () => {
    await strict_1.default.rejects(() => (0, index_js_1.runCodexCli)(defaultInput({ prompt: "" }), makeDeps()), /prompt is required/);
    await strict_1.default.rejects(() => (0, index_js_1.runCodexCli)(defaultInput({ invocationCwd: "" }), makeDeps()), /invocationCwd is required/);
    await strict_1.default.rejects(() => (0, index_js_1.runCodexCli)(defaultInput({ timeoutMs: 0 }), makeDeps()), /timeoutMs must be > 0/);
});
//# sourceMappingURL=codex-cli-orchestrator.test.js.map