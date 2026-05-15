"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const index_js_1 = require("../architect-core/adapters/copilot-cli/index.js");
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
function makeFakeFs() {
    let counter = 0;
    return {
        async mkdtemp(prefix) {
            return `/tmp/${prefix}${++counter}`;
        },
        async mkdir() { },
        async writeFile() { },
        async rmRecursive() { },
        async copyDirRecursive() { },
        async readFileUtf8(path) {
            // Pretend the persistent Copilot config records a logged-in user
            // so the orchestrator's pre-spawn login check passes. Anything
            // else is reported absent.
            if (path.endsWith("/.copilot/config.json"))
                return LOGGED_IN_CONFIG_JSON;
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
function makeFakeProcess(opts = {}) {
    const log = { spawnCalls: [] };
    const port = {
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
function makeFakeCrypto() {
    return {
        randomToken() {
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
            const v = t;
            t += 50;
            return v;
        },
    };
}
function makeFakeRegistry() {
    return {
        async listAuthoritativeToolNames() {
            return [...index_js_1.COPILOT_REQUIRED_AUTHORITATIVE_TOOLS];
        },
        async describeBridgeSpawn() {
            return { command: "node", args: ["./mcp-bridge.js"], env: {} };
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
        process: over.process ?? makeFakeProcess().port,
        crypto: over.crypto ?? makeFakeCrypto(),
        clock: over.clock ?? makeFakeClock(),
        registry: over.registry ?? makeFakeRegistry(),
        mcpAudit: over.mcpAudit ?? makeFakeAudit(),
    };
}
const FAKE_LLM = { provider: "anthropic" };
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
// ---------------------------------------------------------------------------
(0, node_test_1.default)("provider-port: getCapabilities reports text-only / images-disabled", () => {
    const port = (0, index_js_1.createCopilotCliProviderPort)({
        hostLlm: FAKE_LLM,
        invocationCwd: "/work",
        timeoutMs: 60_000,
        baseEnv: { PATH: "/usr/bin" },
        deps: makeDeps(),
    });
    const caps = port.getCapabilities();
    strict_1.default.equal(caps.textAttachments, false);
    strict_1.default.equal(caps.imageAttachments, false);
});
(0, node_test_1.default)("provider-port: exposes hostLlm reference verbatim through `llm`", () => {
    const port = (0, index_js_1.createCopilotCliProviderPort)({
        hostLlm: FAKE_LLM,
        invocationCwd: "/work",
        timeoutMs: 60_000,
        baseEnv: {},
        deps: makeDeps(),
    });
    strict_1.default.equal(port.llm, FAKE_LLM);
});
(0, node_test_1.default)("provider-port: callProvider serializes the conversation into --prompt", async () => {
    const proc = makeFakeProcess();
    const port = (0, index_js_1.createCopilotCliProviderPort)({
        hostLlm: FAKE_LLM,
        invocationCwd: "/work/run",
        timeoutMs: 30_000,
        baseEnv: { PATH: "/usr/bin", FOO: "bar" },
        deps: makeDeps({ process: proc.port }),
        model: "claude-sonnet-4.5",
    });
    const proposal = await port.callProvider(makeCallInput());
    strict_1.default.equal(proc.log.spawnCalls.length, 1);
    const spawn = proc.log.spawnCalls[0];
    // Prompt argv contains the serialized conversation including both
    // role headers and the system text.
    const promptArgIdx = spawn.args.findIndex((a) => a === "--prompt");
    strict_1.default.ok(promptArgIdx >= 0);
    const promptValue = spawn.args[promptArgIdx + 1];
    strict_1.default.match(promptValue, /\[system\]\nyou are an architect/);
    strict_1.default.match(promptValue, /\[user\]\ndesign a queue/);
    // Model flag forwarded.
    strict_1.default.ok(spawn.args.includes("--model"));
    strict_1.default.ok(spawn.args.includes("claude-sonnet-4.5"));
    // Cwd forwarded.
    strict_1.default.equal(spawn.cwd, "/work/run");
    // baseEnv flows through; the orchestrator pins COPILOT_HOME to a
    // per-run isolated copy of the user's source HOME so the per-run
    // `mcp-config.json` it writes there is the only manifest the CLI
    // sees while the persistent GitHub auth is preserved verbatim.
    strict_1.default.equal(spawn.env["FOO"], "bar");
    strict_1.default.match(spawn.env["COPILOT_HOME"], /dreamgraph-copilot-cli-run-.*\/copilot-home$/);
    // Proposal projection.
    strict_1.default.equal(proposal.toolCalls.length, 0);
    strict_1.default.equal(proposal.response.stopReason, "end_turn");
    strict_1.default.equal(proposal.response.content, "Plan complete.");
    strict_1.default.equal(proposal.response.toolCalls.length, 0);
});
(0, node_test_1.default)("provider-port: callProvider forwards onStreamChunk with full assistant text", async () => {
    const port = (0, index_js_1.createCopilotCliProviderPort)({
        hostLlm: FAKE_LLM,
        invocationCwd: "/work",
        timeoutMs: 30_000,
        baseEnv: {},
        deps: makeDeps(),
    });
    const chunks = [];
    await port.callProvider(makeCallInput({ onStreamChunk: (c) => chunks.push(c) }));
    strict_1.default.deepEqual(chunks, ["Plan complete."]);
});
(0, node_test_1.default)("provider-port: callProvider forwards abortSignal to the spawn port", async () => {
    const proc = makeFakeProcess();
    const port = (0, index_js_1.createCopilotCliProviderPort)({
        hostLlm: FAKE_LLM,
        invocationCwd: "/work",
        timeoutMs: 30_000,
        baseEnv: {},
        deps: makeDeps({ process: proc.port }),
    });
    const ac = new AbortController();
    await port.callProvider(makeCallInput({ abortSignal: ac.signal }));
    strict_1.default.equal(proc.log.spawnCalls[0].abortSignal, ac.signal);
});
(0, node_test_1.default)("provider-port: callProvider throws annotated Error when orchestrator returns ok=false", async () => {
    const port = (0, index_js_1.createCopilotCliProviderPort)({
        hostLlm: FAKE_LLM,
        invocationCwd: "/work",
        timeoutMs: 30_000,
        baseEnv: {},
        // No `copilot` binary on PATH → orchestrator returns COPILOT_CLI_NOT_FOUND.
        deps: makeDeps({ process: makeFakeProcess({ resolve: null }).port }),
    });
    await strict_1.default.rejects(port.callProvider(makeCallInput()), (err) => {
        strict_1.default.ok(err instanceof Error);
        strict_1.default.match(err.message, /COPILOT_CLI_NOT_FOUND/);
        const tagged = err;
        strict_1.default.equal(tagged.copilotCliFailureCode, "COPILOT_CLI_NOT_FOUND");
        return true;
    });
});
(0, node_test_1.default)("provider-port: onRunResult fires for both ok and failed runs", async () => {
    const okResults = [];
    const okPort = (0, index_js_1.createCopilotCliProviderPort)({
        hostLlm: FAKE_LLM,
        invocationCwd: "/work",
        timeoutMs: 30_000,
        baseEnv: {},
        deps: makeDeps(),
        onRunResult: (r) => okResults.push(r.ok ? 1 : 0),
    });
    await okPort.callProvider(makeCallInput());
    strict_1.default.deepEqual(okResults, [1]);
    const failResults = [];
    const failPort = (0, index_js_1.createCopilotCliProviderPort)({
        hostLlm: FAKE_LLM,
        invocationCwd: "/work",
        timeoutMs: 30_000,
        baseEnv: {},
        deps: makeDeps({ process: makeFakeProcess({ resolve: null }).port }),
        onRunResult: (r) => failResults.push(r.ok ? 1 : 0),
    });
    await strict_1.default.rejects(failPort.callProvider(makeCallInput()));
    strict_1.default.deepEqual(failResults, [0]);
});
(0, node_test_1.default)("provider-port: onRunResult exceptions are swallowed", async () => {
    const port = (0, index_js_1.createCopilotCliProviderPort)({
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
    strict_1.default.equal(proposal.response.content, "Plan complete.");
});
(0, node_test_1.default)("provider-port: rejects missing or malformed options", () => {
    // @ts-expect-error testing invalid input
    strict_1.default.throws(() => (0, index_js_1.createCopilotCliProviderPort)());
    strict_1.default.throws(() => (0, index_js_1.createCopilotCliProviderPort)({
        hostLlm: FAKE_LLM,
        invocationCwd: "",
        timeoutMs: 1,
        baseEnv: {},
        deps: makeDeps(),
    }));
    strict_1.default.throws(() => (0, index_js_1.createCopilotCliProviderPort)({
        hostLlm: FAKE_LLM,
        invocationCwd: "/x",
        timeoutMs: 0,
        baseEnv: {},
        deps: makeDeps(),
    }));
    strict_1.default.throws(() => (0, index_js_1.createCopilotCliProviderPort)({
        hostLlm: FAKE_LLM,
        invocationCwd: "/x",
        timeoutMs: Number.POSITIVE_INFINITY,
        baseEnv: {},
        deps: makeDeps(),
    }));
    // @ts-expect-error missing hostLlm
    const missingHostLlm = {
        invocationCwd: "/x",
        timeoutMs: 100,
        baseEnv: {},
        deps: makeDeps(),
    };
    strict_1.default.throws(() => (0, index_js_1.createCopilotCliProviderPort)(missingHostLlm));
});
//# sourceMappingURL=copilot-cli-provider-port.test.js.map