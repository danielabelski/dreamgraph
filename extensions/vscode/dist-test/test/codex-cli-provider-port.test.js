"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Codex CLI adapter - Slice 4 ProviderPort tests.
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
function commandResult(over = {}) {
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
function makeFakeFs() {
    let counter = 0;
    return {
        async mkdtemp(prefix) {
            counter += 1;
            return `C:\\Temp\\${prefix}${counter}`;
        },
        async mkdir() { },
        async writeFile() { },
        async readFileUtf8() {
            return null;
        },
        async rmRecursive() { },
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
function spawnResult(over = {}) {
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
function makeFakeProcess(opts = {}) {
    const log = { spawnCalls: [] };
    const process = {
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
function makeFakeCrypto() {
    return {
        randomToken() {
            return "tok-codex";
        },
        randomRunId() {
            return "codex-run-provider";
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
function makeFakeAudit() {
    return {
        async startRecording() { },
        async finishRecording() {
            return [];
        },
    };
}
function makeDeps(over = {}) {
    return {
        fs: over.fs ?? makeFakeFs(),
        process: over.process ?? makeFakeProcess().process,
        crypto: over.crypto ?? makeFakeCrypto(),
        clock: over.clock ?? makeFakeClock(),
        registry: over.registry ?? makeFakeRegistry(),
        mcpAudit: over.mcpAudit ?? makeFakeAudit(),
    };
}
const FAKE_LLM = { provider: "openai" };
function makeCallInput(over = {}) {
    const conversation = [
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
(0, node_test_1.default)("codex provider-port: getCapabilities reports text-only / images-disabled", () => {
    const port = (0, index_js_1.createCodexCliProviderPort)({
        hostLlm: FAKE_LLM,
        invocationCwd: "C:\\work",
        timeoutMs: 60_000,
        baseEnv: { PATH: "C:\\bin" },
        deps: makeDeps(),
    });
    strict_1.default.deepEqual(port.getCapabilities(), { textAttachments: false, imageAttachments: false });
    strict_1.default.equal(port.llm, FAKE_LLM);
});
(0, node_test_1.default)("codex provider-port: invocation cwd is optional for multi-repo DreamGraph runs", async () => {
    const proc = makeFakeProcess();
    const port = (0, index_js_1.createCodexCliProviderPort)({
        hostLlm: FAKE_LLM,
        timeoutMs: 30_000,
        baseEnv: { PATH: "C:\\bin" },
        deps: makeDeps({ process: proc.process }),
    });
    await port.callProvider(makeCallInput());
    strict_1.default.equal(proc.log.spawnCalls.length, 1);
    strict_1.default.match(proc.log.spawnCalls[0].cwd, /^C:\\Temp\\dreamgraph-codex-cli-run-/);
    strict_1.default.ok(proc.log.spawnCalls[0].args.includes("--cd"));
    strict_1.default.match(proc.log.spawnCalls[0].args[proc.log.spawnCalls[0].args.indexOf("--cd") + 1] ?? "", /^C:\\Temp\\dreamgraph-codex-cli-run-/);
});
(0, node_test_1.default)("codex provider-port: serializes conversation to stdin and projects proposal", async () => {
    const proc = makeFakeProcess();
    const port = (0, index_js_1.createCodexCliProviderPort)({
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
    strict_1.default.equal(proc.log.spawnCalls.length, 1);
    const spawn = proc.log.spawnCalls[0];
    strict_1.default.match(spawn.cwd, /^C:\\Temp\\dreamgraph-codex-cli-run-/);
    strict_1.default.equal(spawn.env.FOO, "bar");
    strict_1.default.match(spawn.env.CODEX_HOME, /dreamgraph-codex-cli-run-.*\\codex-home$/);
    strict_1.default.match(spawn.stdin, /\[system\]\nyou are an architect/);
    strict_1.default.match(spawn.stdin, /\[user\]\n===== CURRENT TURN[\s\S]*\ndesign a queue\n===== END CURRENT TURN =====/);
    strict_1.default.ok(spawn.args.includes("--model"));
    strict_1.default.ok(spawn.args.includes("gpt-5.5"));
    strict_1.default.ok(spawn.args.includes("--profile"));
    strict_1.default.equal(spawn.args[spawn.args.length - 1], "-");
    strict_1.default.equal(spawn.idleTimeoutMs, 3_000);
    strict_1.default.equal(proposal.toolCalls.length, 0);
    strict_1.default.equal(proposal.response.toolCalls.length, 0);
    strict_1.default.equal(proposal.response.stopReason, "end_turn");
    strict_1.default.equal(proposal.response.content, "Slice 4 complete.");
});
(0, node_test_1.default)("codex provider-port: advertises DreamGraph prompt policies and diagnostics", async () => {
    const proc = makeFakeProcess();
    const diagnostics = [];
    const port = (0, index_js_1.createCodexCliProviderPort)({
        hostLlm: FAKE_LLM,
        invocationCwd: "C:\\work\\repo",
        timeoutMs: 30_000,
        baseEnv: { PATH: "C:\\bin" },
        deps: makeDeps({ process: proc.process }),
        cliToolsManifest: {
            server: "dreamgraph",
            tools: index_js_1.CODEX_AUTHORITATIVE_TOOL_CATALOG,
        },
        onPromptComposed: (info) => diagnostics.push(info),
    });
    await port.callProvider(makeCallInput());
    const prompt = proc.log.spawnCalls[0].stdin;
    strict_1.default.match(prompt, /Available dreamgraph tools/);
    strict_1.default.match(prompt, /  - query_resource/);
    strict_1.default.match(prompt, /  - edit_entity/);
    strict_1.default.match(prompt, /  - run_command/);
    strict_1.default.match(prompt, /dreamgraph:run_command .*available.*ONLY supported shell execution route/);
    strict_1.default.match(prompt, /File\/entity mutations\s+-> prefer dreamgraph:edit_entity/);
    strict_1.default.match(prompt, /Verification \/ build \/ tests\s+-> dreamgraph:run_command/);
    strict_1.default.match(prompt, /Codex CLI adapter authority override/);
    strict_1.default.match(prompt, /ADR-aware task policy: for every repository task/);
    strict_1.default.match(prompt, /Graph sync policy: after any source or project-state mutation/);
    strict_1.default.match(prompt, /HARD DENIAL .* DO NOT EXIST in this Codex run .* cli:powershell, cli:bash, cli:cmd/);
    strict_1.default.ok(!proc.log.spawnCalls[0].args.includes("--image"));
    strict_1.default.equal(diagnostics.length, 1);
    strict_1.default.equal(diagnostics[0].mcpServerAdvertised, "dreamgraph");
    strict_1.default.ok(diagnostics[0].mcpToolsAdvertised > index_js_1.CODEX_MINIMUM_AUTHORITATIVE_TOOLS.length);
});
(0, node_test_1.default)("codex provider-port: keeps bridge-local run_command visible with read-only upstream tools", async () => {
    const proc = makeFakeProcess();
    const port = (0, index_js_1.createCodexCliProviderPort)({
        hostLlm: FAKE_LLM,
        invocationCwd: "C:\\work\\repo",
        timeoutMs: 30_000,
        baseEnv: { PATH: "C:\\bin" },
        deps: makeDeps({
            process: proc.process,
            registry: makeFakeRegistry(index_js_1.CODEX_MINIMUM_AUTHORITATIVE_TOOLS),
        }),
        cliToolsManifest: {
            server: "dreamgraph",
            tools: index_js_1.CODEX_AUTHORITATIVE_TOOL_CATALOG,
        },
    });
    await port.callProvider(makeCallInput());
    const prompt = proc.log.spawnCalls[0].stdin;
    strict_1.default.match(prompt, /  - query_resource/);
    strict_1.default.match(prompt, /  - run_command/);
    strict_1.default.match(prompt, /dreamgraph:run_command .*available.*ONLY supported shell execution route/);
    strict_1.default.match(prompt, /Verification \/ build \/ tests\s+-> dreamgraph:run_command/);
});
(0, node_test_1.default)("codex provider-port: forwards assistant text through onStreamChunk", async () => {
    const port = (0, index_js_1.createCodexCliProviderPort)({
        hostLlm: FAKE_LLM,
        invocationCwd: "C:\\work",
        timeoutMs: 30_000,
        baseEnv: {},
        deps: makeDeps(),
    });
    const chunks = [];
    await port.callProvider(makeCallInput({ onStreamChunk: (chunk) => chunks.push(chunk) }));
    strict_1.default.deepEqual(chunks, ["Slice 4 complete."]);
});
(0, node_test_1.default)("codex provider-port: streams Codex assistant deltas live without duplicating final text", async () => {
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
    const port = (0, index_js_1.createCodexCliProviderPort)({
        hostLlm: FAKE_LLM,
        invocationCwd: "C:\\work",
        timeoutMs: 30_000,
        baseEnv: {},
        deps: makeDeps({ process: proc.process }),
    });
    const chunks = [];
    const proposal = await port.callProvider(makeCallInput({ onStreamChunk: (chunk) => chunks.push(chunk) }));
    strict_1.default.deepEqual(chunks, ["Graph", " health"]);
    strict_1.default.equal(proposal.response.content, "Graph health");
});
(0, node_test_1.default)("codex provider-port: streams completed assistant message when no deltas are available", async () => {
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
    const port = (0, index_js_1.createCodexCliProviderPort)({
        hostLlm: FAKE_LLM,
        invocationCwd: "C:\\work",
        timeoutMs: 30_000,
        baseEnv: {},
        deps: makeDeps({ process: proc.process }),
    });
    const chunks = [];
    const proposal = await port.callProvider(makeCallInput({ onStreamChunk: (chunk) => chunks.push(chunk) }));
    strict_1.default.deepEqual(chunks, ["Completed message."]);
    strict_1.default.equal(proposal.response.content, "Completed message.");
});
(0, node_test_1.default)("codex provider-port: provider errors carry deterministic metadata", async () => {
    const port = (0, index_js_1.createCodexCliProviderPort)({
        hostLlm: FAKE_LLM,
        invocationCwd: "C:\\work",
        timeoutMs: 30_000,
        baseEnv: {},
        deps: makeDeps({ process: makeFakeProcess({ resolve: null }).process }),
    });
    await strict_1.default.rejects(port.callProvider(makeCallInput()), (err) => {
        strict_1.default.ok(err instanceof Error);
        strict_1.default.match(err.message, /CODEX_CLI_NOT_FOUND/);
        const tagged = err;
        strict_1.default.equal(tagged.codexCliFailureCode, "CODEX_CLI_NOT_FOUND");
        strict_1.default.ok(tagged.codexCliRunResult);
        return true;
    });
});
(0, node_test_1.default)("codex provider-port: streams live audit calls before final run reconciliation", async () => {
    const observed = [];
    const liveCall = Object.freeze({
        server: "dreamgraph",
        tool: "query_resource",
        inputJson: "{\"uri\":\"system://overview\"}",
        resultJson: "{\"success\":true}",
        isError: false,
        durationMs: 12,
        startedAtEpochMs: 1_800_000_000_123,
    });
    const port = (0, index_js_1.createCodexCliProviderPort)({
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
    strict_1.default.deepEqual(observed, [
        "subscribe:codex-run-provider",
        "tool:codex-run-provider:dreamgraph:query_resource",
        "close",
        "result:codex-run-provider:true",
    ]);
});
(0, node_test_1.default)("codex provider-port: streams transcript MCP witnesses when audit records are absent", async () => {
    const observed = [];
    const stderr = "mcp_tool_call failed: dreamgraph.query_resource\n";
    const proc = makeFakeProcess({
        stderrChunks: [stderr],
        spawnResult: {
            stderr,
            exitCode: 1,
        },
    });
    const port = (0, index_js_1.createCodexCliProviderPort)({
        hostLlm: FAKE_LLM,
        invocationCwd: "C:\\work",
        timeoutMs: 30_000,
        baseEnv: {},
        deps: makeDeps({ process: proc.process }),
        onToolWitness: (runId, witness) => observed.push(`witness:${runId}:${witness.server}:${witness.tool}:${witness.status}`),
        onRunResult: (result) => observed.push(`result:${result.runId}:${result.ok}:${result.toolCallWitnesses.length}`),
    });
    await strict_1.default.rejects(port.callProvider(makeCallInput()));
    strict_1.default.deepEqual(observed, [
        "witness:codex-run-provider:dreamgraph:query_resource:failed",
        "result:codex-run-provider:false:1",
    ]);
});
(0, node_test_1.default)("codex provider-port: onRunResult fires for ok and failed runs", async () => {
    const results = [];
    const okPort = (0, index_js_1.createCodexCliProviderPort)({
        hostLlm: FAKE_LLM,
        invocationCwd: "C:\\work",
        timeoutMs: 30_000,
        baseEnv: {},
        deps: makeDeps(),
        onRunResult: (result) => results.push(result.ok),
    });
    await okPort.callProvider(makeCallInput());
    const failPort = (0, index_js_1.createCodexCliProviderPort)({
        hostLlm: FAKE_LLM,
        invocationCwd: "C:\\work",
        timeoutMs: 30_000,
        baseEnv: {},
        deps: makeDeps({ process: makeFakeProcess({ resolve: null }).process }),
        onRunResult: (result) => results.push(result.ok),
    });
    await strict_1.default.rejects(failPort.callProvider(makeCallInput()));
    strict_1.default.deepEqual(results, [true, false]);
});
(0, node_test_1.default)("codex provider-port: rejects missing or malformed options", () => {
    // @ts-expect-error testing invalid input
    strict_1.default.throws(() => (0, index_js_1.createCodexCliProviderPort)());
    strict_1.default.throws(() => (0, index_js_1.createCodexCliProviderPort)({
        hostLlm: FAKE_LLM,
        // @ts-expect-error testing invalid input
        invocationCwd: 42,
        timeoutMs: 1,
        baseEnv: {},
        deps: makeDeps(),
    }));
    strict_1.default.throws(() => (0, index_js_1.createCodexCliProviderPort)({
        hostLlm: FAKE_LLM,
        invocationCwd: "C:\\work",
        timeoutMs: 0,
        baseEnv: {},
        deps: makeDeps(),
    }));
    // @ts-expect-error missing hostLlm
    const missingHostLlm = {
        invocationCwd: "C:\\work",
        timeoutMs: 100,
        baseEnv: {},
        deps: makeDeps(),
    };
    strict_1.default.throws(() => (0, index_js_1.createCodexCliProviderPort)(missingHostLlm));
});
//# sourceMappingURL=codex-cli-provider-port.test.js.map