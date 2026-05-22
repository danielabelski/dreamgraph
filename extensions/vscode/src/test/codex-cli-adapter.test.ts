// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Codex CLI adapter - Slice 1 pure-module tests.

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAuthoritativeAllowlist,
  buildCodexArgv,
  buildCodexMcpBridgePlan,
  buildCodexMcpConfig,
  buildCodexMcpConfigOverrides,
  classifyToolCall,
  CODEX_AUTHORITATIVE_TOOL_CATALOG,
  CODEX_INLINE_TOOL_SERVER,
  CODEX_MINIMUM_AUTHORITATIVE_TOOLS,
  DREAMGRAPH_AUTHORITATIVE_SERVER_NAME,
  extractCodexJsonEvents,
  isHelpSurfaceSupported,
  normalizeCodexTranscript,
  parseCodexHelpSurface,
  serializeCodexMcpConfig,
  type CodexHelpSurface,
} from "../architect-core/adapters/codex-cli/index.js";

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

const FULL_SURFACE: CodexHelpSurface = parseCodexHelpSurface({
  rootHelpText: ROOT_HELP,
  execHelpText: EXEC_HELP,
  versionString: "codex 0.99.0",
});

test("help-probe: parses Codex root and exec surfaces", () => {
  assert.equal(FULL_SURFACE.versionString, "codex 0.99.0");
  assert.equal(FULL_SURFACE.root.execCommand, true);
  assert.equal(FULL_SURFACE.exec.positionalStdinPrompt, true);
  assert.equal(FULL_SURFACE.exec.json, true);
  assert.equal(FULL_SURFACE.exec.model, true);
  assert.equal(FULL_SURFACE.exec.cd, true);
  assert.equal(FULL_SURFACE.exec.sandbox, true);
  assert.equal(FULL_SURFACE.exec.askForApproval, true);
  assert.equal(FULL_SURFACE.exec.config, true);
  assert.equal(FULL_SURFACE.exec.profile, true);
  assert.equal(FULL_SURFACE.exec.addDir, true);
  assert.equal(FULL_SURFACE.exec.outputLastMessage, true);
  assert.equal(FULL_SURFACE.exec.outputSchema, true);
  assert.equal(FULL_SURFACE.exec.skipGitRepoCheck, true);
  assert.equal(FULL_SURFACE.exec.ignoreUserConfig, true);
  assert.equal(FULL_SURFACE.exec.ephemeral, true);
  assert.deepEqual(
    [...FULL_SURFACE.safety.sandboxModes],
    ["read-only", "workspace-write", "danger-full-access"],
  );
  assert.deepEqual(
    [...FULL_SURFACE.safety.approvalModes],
    ["untrusted", "on-failure", "on-request", "never"],
  );
  assert.equal(FULL_SURFACE.safety.fullAutoDeprecated, true);
  assert.equal(FULL_SURFACE.safety.dangerousBypass, true);
  assert.ok(isHelpSurfaceSupported(FULL_SURFACE));
});

test("help-probe: supports Codex exec help without ask-for-approval", () => {
  const surface = parseCodexHelpSurface({
    rootHelpText: ROOT_HELP,
    execHelpText: EXEC_HELP_WITHOUT_APPROVAL,
  });
  assert.equal(surface.exec.askForApproval, false);
  assert.deepEqual([...surface.safety.approvalModes], []);
  assert.ok(isHelpSurfaceSupported(surface));
});

test("help-probe: missing exec help fails the support check", () => {
  const surface = parseCodexHelpSurface({
    rootHelpText: ROOT_HELP,
    execHelpText: EMPTY_HELP,
  });
  assert.equal(surface.rawLength, ROOT_HELP.length + 1);
  assert.equal(isHelpSurfaceSupported(surface), false);
});

test("help-probe: empty registry reports all minimum tools as missing", () => {
  const a = buildAuthoritativeAllowlist([]);
  assert.equal(a.ok, false);
  assert.deepEqual(
    [...a.missingRequired],
    [...CODEX_MINIMUM_AUTHORITATIVE_TOOLS],
  );
});

test("allowlist: live registry with all catalog tools is ok", () => {
  const a = buildAuthoritativeAllowlist([
    ...CODEX_AUTHORITATIVE_TOOL_CATALOG,
    "extra_unrelated_tool",
  ]);
  assert.equal(a.ok, true);
  assert.equal(a.missingRequired.length, 0);
  assert.deepEqual(
    [...a.tools].sort(),
    [...CODEX_AUTHORITATIVE_TOOL_CATALOG].sort(),
  );
});

test("allowlist: bridge-local run_command is not injected for Codex", () => {
  const a = buildAuthoritativeAllowlist([...CODEX_MINIMUM_AUTHORITATIVE_TOOLS]);
  assert.equal(a.ok, true);
  assert.equal(a.tools.includes("run_command"), false);
});

test("allowlist: missing minimum grounding tool flips ok to false", () => {
  const missing = CODEX_MINIMUM_AUTHORITATIVE_TOOLS[
    CODEX_MINIMUM_AUTHORITATIVE_TOOLS.length - 1
  ]!;
  const partial = CODEX_AUTHORITATIVE_TOOL_CATALOG.filter((tool) => tool !== missing);
  const a = buildAuthoritativeAllowlist(partial);
  assert.equal(a.ok, false);
  assert.deepEqual([...a.missingRequired], [missing]);
});

test("mcp-config: builds deterministic Codex config.toml artifact", () => {
  const artifact = buildCodexMcpConfig({
    runId: "run-abc",
    transportToken: "tok-xyz",
    dreamgraphCommand: "node",
    dreamgraphArgs: ["./codex-cli-bridge.js", "--mode", "authoritative"],
    dreamgraphEnv: { DEBUG: "dreamgraph:*" },
    allowlist: ["query_resource", "read_source_code"],
  });

  assert.equal(artifact.filename, "config.toml");
  assert.equal(artifact.metadata.runId, "run-abc");
  assert.deepEqual(
    [...artifact.metadata.allowlist],
    ["query_resource", "read_source_code"],
  );

  const content = serializeCodexMcpConfig(artifact);
  assert.equal(content, artifact.content);
  assert.match(content, /\[mcp_servers\.dreamgraph\]/);
  assert.match(content, /command = "node"/);
  assert.match(content, /args = \["\.\/codex-cli-bridge\.js", "--mode", "authoritative"\]/);
  assert.match(content, /DREAMGRAPH_MCP_TOKEN = "tok-xyz"/);
  assert.match(content, /DREAMGRAPH_RUN_ID = "run-abc"/);
  assert.match(content, /disabled_tools = \["run_command"\]/);
  assert.match(content, /default_tools_enabled = true/);
  assert.match(content, /default_tools_approval_mode = "approve"/);
  assert.ok(content.endsWith("\n"));

  const overrides = buildCodexMcpConfigOverrides({
    runId: "run-abc",
    transportToken: "tok-xyz",
    dreamgraphCommand: "node",
    dreamgraphArgs: ["./codex-cli-bridge.js", "--mode", "authoritative"],
    dreamgraphEnv: { DEBUG: "dreamgraph:*" },
    allowlist: ["query_resource", "read_source_code"],
  });
  assert.deepEqual([...overrides], [
    { key: "mcp_servers.dreamgraph.command", value: "\"node\"" },
    { key: "mcp_servers.dreamgraph.args", value: "[\"./codex-cli-bridge.js\", \"--mode\", \"authoritative\"]" },
    { key: "mcp_servers.dreamgraph.env", value: "{ DEBUG = \"dreamgraph:*\", DREAMGRAPH_MCP_TOKEN = \"tok-xyz\", DREAMGRAPH_RUN_ID = \"run-abc\" }" },
    { key: "mcp_servers.dreamgraph.disabled_tools", value: "[\"run_command\"]" },
    { key: "mcp_servers.dreamgraph.default_tools_enabled", value: true },
    { key: "mcp_servers.dreamgraph.default_tools_approval_mode", value: "\"approve\"" },
  ]);
});

test("mcp-config: rejects empty inputs with explicit messages", () => {
  assert.throws(
    () =>
      buildCodexMcpConfig({
        runId: "",
        transportToken: "t",
        dreamgraphCommand: "node",
        dreamgraphArgs: [],
        allowlist: ["query_resource"],
      }),
    /runId is required/,
  );
  assert.throws(
    () =>
      buildCodexMcpConfig({
        runId: "r",
        transportToken: "",
        dreamgraphCommand: "node",
        dreamgraphArgs: [],
        allowlist: ["query_resource"],
      }),
    /transportToken is required/,
  );
  assert.throws(
    () =>
      buildCodexMcpConfig({
        runId: "r",
        transportToken: "t",
        dreamgraphCommand: "",
        dreamgraphArgs: [],
        allowlist: ["query_resource"],
      }),
    /dreamgraphCommand is required/,
  );
  assert.throws(
    () =>
      buildCodexMcpConfig({
        runId: "r",
        transportToken: "t",
        dreamgraphCommand: "node",
        dreamgraphArgs: [],
        allowlist: [],
      }),
    /allowlist must contain at least one tool/,
  );
});

test("mcp-bridge: validates live registry before building isolated config", () => {
  const bridge = buildCodexMcpBridgePlan({
    runId: "run-bridge",
    transportToken: "tok-bridge",
    dreamgraphCommand: "node",
    dreamgraphArgs: ["./codex-cli-bridge.js"],
    liveToolNames: [...CODEX_AUTHORITATIVE_TOOL_CATALOG, "third_party_tool"],
  });

  assert.equal(bridge.allowlist.ok, true);
  assert.equal(bridge.registry.authoritativeServer, DREAMGRAPH_AUTHORITATIVE_SERVER_NAME);
  assert.deepEqual(
    [...bridge.registry.allowedTools].sort(),
    [...CODEX_AUTHORITATIVE_TOOL_CATALOG].sort(),
  );
  assert.equal(bridge.registry.missingRequired.length, 0);
  assert.deepEqual(
    [...bridge.config.metadata.allowlist].sort(),
    [...CODEX_AUTHORITATIVE_TOOL_CATALOG].sort(),
  );
  assert.match(bridge.config.content, /DREAMGRAPH_MCP_TOKEN = "tok-bridge"/);
  assert.deepEqual(
    bridge.configOverrides.map((override) => override.key),
    [
      "mcp_servers.dreamgraph.command",
      "mcp_servers.dreamgraph.args",
      "mcp_servers.dreamgraph.env",
      "mcp_servers.dreamgraph.disabled_tools",
      "mcp_servers.dreamgraph.default_tools_enabled",
      "mcp_servers.dreamgraph.default_tools_approval_mode",
    ],
  );
});

test("mcp-bridge: fails closed when required DreamGraph tools are missing", () => {
  const missing = CODEX_MINIMUM_AUTHORITATIVE_TOOLS[0]!;
  assert.throws(
    () =>
      buildCodexMcpBridgePlan({
        runId: "run-bridge",
        transportToken: "tok-bridge",
        dreamgraphCommand: "node",
        dreamgraphArgs: ["./codex-cli-bridge.js"],
        liveToolNames: CODEX_AUTHORITATIVE_TOOL_CATALOG.filter((tool) => tool !== missing),
      }),
    new RegExp(`DreamGraph tool registry mismatch.*${missing}`),
  );
});

test("argv: emits authoritative codex exec shape with stdin positional dash", () => {
  const plan = buildCodexArgv({
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

  assert.deepEqual(
    [...plan.args],
    [
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
    ],
  );
  assert.equal(plan.args[1], "--json");
  assert.equal(plan.args.includes("--output-format"), false);
  assert.equal(plan.policy.sandboxMode, "read-only");
  assert.equal(plan.policy.approvalMode, "never");
  assert.equal(plan.policy.promptSource, "stdin-positional-dash");
  assert.equal(plan.policy.jsonEventsEnabled, true);
  assert.deepEqual([...plan.policy.addedDirs], ["C:\\repo\\.tmp\\run"]);
});

test("argv: omits ask-for-approval when Codex exec does not advertise it", () => {
  const helpSurface = parseCodexHelpSurface({
    rootHelpText: ROOT_HELP,
    execHelpText: EXEC_HELP_WITHOUT_APPROVAL,
  });
  const plan = buildCodexArgv({
    workspace: "C:\\repo",
    helpSurface,
  });

  assert.deepEqual([...plan.args], [
    "exec",
    "--json",
    "--cd", "C:\\repo",
    "--sandbox", "read-only",
    "-",
  ]);
  assert.equal(plan.policy.approvalMode, "not-advertised");
});

test("argv: never emits elevated sandbox or approval from config overrides", () => {
  assert.throws(
    () =>
      buildCodexArgv({
        workspace: "C:\\repo",
        configOverrides: [{ key: "sandbox", value: "workspace-write" }],
        helpSurface: FULL_SURFACE,
      }),
    /cannot weaken authoritative sandbox\/approval policy/,
  );
  assert.throws(
    () =>
      buildCodexArgv({
        workspace: "C:\\repo",
        configOverrides: [{ key: "ask_for_approval", value: "on-request" }],
        helpSurface: FULL_SURFACE,
      }),
    /cannot weaken authoritative sandbox\/approval policy/,
  );
});

test("argv: rejects missing workspace and missing required help support", () => {
  assert.throws(
    () => buildCodexArgv({ workspace: "", helpSurface: FULL_SURFACE }),
    /workspace is required/,
  );
  const unsupported = parseCodexHelpSurface({
    rootHelpText: ROOT_HELP,
    execHelpText: EXEC_HELP.replace("--json", "--banana"),
  });
  assert.throws(
    () => buildCodexArgv({ workspace: "C:\\repo", helpSurface: unsupported }),
    /does not advertise --json/,
  );
});

const CLASSIFY_CTX = {
  authoritativeServer: DREAMGRAPH_AUTHORITATIVE_SERVER_NAME,
  allowlist: ["query_resource", "read_source_code"] as const,
};

test("classifier: dreamgraph + allowlisted tool is authoritative", () => {
  assert.equal(
    classifyToolCall({ server: "dreamgraph", tool: "query_resource" }, CLASSIFY_CTX),
    "dreamgraph_authoritative",
  );
});

test("classifier: dreamgraph + non-allowlisted tool is rejected", () => {
  assert.equal(
    classifyToolCall({ server: "dreamgraph", tool: "edit_file" }, CLASSIFY_CTX),
    "dreamgraph_rejected",
  );
});

test("classifier: third-party MCP server is generic context", () => {
  assert.equal(
    classifyToolCall({ server: "github", tool: "search_issues" }, CLASSIFY_CTX),
    "generic_context_mcp",
  );
});

test("classifier: inline sentinel is provider inline tool", () => {
  assert.equal(
    classifyToolCall(
      { server: CODEX_INLINE_TOOL_SERVER, tool: "shell" },
      CLASSIFY_CTX,
    ),
    "provider_inline_tool",
  );
});

test("transcript: projects Codex MCP JSON events into tool observations", () => {
  const transcript = normalizeCodexTranscript({
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

  assert.equal(transcript.assistantText, "Graph checked.");
  assert.deepEqual([...transcript.toolCalls], [
    { server: "dreamgraph", tool: "query_resource" },
    { server: "dreamgraph", tool: "run_command" },
  ]);
});

test("transcript: ignores failed Codex MCP JSON items as missing tool results", () => {
  const transcript = normalizeCodexTranscript({
    stdout: [
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "mcp_tool_call",
          server: "dreamgraph",
          tool: "cognitive_status",
          status: "failed",
          aggregated_output: "user cancelled MCP tool call",
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_1", type: "agent_message", text: "Speculative synthesis only." },
      }),
    ].join("\n"),
    stderr: "",
    exitCode: 0,
  });

  assert.equal(transcript.assistantText, "Speculative synthesis only.");
  assert.deepEqual([...transcript.toolCalls], []);
});

test("transcript: strips ANSI, reports diagnostics, and detects login recovery signal", () => {
  const t = normalizeCodexTranscript({
    stdout: "\u001b[32mHello\u001b[0m\r\n",
    stderr: "Error: not logged in. Please run codex login.\n",
  });
  assert.equal(t.assistantText, "Hello");
  assert.deepEqual([...t.diagnostics], ["Error: not logged in. Please run codex login."]);
  assert.equal(t.hasStderrErrors, true);
  assert.equal(t.notLoggedIn, true);
});

test("transcript: projects Codex item.completed agent messages from whitespace-separated json", () => {
  const t = normalizeCodexTranscript({
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

  assert.equal(
    t.assistantText,
    "I'm Codex, based on GPT-5.\n\nCurrent project: dreamgraph at C:\\Users\\Mika Jussila\\source\\repos\\dreamgraph.",
  );
  assert.deepEqual([...t.diagnostics], [
    "stdout: SUCCESS: The process with PID 10712 (child process of PID 18828) has been terminated.",
  ]);
  assert.equal(t.hasStderrErrors, false);
});

test("transcript: parses Codex structured output, assistant deltas, usage, and diagnostics", () => {
  const t = normalizeCodexTranscript({
    stdout: [
      "diagnostic before json",
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "response.output_text.delta", delta: "Graph" }),
      JSON.stringify({ type: "assistant.message_delta", deltaContent: " health" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "mcp_tool_call", server: "dreamgraph", tool: "query_resource", status: "completed" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 123, cached_input_tokens: 10, output_tokens: 45, total_tokens: 168 },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "Graph health OK." },
      }),
    ].join("\n"),
    stderr: "non-json stderr diagnostic\n",
    exitCode: 0,
  });

  assert.equal(t.assistantText, "Graph health OK.");
  assert.deepEqual([...t.assistantDeltas], ["Graph", " health"]);
  assert.deepEqual([...t.toolCalls], [{ server: "dreamgraph", tool: "query_resource" }]);
  assert.equal(t.usage?.inputTokens, 123);
  assert.equal(t.usage?.cachedInputTokens, 10);
  assert.equal(t.usage?.outputTokens, 45);
  assert.equal(t.usage?.totalTokens, 168);
  assert.deepEqual(t.turns, { started: 1, completed: 1 });
  assert.equal(t.completedItemCount, 2);
  assert.ok(t.diagnostics.some((line) => line.includes("diagnostic before json")));
  assert.ok(t.diagnostics.some((line) => line.includes("non-json stderr diagnostic")));
});

test("transcript: extracts structured usage-limit errors with retry metadata", () => {
  const t = normalizeCodexTranscript({
    stdout: [
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "turn.failed",
        error: {
          code: "rate_limit",
          message:
            "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 2:45 PM.",
        },
      }),
    ].join("\n"),
    stderr: "",
    exitCode: 1,
  });

  assert.equal(t.usageLimit?.code, "rate_limit");
  assert.equal(t.usageLimit?.retryAt, "2:45 PM");
  assert.equal(t.notLoggedIn, false);
  assert.equal(t.structuredErrors.length, 1);
});

test("transcript: suppresses Cloudflare plugin catalog HTML as warning, not login failure", () => {
  const html = [
    "<!DOCTYPE html><html><head><title>403 Forbidden</title></head>",
    "<body>Cloudflare Ray ID: abc /backend-api/plugins/featured Authentication required</body></html>",
  ].join("");
  const t = normalizeCodexTranscript({
    stdout: JSON.stringify({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: "Partial text." },
    }),
    stderr: html,
    exitCode: 1,
  });

  assert.equal(t.notLoggedIn, false);
  assert.equal(t.pluginSyncWarnings.length, 1);
  assert.ok(t.diagnostics.every((line) => !line.includes("<!DOCTYPE html>")));
});

test("transcript: classifies unsupported model and policy denial separately from login", () => {
  const model = normalizeCodexTranscript({
    stdout: JSON.stringify({ type: "error", code: "unsupported_model", message: "Unsupported model: nope" }),
    stderr: "",
    exitCode: 1,
  });
  assert.equal(model.modelUnsupported, true);
  assert.equal(model.notLoggedIn, false);

  const policy = normalizeCodexTranscript({
    stdout: "",
    stderr: "2026-05-21T13:34:30.489369Z ERROR codex_core::tools::router: rejected: blocked by policy\n",
    exitCode: 1,
  });
  assert.equal(policy.policyDenied, true);
  assert.equal(policy.notLoggedIn, false);
});

test("transcript: treats Codex telemetry unknown terminal type as noise, not unsupported model", () => {
  const stderr = [
    '2026-05-22T16:00:18.506798Z INFO session_loop{thread_id=abc}:turn{model=gpt-5.4}:model_client.stream_responses_websocket{model=gpt-5.4 wire_api=responses transport="responses_websocket"}: terminal.type=unknown model=gpt-5.4 slug=gpt-5.4 user.email="person@example.com"',
    '2026-05-22T16:00:18.514472Z INFO codex_otel.log_only: event.name="codex.sse_event" event.kind=response.completed input_token_count=103247 output_token_count=1769 cached_token_count=101248 reasoning_token_count=361 tool_token_count=105016 terminal.type=unknown model=gpt-5.4 slug=gpt-5.4 user.email="person@example.com"',
    "mcp_tool_call failed: dreamgraph.search_source_code",
  ].join("\n");

  const t = normalizeCodexTranscript({
    stdout: JSON.stringify({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: "Partial assessment." },
    }),
    stderr,
    exitCode: 1,
  });

  assert.equal(t.modelUnsupported, false);
  assert.equal(t.notLoggedIn, false);
  assert.equal(t.usage?.inputTokens, 103247);
  assert.equal(t.usage?.outputTokens, 1769);
  assert.equal(t.usage?.cachedInputTokens, 101248);
  assert.deepEqual([...t.diagnostics], ["mcp_tool_call failed: dreamgraph.search_source_code"]);
});

test("event stream: parses JSON arrays and classifies them by shape", () => {
  const eventArray = JSON.stringify([
    { type: "turn.started" },
    { type: "response.output_text.delta", delta: "Graph" },
    { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } },
  ]);
  const contentArray = JSON.stringify([
    {
      type: "text",
      text: "tool payload mentioning CODEX_MODEL_UNSUPPORTED",
    },
  ]);
  const extracted = extractCodexJsonEvents(`${eventArray}\n${contentArray}\nplain diagnostic`);

  assert.deepEqual(extracted.events.map((event) => (event as { type?: string }).type), [
    "turn.started",
    "response.output_text.delta",
    "turn.completed",
  ]);
  assert.deepEqual([...extracted.diagnostics], ["plain diagnostic"]);
});

test("transcript: classifies JSON content arrays as payload, not diagnostics or model errors", () => {
  const toolContent = JSON.stringify([
    {
      type: "text",
      text:
        "test(\"unsupported model remains model-unsupported / nonzero model failure\", () => {\n" +
        "  assert.equal(result.failure?.code, \"CODEX_MODEL_UNSUPPORTED\");\n" +
        "});",
    },
  ]);
  const t = normalizeCodexTranscript({
    stdout: [
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "I inspected the adapter source." },
      }),
      toolContent,
    ].join("\n"),
    stderr: "",
    exitCode: 1,
  });

  assert.equal(t.assistantText, "I inspected the adapter source.");
  assert.equal(t.modelUnsupported, false);
  assert.deepEqual([...t.diagnostics], []);
});
