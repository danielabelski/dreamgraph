"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Codex CLI adapter - Slice 1 pure-module tests.
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
  mcp     Manage MCP servers
`;
const EXEC_HELP = `
Usage: codex exec [OPTIONS] [PROMPT]

Arguments:
  [PROMPT]  Prompt text. Use - to read the prompt from stdin.

Options:
      --json                                  Emit NDJSON events
  -m, --model <MODEL>                         Model identifier
  -C, --cd <DIR>                              Run as if Codex started in DIR
  -s, --sandbox <SANDBOX_MODE>
                                             Sandbox mode
                                             [possible values: read-only, workspace-write, danger-full-access]
  -a, --ask-for-approval <APPROVAL_POLICY>
                                             Approval mode

                                             Possible values:
                                             - untrusted:  Only run trusted commands without asking
                                             - on-failure: DEPRECATED: ask only after failures
                                             - on-request: The model decides when to ask
                                             - never:      Never ask for approval
  -c, --config <KEY=VALUE>                    Override config; repeatable
  -p, --profile <PROFILE>                     Named profile
      --add-dir <DIR>                         Add a directory
  -o, --output-last-message <PATH>            Write final assistant message
      --output-schema <PATH>                  Validate final output schema
      --skip-git-repo-check                   Run outside a git worktree
      --ignore-user-config                    Do not load user config
      --ephemeral                             Avoid persistence
      --full-auto                             Deprecated compatibility flag
      --dangerously-bypass-approvals-and-sandbox, --yolo
                                             Dangerous bypass
`;
const EXEC_HELP_WITHOUT_APPROVAL = `
Usage: codex exec [OPTIONS] [PROMPT]

Arguments:
  [PROMPT]  Initial instructions. Use - to read instructions from stdin.

Options:
      --json                                  Emit NDJSON events
  -m, --model <MODEL>                         Model identifier
  -C, --cd <DIR>                              Run as if Codex started in DIR
  -s, --sandbox <SANDBOX_MODE>
                                             Sandbox mode
                                             [possible values: read-only, workspace-write, danger-full-access]
  -c, --config <KEY=VALUE>                    Override config; repeatable
  -p, --profile <PROFILE>                     Named profile
      --add-dir <DIR>                         Add a directory
  -o, --output-last-message <PATH>            Write final assistant message
      --output-schema <PATH>                  Validate final output schema
      --skip-git-repo-check                   Run outside a git worktree
      --ignore-user-config                    Do not load user config
      --ephemeral                             Avoid persistence
`;
const EMPTY_HELP = "";
const FULL_SURFACE = (0, index_js_1.parseCodexHelpSurface)({
    rootHelpText: ROOT_HELP,
    execHelpText: EXEC_HELP,
    versionString: "codex 0.99.0",
});
(0, node_test_1.default)("help-probe: parses Codex root and exec surfaces", () => {
    strict_1.default.equal(FULL_SURFACE.versionString, "codex 0.99.0");
    strict_1.default.equal(FULL_SURFACE.root.execCommand, true);
    strict_1.default.equal(FULL_SURFACE.exec.positionalStdinPrompt, true);
    strict_1.default.equal(FULL_SURFACE.exec.json, true);
    strict_1.default.equal(FULL_SURFACE.exec.model, true);
    strict_1.default.equal(FULL_SURFACE.exec.cd, true);
    strict_1.default.equal(FULL_SURFACE.exec.sandbox, true);
    strict_1.default.equal(FULL_SURFACE.exec.askForApproval, true);
    strict_1.default.equal(FULL_SURFACE.exec.config, true);
    strict_1.default.equal(FULL_SURFACE.exec.profile, true);
    strict_1.default.equal(FULL_SURFACE.exec.addDir, true);
    strict_1.default.equal(FULL_SURFACE.exec.outputLastMessage, true);
    strict_1.default.equal(FULL_SURFACE.exec.outputSchema, true);
    strict_1.default.equal(FULL_SURFACE.exec.skipGitRepoCheck, true);
    strict_1.default.equal(FULL_SURFACE.exec.ignoreUserConfig, true);
    strict_1.default.equal(FULL_SURFACE.exec.ephemeral, true);
    strict_1.default.deepEqual([...FULL_SURFACE.safety.sandboxModes], ["read-only", "workspace-write", "danger-full-access"]);
    strict_1.default.deepEqual([...FULL_SURFACE.safety.approvalModes], ["untrusted", "on-failure", "on-request", "never"]);
    strict_1.default.equal(FULL_SURFACE.safety.fullAutoDeprecated, true);
    strict_1.default.equal(FULL_SURFACE.safety.dangerousBypass, true);
    strict_1.default.ok((0, index_js_1.isHelpSurfaceSupported)(FULL_SURFACE));
});
(0, node_test_1.default)("help-probe: supports Codex exec help without ask-for-approval", () => {
    const surface = (0, index_js_1.parseCodexHelpSurface)({
        rootHelpText: ROOT_HELP,
        execHelpText: EXEC_HELP_WITHOUT_APPROVAL,
    });
    strict_1.default.equal(surface.exec.askForApproval, false);
    strict_1.default.deepEqual([...surface.safety.approvalModes], []);
    strict_1.default.ok((0, index_js_1.isHelpSurfaceSupported)(surface));
});
(0, node_test_1.default)("help-probe: missing exec help fails the support check", () => {
    const surface = (0, index_js_1.parseCodexHelpSurface)({
        rootHelpText: ROOT_HELP,
        execHelpText: EMPTY_HELP,
    });
    strict_1.default.equal(surface.rawLength, ROOT_HELP.length + 1);
    strict_1.default.equal((0, index_js_1.isHelpSurfaceSupported)(surface), false);
});
(0, node_test_1.default)("help-probe: empty registry reports all minimum tools as missing", () => {
    const a = (0, index_js_1.buildAuthoritativeAllowlist)([]);
    strict_1.default.equal(a.ok, false);
    strict_1.default.deepEqual([...a.missingRequired], [...index_js_1.CODEX_MINIMUM_AUTHORITATIVE_TOOLS]);
});
(0, node_test_1.default)("allowlist: live registry with all catalog tools is ok", () => {
    const a = (0, index_js_1.buildAuthoritativeAllowlist)([
        ...index_js_1.CODEX_AUTHORITATIVE_TOOL_CATALOG,
        "extra_unrelated_tool",
    ]);
    strict_1.default.equal(a.ok, true);
    strict_1.default.equal(a.missingRequired.length, 0);
    strict_1.default.deepEqual([...a.tools].sort(), [...index_js_1.CODEX_AUTHORITATIVE_TOOL_CATALOG].sort());
});
(0, node_test_1.default)("allowlist: bridge-local run_command is allowed even when absent upstream", () => {
    const a = (0, index_js_1.buildAuthoritativeAllowlist)([...index_js_1.CODEX_MINIMUM_AUTHORITATIVE_TOOLS]);
    strict_1.default.equal(a.ok, true);
    strict_1.default.ok(a.tools.includes("run_command"));
});
(0, node_test_1.default)("allowlist: missing minimum grounding tool flips ok to false", () => {
    const missing = index_js_1.CODEX_MINIMUM_AUTHORITATIVE_TOOLS[index_js_1.CODEX_MINIMUM_AUTHORITATIVE_TOOLS.length - 1];
    const partial = index_js_1.CODEX_AUTHORITATIVE_TOOL_CATALOG.filter((tool) => tool !== missing);
    const a = (0, index_js_1.buildAuthoritativeAllowlist)(partial);
    strict_1.default.equal(a.ok, false);
    strict_1.default.deepEqual([...a.missingRequired], [missing]);
});
(0, node_test_1.default)("mcp-config: builds deterministic Codex config.toml artifact", () => {
    const artifact = (0, index_js_1.buildCodexMcpConfig)({
        runId: "run-abc",
        transportToken: "tok-xyz",
        dreamgraphCommand: "node",
        dreamgraphArgs: ["./codex-cli-bridge.js", "--mode", "authoritative"],
        dreamgraphEnv: { DEBUG: "dreamgraph:*" },
        allowlist: ["query_resource", "read_source_code"],
    });
    strict_1.default.equal(artifact.filename, "config.toml");
    strict_1.default.equal(artifact.metadata.runId, "run-abc");
    strict_1.default.deepEqual([...artifact.metadata.allowlist], ["query_resource", "read_source_code"]);
    const content = (0, index_js_1.serializeCodexMcpConfig)(artifact);
    strict_1.default.equal(content, artifact.content);
    strict_1.default.match(content, /\[mcp_servers\.dreamgraph\]/);
    strict_1.default.match(content, /command = "node"/);
    strict_1.default.match(content, /args = \["\.\/codex-cli-bridge\.js", "--mode", "authoritative"\]/);
    strict_1.default.match(content, /DREAMGRAPH_MCP_TOKEN = "tok-xyz"/);
    strict_1.default.match(content, /DREAMGRAPH_RUN_ID = "run-abc"/);
    strict_1.default.match(content, /default_tools_approval_mode = "auto"/);
    strict_1.default.ok(content.endsWith("\n"));
    const overrides = (0, index_js_1.buildCodexMcpConfigOverrides)({
        runId: "run-abc",
        transportToken: "tok-xyz",
        dreamgraphCommand: "node",
        dreamgraphArgs: ["./codex-cli-bridge.js", "--mode", "authoritative"],
        dreamgraphEnv: { DEBUG: "dreamgraph:*" },
        allowlist: ["query_resource", "read_source_code"],
    });
    strict_1.default.deepEqual([...overrides], [
        { key: "mcp_servers.dreamgraph.command", value: "\"node\"" },
        { key: "mcp_servers.dreamgraph.args", value: "[\"./codex-cli-bridge.js\", \"--mode\", \"authoritative\"]" },
        { key: "mcp_servers.dreamgraph.env", value: "{ DEBUG = \"dreamgraph:*\", DREAMGRAPH_MCP_TOKEN = \"tok-xyz\", DREAMGRAPH_RUN_ID = \"run-abc\" }" },
        { key: "mcp_servers.dreamgraph.default_tools_approval_mode", value: "\"auto\"" },
    ]);
});
(0, node_test_1.default)("mcp-config: rejects empty inputs with explicit messages", () => {
    strict_1.default.throws(() => (0, index_js_1.buildCodexMcpConfig)({
        runId: "",
        transportToken: "t",
        dreamgraphCommand: "node",
        dreamgraphArgs: [],
        allowlist: ["query_resource"],
    }), /runId is required/);
    strict_1.default.throws(() => (0, index_js_1.buildCodexMcpConfig)({
        runId: "r",
        transportToken: "",
        dreamgraphCommand: "node",
        dreamgraphArgs: [],
        allowlist: ["query_resource"],
    }), /transportToken is required/);
    strict_1.default.throws(() => (0, index_js_1.buildCodexMcpConfig)({
        runId: "r",
        transportToken: "t",
        dreamgraphCommand: "",
        dreamgraphArgs: [],
        allowlist: ["query_resource"],
    }), /dreamgraphCommand is required/);
    strict_1.default.throws(() => (0, index_js_1.buildCodexMcpConfig)({
        runId: "r",
        transportToken: "t",
        dreamgraphCommand: "node",
        dreamgraphArgs: [],
        allowlist: [],
    }), /allowlist must contain at least one tool/);
});
(0, node_test_1.default)("mcp-bridge: validates live registry before building isolated config", () => {
    const bridge = (0, index_js_1.buildCodexMcpBridgePlan)({
        runId: "run-bridge",
        transportToken: "tok-bridge",
        dreamgraphCommand: "node",
        dreamgraphArgs: ["./codex-cli-bridge.js"],
        liveToolNames: [...index_js_1.CODEX_AUTHORITATIVE_TOOL_CATALOG, "third_party_tool"],
    });
    strict_1.default.equal(bridge.allowlist.ok, true);
    strict_1.default.equal(bridge.registry.authoritativeServer, index_js_1.DREAMGRAPH_AUTHORITATIVE_SERVER_NAME);
    strict_1.default.deepEqual([...bridge.registry.allowedTools].sort(), [...index_js_1.CODEX_AUTHORITATIVE_TOOL_CATALOG].sort());
    strict_1.default.equal(bridge.registry.missingRequired.length, 0);
    strict_1.default.deepEqual([...bridge.config.metadata.allowlist].sort(), [...index_js_1.CODEX_AUTHORITATIVE_TOOL_CATALOG].sort());
    strict_1.default.match(bridge.config.content, /DREAMGRAPH_MCP_TOKEN = "tok-bridge"/);
    strict_1.default.deepEqual(bridge.configOverrides.map((override) => override.key), [
        "mcp_servers.dreamgraph.command",
        "mcp_servers.dreamgraph.args",
        "mcp_servers.dreamgraph.env",
        "mcp_servers.dreamgraph.default_tools_approval_mode",
    ]);
});
(0, node_test_1.default)("mcp-bridge: fails closed when required DreamGraph tools are missing", () => {
    const missing = index_js_1.CODEX_MINIMUM_AUTHORITATIVE_TOOLS[0];
    strict_1.default.throws(() => (0, index_js_1.buildCodexMcpBridgePlan)({
        runId: "run-bridge",
        transportToken: "tok-bridge",
        dreamgraphCommand: "node",
        dreamgraphArgs: ["./codex-cli-bridge.js"],
        liveToolNames: index_js_1.CODEX_AUTHORITATIVE_TOOL_CATALOG.filter((tool) => tool !== missing),
    }), new RegExp(`DreamGraph tool registry mismatch.*${missing}`));
});
(0, node_test_1.default)("argv: emits authoritative codex exec shape with stdin positional dash", () => {
    const plan = (0, index_js_1.buildCodexArgv)({
        workspace: "C:\\repo",
        model: "gpt-5.5",
        profile: "dreamgraph",
        outputLastMessagePath: "C:\\repo\\.tmp\\last-message.txt",
        outputSchemaPath: "C:\\repo\\.tmp\\schema.json",
        addDirs: ["C:\\repo\\.tmp\\run"],
        configOverrides: [{ key: "model_reasoning_effort", value: "high" }],
        skipGitRepoCheck: true,
        ephemeral: true,
        helpSurface: FULL_SURFACE,
    });
    strict_1.default.deepEqual([...plan.args], [
        "exec",
        "--json",
        "--cd", "C:\\repo",
        "--sandbox", "read-only",
        "--ask-for-approval", "never",
        "--model", "gpt-5.5",
        "--profile", "dreamgraph",
        "--output-last-message", "C:\\repo\\.tmp\\last-message.txt",
        "--output-schema", "C:\\repo\\.tmp\\schema.json",
        "-c", "model_reasoning_effort=high",
        "--add-dir", "C:\\repo\\.tmp\\run",
        "--skip-git-repo-check",
        "--ephemeral",
        "-",
    ]);
    strict_1.default.equal(plan.policy.sandboxMode, "read-only");
    strict_1.default.equal(plan.policy.approvalMode, "never");
    strict_1.default.equal(plan.policy.promptSource, "stdin-positional-dash");
    strict_1.default.equal(plan.policy.jsonEventsEnabled, true);
    strict_1.default.deepEqual([...plan.policy.addedDirs], ["C:\\repo\\.tmp\\run"]);
});
(0, node_test_1.default)("argv: omits ask-for-approval when Codex exec does not advertise it", () => {
    const helpSurface = (0, index_js_1.parseCodexHelpSurface)({
        rootHelpText: ROOT_HELP,
        execHelpText: EXEC_HELP_WITHOUT_APPROVAL,
    });
    const plan = (0, index_js_1.buildCodexArgv)({
        workspace: "C:\\repo",
        helpSurface,
    });
    strict_1.default.deepEqual([...plan.args], [
        "exec",
        "--json",
        "--cd", "C:\\repo",
        "--sandbox", "read-only",
        "-",
    ]);
    strict_1.default.equal(plan.policy.approvalMode, "not-advertised");
});
(0, node_test_1.default)("argv: never emits elevated sandbox or approval from config overrides", () => {
    strict_1.default.throws(() => (0, index_js_1.buildCodexArgv)({
        workspace: "C:\\repo",
        configOverrides: [{ key: "sandbox", value: "workspace-write" }],
        helpSurface: FULL_SURFACE,
    }), /cannot weaken authoritative sandbox\/approval policy/);
    strict_1.default.throws(() => (0, index_js_1.buildCodexArgv)({
        workspace: "C:\\repo",
        configOverrides: [{ key: "ask_for_approval", value: "on-request" }],
        helpSurface: FULL_SURFACE,
    }), /cannot weaken authoritative sandbox\/approval policy/);
});
(0, node_test_1.default)("argv: rejects missing workspace and missing required help support", () => {
    strict_1.default.throws(() => (0, index_js_1.buildCodexArgv)({ workspace: "", helpSurface: FULL_SURFACE }), /workspace is required/);
    const unsupported = (0, index_js_1.parseCodexHelpSurface)({
        rootHelpText: ROOT_HELP,
        execHelpText: EXEC_HELP.replace("--json", "--banana"),
    });
    strict_1.default.throws(() => (0, index_js_1.buildCodexArgv)({ workspace: "C:\\repo", helpSurface: unsupported }), /does not advertise --json/);
});
const CLASSIFY_CTX = {
    authoritativeServer: index_js_1.DREAMGRAPH_AUTHORITATIVE_SERVER_NAME,
    allowlist: ["query_resource", "read_source_code"],
};
(0, node_test_1.default)("classifier: dreamgraph + allowlisted tool is authoritative", () => {
    strict_1.default.equal((0, index_js_1.classifyToolCall)({ server: "dreamgraph", tool: "query_resource" }, CLASSIFY_CTX), "dreamgraph_authoritative");
});
(0, node_test_1.default)("classifier: dreamgraph + non-allowlisted tool is rejected", () => {
    strict_1.default.equal((0, index_js_1.classifyToolCall)({ server: "dreamgraph", tool: "edit_file" }, CLASSIFY_CTX), "dreamgraph_rejected");
});
(0, node_test_1.default)("classifier: third-party MCP server is generic context", () => {
    strict_1.default.equal((0, index_js_1.classifyToolCall)({ server: "github", tool: "search_issues" }, CLASSIFY_CTX), "generic_context_mcp");
});
(0, node_test_1.default)("classifier: inline sentinel is provider inline tool", () => {
    strict_1.default.equal((0, index_js_1.classifyToolCall)({ server: index_js_1.CODEX_INLINE_TOOL_SERVER, tool: "shell" }, CLASSIFY_CTX), "provider_inline_tool");
});
(0, node_test_1.default)("transcript: projects Codex MCP JSON events into tool observations", () => {
    const transcript = (0, index_js_1.normalizeCodexTranscript)({
        stdout: [
            JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
            JSON.stringify({
                type: "item.completed",
                item: { type: "mcp_tool_call", server: "dreamgraph", tool: "query_resource" },
            }),
            JSON.stringify({
                type: "mcp_tool_call.completed",
                tool: "dreamgraph.run_command",
            }),
            JSON.stringify({
                type: "item.completed",
                item: { id: "item_0", type: "agent_message", text: "Graph checked." },
            }),
        ].join("\n"),
        stderr: "",
        exitCode: 0,
    });
    strict_1.default.equal(transcript.assistantText, "Graph checked.");
    strict_1.default.deepEqual([...transcript.toolCalls], [
        { server: "dreamgraph", tool: "query_resource" },
        { server: "dreamgraph", tool: "run_command" },
    ]);
});
(0, node_test_1.default)("transcript: strips ANSI, reports diagnostics, and detects login recovery signal", () => {
    const t = (0, index_js_1.normalizeCodexTranscript)({
        stdout: "\u001b[32mHello\u001b[0m\r\n",
        stderr: "Error: not logged in. Please run codex login.\n",
    });
    strict_1.default.equal(t.assistantText, "Hello");
    strict_1.default.deepEqual([...t.diagnostics], ["Error: not logged in. Please run codex login."]);
    strict_1.default.equal(t.hasStderrErrors, true);
    strict_1.default.equal(t.notLoggedIn, true);
});
(0, node_test_1.default)("transcript: projects Codex item.completed agent messages from whitespace-separated json", () => {
    const t = (0, index_js_1.normalizeCodexTranscript)({
        stdout: [
            JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
            JSON.stringify({ type: "turn.started" }),
            "SUCCESS: The process with PID 10712 (child process of PID 18828) has been terminated.",
            JSON.stringify({
                type: "item.completed",
                item: {
                    id: "item_0",
                    type: "agent_message",
                    text: "I'm Codex, based on GPT-5.\n\nCurrent project: dreamgraph at C:\\Users\\Mika Jussila\\source\\repos\\dreamgraph.",
                },
            }),
            JSON.stringify({
                type: "turn.completed",
                usage: { input_tokens: 34557, output_tokens: 157 },
            }),
        ].join(" "),
        stderr: "",
    });
    strict_1.default.equal(t.assistantText, "I'm Codex, based on GPT-5.\n\nCurrent project: dreamgraph at C:\\Users\\Mika Jussila\\source\\repos\\dreamgraph.");
    strict_1.default.deepEqual([...t.diagnostics], [
        "stdout: SUCCESS: The process with PID 10712 (child process of PID 18828) has been terminated.",
    ]);
    strict_1.default.equal(t.hasStderrErrors, false);
});
//# sourceMappingURL=codex-cli-adapter.test.js.map