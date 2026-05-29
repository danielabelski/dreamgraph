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
            if (path.endsWith("\\auth.json"))
                return "{\"tokens\":true}\n";
            if (path.endsWith("\\version.json"))
                return "{\"version\":\"test\"}\n";
            if (path.endsWith("\\installation_id"))
                return "install-test\n";
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
        rootHelpCwds: [],
        execHelpCalls: 0,
        execHelpCwds: [],
        loginStatusCalls: 0,
        loginStatusCwds: [],
        spawnCalls: [],
    };
    const process = {
        async resolveExecutable(name) {
            log.resolveCalls.push(name);
            if (opts.resolve === undefined)
                return { executablePath: `C:\\bin\\${name}.cmd`, versionString: "codex-cli 0.130.0" };
            return opts.resolve;
        },
        async runRootHelp(input) {
            log.rootHelpCalls += 1;
            log.rootHelpCwds.push(input.cwd);
            return commandResult({ stdout: ROOT_HELP, ...opts.rootHelp });
        },
        async runExecHelp(input) {
            log.execHelpCalls += 1;
            log.execHelpCwds.push(input.cwd);
            return commandResult({ stdout: EXEC_HELP, ...opts.execHelp });
        },
        async runLoginStatus(input) {
            log.loginStatusCalls += 1;
            log.loginStatusCwds.push(input.cwd);
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
            return {
                command: "node",
                args: ["./codex-cli-bridge.js"],
                env: {
                    DEBUG: "dreamgraph:codex",
                    DREAMGRAPH_BRIDGE_AUDIT_DIR: "C:\\audit",
                    DREAMGRAPH_HOST_MCP_URL: "http://127.0.0.1:8010/mcp/",
                    DREAMGRAPH_WORKSPACE_ROOT: "C:\\repo\\dreamgraph",
                },
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
function makeRecordedDreamGraphCalls(count) {
    return Object.freeze(Array.from({ length: count }, (_value, index) => ({
        server: "dreamgraph",
        tool: index % 2 === 0 ? "query_resource" : "read_source_code",
        inputJson: "{}",
        resultJson: "{\"ok\":true}",
        isError: false,
        durationMs: 5,
        startedAtEpochMs: 1_800_000_000_000 + index,
    })));
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
    strict_1.default.deepEqual(fsLog.copyDir, []);
    strict_1.default.deepEqual(fsLog.reads, [
        `${FAKE_HOME_DIR}\\.codex\\auth.json`,
        `${FAKE_HOME_DIR}\\.codex\\version.json`,
        `${FAKE_HOME_DIR}\\.codex\\installation_id`,
    ]);
    strict_1.default.ok(fsLog.writes.some((w) => w.path === `${runHome}\\auth.json` && w.contents.includes("\"tokens\":true")));
    strict_1.default.ok(fsLog.writes.some((w) => w.path === `${runHome}\\config.toml` && w.contents.includes("DREAMGRAPH_MCP_TOKEN = \"tok-codex\"")));
    strict_1.default.ok(fsLog.writes.some((w) => w.path === `${runHome}\\config.toml` && w.contents.includes("[mcp_servers.dreamgraph.env]")));
    strict_1.default.ok(fsLog.writes.every((w) => w.path !== `${runHome}\\config.toml` || !/^env = \{/m.test(w.contents)));
    strict_1.default.ok(fsLog.writes.some((w) => w.path === `${runHome}\\config.toml` && w.contents.includes("DREAMGRAPH_BRIDGE_AUDIT_DIR = \"C:\\\\audit\"")));
    strict_1.default.ok(fsLog.writes.some((w) => w.path === `${runHome}\\config.toml` && w.contents.includes("DREAMGRAPH_RUN_ID = \"codex-run-001\"")));
    strict_1.default.ok(fsLog.writes.some((w) => w.path === `${runHome}\\config.toml` && w.contents.includes("default_tools_enabled = true")));
    strict_1.default.ok(fsLog.writes.some((w) => w.path === `${runHome}\\config.toml` && w.contents.includes("trust_level = \"trusted\"")));
    strict_1.default.ok(fsLog.writes.some((w) => w.path === `${runHome}\\config.toml` && w.contents.includes("default_tools_approval_mode = \"approve\"")));
    strict_1.default.ok(fsLog.writes.some((w) => w.path === `${runHome}\\config.toml` && w.contents.includes("[mcp_servers.dreamgraph.tools.run_command]")));
    strict_1.default.ok(fsLog.writes.some((w) => w.path === `${scratch}\\request.json` && w.contents.includes("outputLastMessagePath")));
    strict_1.default.ok(fsLog.writes.some((w) => w.path === `${scratch}\\request.json` && w.contents.includes("\"auth.json\"")));
    strict_1.default.equal(processLog.spawnCalls.length, 1);
    const spawned = processLog.spawnCalls[0];
    strict_1.default.equal(spawned.command, "C:\\bin\\codex.cmd");
    strict_1.default.equal(spawned.stdin, defaultInput().prompt);
    strict_1.default.equal(spawned.env.CODEX_HOME, runHome);
    strict_1.default.deepEqual([...spawned.args].slice(0, 12), ["--ask-for-approval", "never", "exec", "--json", "--cd", fsLog.mkdtemp[0], "--sandbox", "read-only", "--model", "gpt-5.5", "--profile", "dreamgraph"]);
    strict_1.default.equal(spawned.args[3], "--json");
    strict_1.default.equal(spawned.args.includes("--output-format"), false);
    strict_1.default.ok(spawned.args.includes("--skip-git-repo-check"));
    strict_1.default.equal(spawned.args.includes("--ignore-user-config"), false);
    strict_1.default.ok(spawned.args.includes("--ignore-rules"));
    strict_1.default.ok(spawned.args.includes("--ephemeral"));
    strict_1.default.deepEqual(spawned.args.filter((arg, index, args) => arg === "-c" && args[index + 1]?.startsWith("mcp_servers.dreamgraph.")), []);
    strict_1.default.deepEqual(spawned.args.filter((arg, index, args) => arg === "-c" && args[index + 1] === "model_reasoning_effort=\"xhigh\""), ["-c"]);
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
(0, node_test_1.default)("codex orchestrator: empty invocation cwd uses neutral probe cwd and scratch exec cwd", async () => {
    const { fs, log: fsLog } = makeFakeFs();
    const { process, log: processLog } = makeFakeProcess();
    const result = await (0, index_js_1.runCodexCli)(defaultInput({ invocationCwd: "" }), makeDeps({ fs, process }));
    strict_1.default.equal(result.ok, true);
    strict_1.default.deepEqual(processLog.rootHelpCwds, [FAKE_HOME_DIR]);
    strict_1.default.deepEqual(processLog.execHelpCwds, [FAKE_HOME_DIR]);
    strict_1.default.deepEqual(processLog.loginStatusCwds, [FAKE_HOME_DIR]);
    const scratch = fsLog.mkdtemp[0];
    const spawned = processLog.spawnCalls[0];
    strict_1.default.equal(spawned.cwd, scratch);
    strict_1.default.ok(spawned.args.includes("--cd"));
    strict_1.default.equal(spawned.args[spawned.args.indexOf("--cd") + 1], scratch);
    strict_1.default.ok(fsLog.writes.some((w) => w.path === `${scratch}\\request.json` && w.contents.includes("\"invocationCwd\": null")));
    strict_1.default.ok(fsLog.writes.some((w) => w.path === `${scratch}\\request.json` && w.contents.includes(`"probeCwd": "${FAKE_HOME_DIR.replace(/\\/g, "\\\\")}"`)));
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
(0, node_test_1.default)("codex orchestrator: transcript-only DreamGraph MCP events fail closed without audit results", async () => {
    const { process, log } = makeFakeProcess({
        spawnResult: {
            stdout: [
                JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
                JSON.stringify({ type: "turn.started" }),
                JSON.stringify({
                    type: "mcp_tool_call.completed",
                    tool: "dreamgraph.cognitive_status",
                }),
                JSON.stringify({
                    type: "item.completed",
                    item: {
                        id: "item_0",
                        type: "agent_message",
                        text: "Graph health could not be retrieved because the cognitive_status MCP call was cancelled before returning data.\n\nResult: user cancelled MCP tool call",
                    },
                }),
                JSON.stringify({ type: "turn.completed" }),
            ].join("\n"),
        },
    });
    const { port: mcpAudit, log: auditLog } = makeFakeAudit([]);
    const result = await (0, index_js_1.runCodexCli)(defaultInput(), makeDeps({ process, mcpAudit }));
    strict_1.default.equal(log.spawnCalls.length, 1);
    strict_1.default.deepEqual(auditLog.finishes, ["codex-run-001"]);
    strict_1.default.equal(result.ok, false);
    strict_1.default.equal(result.failure?.code, "MCP_PROBE_FAILED");
    strict_1.default.equal(result.failure?.cause, "mcp-load-failed");
    strict_1.default.equal(result.toolCalls.length, 0);
    strict_1.default.deepEqual([...(result.transcript?.toolCalls ?? [])], [
        { server: "dreamgraph", tool: "cognitive_status" },
    ]);
    strict_1.default.deepEqual(result.toolCallWitnesses.map((w) => `${w.server}:${w.tool}:${w.status}`), [
        "dreamgraph:cognitive_status:completed",
    ]);
    strict_1.default.match(result.failure.message, /transcript-only MCP events/);
    strict_1.default.match(result.failure.message, /user cancelled MCP tool call/);
});
(0, node_test_1.default)("codex orchestrator: cancelled DreamGraph MCP result without audit result fails closed", async () => {
    const { process, log } = makeFakeProcess({
        spawnResult: {
            stdout: [
                JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
                JSON.stringify({ type: "turn.started" }),
                JSON.stringify({
                    type: "item.completed",
                    item: {
                        id: "item_0",
                        type: "mcp_tool_call",
                        server: "dreamgraph",
                        tool: "cognitive_status",
                        status: "failed",
                        aggregated_output: "user cancelled MCP tool call",
                    },
                }),
                JSON.stringify({
                    type: "item.completed",
                    item: {
                        id: "item_1",
                        type: "agent_message",
                        text: "Speculative synthesis: no strong verification signals were detected.",
                    },
                }),
                JSON.stringify({ type: "turn.completed" }),
            ].join("\n"),
        },
    });
    const { port: mcpAudit, log: auditLog } = makeFakeAudit([]);
    const result = await (0, index_js_1.runCodexCli)(defaultInput(), makeDeps({ process, mcpAudit }));
    strict_1.default.equal(log.spawnCalls.length, 1);
    strict_1.default.deepEqual(auditLog.finishes, ["codex-run-001"]);
    strict_1.default.equal(result.ok, false);
    strict_1.default.equal(result.failure?.code, "MCP_PROBE_FAILED");
    strict_1.default.equal(result.failure?.cause, "mcp-load-failed");
    strict_1.default.equal(result.toolCalls.length, 0);
    strict_1.default.deepEqual([...(result.transcript?.toolCalls ?? [])], []);
    strict_1.default.deepEqual(result.toolCallWitnesses.map((w) => `${w.server}:${w.tool}:${w.status}`), [
        "dreamgraph:cognitive_status:cancelled",
    ]);
    strict_1.default.equal(result.transcript?.assistantText, "Speculative synthesis: no strong verification signals were detected.");
    strict_1.default.match(result.failure.message, /user cancelled MCP tool call/);
});
(0, node_test_1.default)("codex orchestrator: audited read call clears MCP probe even with transcript witness noise", async () => {
    const { process } = makeFakeProcess({
        spawnResult: {
            stdout: [
                JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
                JSON.stringify({ type: "turn.started" }),
                JSON.stringify({
                    type: "item.completed",
                    item: {
                        id: "item_0",
                        type: "mcp_tool_call",
                        server: "dreamgraph",
                        tool: "query_resource",
                        status: "failed",
                        aggregated_output: "user cancelled MCP tool call",
                    },
                }),
                JSON.stringify({
                    type: "item.completed",
                    item: { id: "item_1", type: "agent_message", text: "Verified graph read completed." },
                }),
                JSON.stringify({ type: "turn.completed" }),
            ].join("\n"),
        },
    });
    const { port: mcpAudit } = makeFakeAudit([
        {
            server: "dreamgraph",
            tool: "query_resource",
            inputJson: "{\"uri\":\"system://overview\"}",
            resultJson: "{\"ok\":true}",
            isError: false,
            durationMs: 5,
            startedAtEpochMs: 1,
        },
    ]);
    const result = await (0, index_js_1.runCodexCli)(defaultInput(), makeDeps({ process, mcpAudit }));
    strict_1.default.equal(result.ok, true);
    strict_1.default.equal(result.failure, undefined);
    strict_1.default.equal(result.toolCalls.length, 1);
    strict_1.default.equal(result.toolCalls[0].call.tool, "query_resource");
    strict_1.default.equal(result.toolCalls[0].classification, "dreamgraph_authoritative");
    strict_1.default.deepEqual(result.toolCallWitnesses.map((w) => `${w.server}:${w.tool}:${w.status}`), [
        "dreamgraph:query_resource:cancelled",
    ]);
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
(0, node_test_1.default)("codex orchestrator: usage limit after audited DreamGraph tools is not classified as login failure", async () => {
    const recorded = makeRecordedDreamGraphCalls(27);
    const usageMessage = "Turn error: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 2:45 PM.";
    const { process } = makeFakeProcess({
        spawnResult: {
            stdout: [
                JSON.stringify({ type: "turn.started" }),
                JSON.stringify({
                    type: "item.completed",
                    item: { id: "item_0", type: "agent_message", text: "I checked the graph and started reconciling." },
                }),
                JSON.stringify({ type: "turn.failed", error: { code: "rate_limit", message: usageMessage } }),
            ].join("\n"),
            stderr: "<!DOCTYPE html><html><head><title>403 Forbidden</title></head><body>Cloudflare /backend-api/plugins/featured</body></html>",
            exitCode: 1,
        },
    });
    const { port: mcpAudit } = makeFakeAudit(recorded);
    const result = await (0, index_js_1.runCodexCli)(defaultInput(), makeDeps({ process, mcpAudit }));
    strict_1.default.equal(result.ok, false);
    strict_1.default.equal(result.failure?.code, "CODEX_USAGE_LIMIT");
    strict_1.default.equal(result.failure?.cause, "usage-limit");
    strict_1.default.match(result.failure.message, /27 successful DreamGraph tool calls/);
    strict_1.default.match(result.failure.message, /Wait until 2:45 PM/);
    strict_1.default.match(result.failure.message, /No login action is needed/);
    strict_1.default.doesNotMatch(result.failure.message, /CODEX_NOT_LOGGED_IN/);
    strict_1.default.equal(result.toolCalls.length, 27);
    strict_1.default.equal(result.transcript?.assistantText, "I checked the graph and started reconciling.");
    strict_1.default.equal(result.transcript?.pluginSyncWarnings.length, 1);
    strict_1.default.ok(result.transcript?.diagnostics.every((line) => !line.includes("<!DOCTYPE html>")));
});
(0, node_test_1.default)("codex orchestrator: source snippets mentioning usage limit do not override policy/tool failures", async () => {
    const stderr = [
        "extensions/vscode/src/chat-panel.ts:1697: console.warn('[DreamGraph][codex-cli] onToolCall handler failed:', liveErr);",
        "extensions/vscode/src/test/codex-cli-orchestrator.test.ts:665:test(\"codex orchestrator: usage limit after audited DreamGraph tools is not classified as login failure\", async () => {",
        "2026-05-24T17:47:12.586643Z ERROR codex_core::tools::router: error=\"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -Command 'node --test dist/test/codex-cli-adapter.test.js' rejected: blocked by policy",
        "mcp_tool_call failed: dreamgraph.query_resource",
        "mcp_tool_call failed: dreamgraph.search_source_code",
    ].join("\n");
    const { process } = makeFakeProcess({
        spawnResult: {
            stderr,
            exitCode: 1,
        },
    });
    const result = await (0, index_js_1.runCodexCli)(defaultInput(), makeDeps({ process }));
    strict_1.default.equal(result.ok, false);
    strict_1.default.equal(result.failure?.code, "CODEX_POLICY_DENIED");
    strict_1.default.notEqual(result.failure?.code, "CODEX_USAGE_LIMIT");
    strict_1.default.equal(result.transcript?.usageLimit, null);
    strict_1.default.deepEqual(result.toolCallWitnesses.map((w) => `${w.server}:${w.tool}:${w.status}`), [
        "dreamgraph:query_resource:failed",
        "dreamgraph:search_source_code:failed",
    ]);
    strict_1.default.ok(result.transcript?.diagnostics.every((line) => !line.includes("usage limit after audited")));
});
(0, node_test_1.default)("codex orchestrator: telemetry unknown terminal type is not unsupported model and failure tail stays compact", async () => {
    const recorded = makeRecordedDreamGraphCalls(45);
    const stderr = [
        '2026-05-22T16:00:18.506798Z INFO session_loop{thread_id=abc}:turn{model=gpt-5.4}:model_client.stream_responses_websocket{model=gpt-5.4 wire_api=responses transport="responses_websocket"}: terminal.type=unknown model=gpt-5.4 slug=gpt-5.4 user.account_id="acct" user.email="person@example.com"',
        '2026-05-22T16:00:18.514472Z INFO codex_otel.log_only: event.name="codex.sse_event" event.kind=response.completed input_token_count=103247 output_token_count=1769 cached_token_count=101248 reasoning_token_count=361 tool_token_count=105016 terminal.type=unknown model=gpt-5.4 slug=gpt-5.4 user.account_id="acct" user.email="person@example.com"',
        "mcp_tool_call failed: dreamgraph.search_source_code",
        "mcp_tool_call failed: dreamgraph.discipline_record_tool_call",
    ].join("\n");
    const { process } = makeFakeProcess({
        spawnResult: {
            stdout: JSON.stringify({
                type: "item.completed",
                item: { id: "item_0", type: "agent_message", text: "Partial assessment." },
            }),
            stderr,
            exitCode: 1,
        },
    });
    const { port: mcpAudit } = makeFakeAudit(recorded);
    const result = await (0, index_js_1.runCodexCli)(defaultInput(), makeDeps({ process, mcpAudit }));
    strict_1.default.equal(result.ok, false);
    strict_1.default.equal(result.failure?.code, "CODEX_RUN_NONZERO_EXIT");
    strict_1.default.notEqual(result.failure?.code, "CODEX_MODEL_UNSUPPORTED");
    strict_1.default.match(result.failure.message, /45 successful DreamGraph tool calls/);
    strict_1.default.match(result.failure.message, /mcp_tool_call failed: dreamgraph\.search_source_code/);
    strict_1.default.doesNotMatch(result.failure.message, /model_client\.stream_responses_websocket/);
    strict_1.default.doesNotMatch(result.failure.message, /user\.email/);
    strict_1.default.equal(result.transcript?.usage?.inputTokens, 103247);
    strict_1.default.equal(result.toolCalls.length, 45);
});
(0, node_test_1.default)("codex orchestrator: inspected source mentioning unsupported model does not poison failure classification", async () => {
    const recorded = makeRecordedDreamGraphCalls(18);
    const inspectedTestPayload = JSON.stringify([
        {
            type: "text",
            text: "test(\"unsupported model remains model-unsupported / nonzero model failure\", () => {\n" +
                "  assert.equal(result.failure?.code, \"CODEX_MODEL_UNSUPPORTED\");\n" +
                "});",
        },
    ]);
    const { process } = makeFakeProcess({
        spawnResult: {
            stdout: [
                JSON.stringify({
                    type: "item.completed",
                    item: { id: "item_0", type: "agent_message", text: "Adapter evidence was collected." },
                }),
                inspectedTestPayload,
            ].join("\n"),
            stderr: "<!DOCTYPE html><html><body>Cloudflare /backend-api/plugins/featured 403 Forbidden</body></html>",
            exitCode: 1,
        },
    });
    const { port: mcpAudit } = makeFakeAudit(recorded);
    const result = await (0, index_js_1.runCodexCli)(defaultInput(), makeDeps({ process, mcpAudit }));
    strict_1.default.equal(result.ok, false);
    strict_1.default.equal(result.failure?.code, "CODEX_RUN_NONZERO_EXIT");
    strict_1.default.notEqual(result.failure?.code, "CODEX_MODEL_UNSUPPORTED");
    strict_1.default.equal(result.toolCalls.length, 18);
    strict_1.default.equal(result.transcript?.modelUnsupported, false);
    strict_1.default.deepEqual([...(result.transcript?.pluginSyncWarnings ?? [])], [
        "codex plugin sync warning: remote plugin catalog request returned 403/Cloudflare HTML; suppressed verbose HTML diagnostic",
    ]);
});
(0, node_test_1.default)("codex orchestrator: audited DreamGraph success suppresses false exec login classification", async () => {
    const recorded = makeRecordedDreamGraphCalls(1);
    const { process } = makeFakeProcess({
        spawnResult: {
            stdout: JSON.stringify({
                type: "item.completed",
                item: { id: "item_0", type: "agent_message", text: "Graph evidence was collected." },
            }),
            stderr: "Error: not logged in. Please run codex login.\n",
            exitCode: 1,
        },
    });
    const { port: mcpAudit } = makeFakeAudit(recorded);
    const result = await (0, index_js_1.runCodexCli)(defaultInput(), makeDeps({ process, mcpAudit }));
    strict_1.default.equal(result.ok, false);
    strict_1.default.equal(result.failure?.code, "CODEX_RUN_NONZERO_EXIT");
    strict_1.default.notEqual(result.failure?.code, "CODEX_NOT_LOGGED_IN");
    strict_1.default.equal(result.toolCalls.length, 1);
});
(0, node_test_1.default)("codex orchestrator: failed read_source_code schema args are not classified as missing tool", async () => {
    const { process } = makeFakeProcess({
        spawnResult: {
            stdout: [
                JSON.stringify({ type: "turn.started" }),
                JSON.stringify({
                    type: "item.completed",
                    item: {
                        id: "item_0",
                        type: "mcp_tool_call",
                        server: "dreamgraph",
                        tool: "read_source_code",
                        status: "failed",
                        aggregated_output: "Invalid arguments: missing required property filePath",
                    },
                }),
                JSON.stringify({
                    type: "item.completed",
                    item: { id: "item_1", type: "agent_message", text: "The focused read failed." },
                }),
            ].join("\n"),
            exitCode: 1,
        },
    });
    const result = await (0, index_js_1.runCodexCli)(defaultInput(), makeDeps({ process }));
    strict_1.default.equal(result.ok, false);
    strict_1.default.equal(result.failure?.code, "DREAMGRAPH_TOOL_SCHEMA_ARGS");
    strict_1.default.equal(result.failure?.cause, "schema-args-failure");
    strict_1.default.doesNotMatch(result.failure.message, /missing tool/i);
    strict_1.default.match(result.failure.message, /retry with the required arguments/i);
    strict_1.default.equal(result.toolCalls.length, 0);
});
(0, node_test_1.default)("codex orchestrator: unsupported model and native policy denial are not login failures", async () => {
    const unsupported = makeFakeProcess({
        spawnResult: {
            stdout: JSON.stringify({ type: "error", code: "unsupported_model", message: "Unsupported model: gpt-404" }),
            exitCode: 1,
        },
    });
    const unsupportedResult = await (0, index_js_1.runCodexCli)(defaultInput(), makeDeps({ process: unsupported.process }));
    strict_1.default.equal(unsupportedResult.failure?.code, "CODEX_MODEL_UNSUPPORTED");
    strict_1.default.notEqual(unsupportedResult.failure?.code, "CODEX_NOT_LOGGED_IN");
    const policy = makeFakeProcess({
        spawnResult: {
            stderr: "2026-05-21T13:34:30.489369Z ERROR codex_core::tools::router: rejected: blocked by policy\n",
            exitCode: 1,
        },
    });
    const policyResult = await (0, index_js_1.runCodexCli)(defaultInput(), makeDeps({ process: policy.process }));
    strict_1.default.equal(policyResult.failure?.code, "CODEX_POLICY_DENIED");
    strict_1.default.equal(policyResult.failure?.cause, "provider-native-restriction");
    strict_1.default.match(policyResult.failure.message, /does not mean DreamGraph MCP tools are unavailable/);
    strict_1.default.match(policyResult.failure.message, /dreamgraph:run_command/);
    strict_1.default.notEqual(policyResult.failure?.code, "CODEX_NOT_LOGGED_IN");
});
(0, node_test_1.default)("codex orchestrator: read-only sandbox MCP block is policy denial, not audit mismatch", async () => {
    const { process } = makeFakeProcess({
        spawnResult: {
            stderr: "2026-05-24T13:14:01.146304Z ERROR codex_core::tools::router: error=patch rejected: writing is blocked by read-only sandbox; rejected by user approval settings\n" +
                "mcp_tool_call failed: dreamgraph.query_resource\n" +
                "mcp_tool_call failed: dreamgraph.run_command\n",
            exitCode: 0,
        },
    });
    const result = await (0, index_js_1.runCodexCli)(defaultInput(), makeDeps({ process }));
    strict_1.default.equal(result.ok, false);
    strict_1.default.equal(result.failure?.code, "CODEX_POLICY_DENIED");
    strict_1.default.equal(result.failure?.cause, "provider-native-restriction");
    strict_1.default.notEqual(result.failure?.code, "MCP_PROBE_FAILED");
    strict_1.default.match(result.failure.message, /DreamGraph MCP tools are unavailable/);
    strict_1.default.match(result.failure.message, /dreamgraph:run_command/);
    strict_1.default.equal(result.toolCalls.length, 0);
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
    await strict_1.default.rejects(() => (0, index_js_1.runCodexCli)(defaultInput({ timeoutMs: 0 }), makeDeps()), /timeoutMs must be > 0/);
});
//# sourceMappingURL=codex-cli-orchestrator.test.js.map