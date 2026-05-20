// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — Slice 1 pure-module tests.
//
// Covers help-probe, mcp-config generator, allowlist builder,
// argv builder, transcript classifier. No I/O, no spawn — every
// input is a literal string or object so the suite runs in <1s.

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAuthoritativeAllowlist,
  buildCopilotArgv,
  buildCopilotMcpConfig,
  classifyToolCall,
  COPILOT_AUTHORITATIVE_TOOL_CATALOG,
  COPILOT_INLINE_TOOL_SERVER,
  COPILOT_MINIMUM_AUTHORITATIVE_TOOLS,
  COPILOT_NATIVE_COMMAND_TOOLS,
  DREAMGRAPH_AUTHORITATIVE_SERVER_NAME,
  isHelpSurfaceSupported,
  parseCopilotHelpSurface,
  serializeCopilotMcpConfig,
  type CopilotHelpSurface,
} from "../architect-core/adapters/copilot-cli/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FULL_HELP = `
Usage: copilot [options]

Options:
  -p, --prompt <text>            The prompt to send
      --model <model>            Model identifier
      --allow-tool <spec>        Permit a tool (server:tool or tool)
      --deny-tool <spec>         Forbid a tool
      --available-tools <list>   Restrict the visible tool set
      --allow-all-tools          Permit every tool (DANGEROUS)
      --disallow-temp-dir        Refuse to create temporary directories
      --allow-url <url>          Permit a URL
      --deny-url <url>           Forbid a URL
      --additional-mcp-config <json>  Augment ~/.copilot/mcp-config.json
`;

const MINIMAL_HELP = `
Usage: copilot [options]

Options:
  -p, --prompt <text>            The prompt to send
      --model <model>            Model identifier
      --allow-tool <spec>        Permit a tool
      --deny-tool <spec>         Forbid a tool
      --allow-all-tools          Permit every tool (DANGEROUS)
      --additional-mcp-config <json>  Augment ~/.copilot/mcp-config.json
`;

const EMPTY_HELP = "";

// ---------------------------------------------------------------------------
// help-probe
// ---------------------------------------------------------------------------

test("help-probe: parses full help surface", () => {
  const s = parseCopilotHelpSurface(FULL_HELP, "copilot 1.4.2");
  assert.equal(s.versionString, "copilot 1.4.2");
  assert.equal(s.required.prompt, true);
  assert.equal(s.required.allowTool, true);
  assert.equal(s.required.denyTool, true);
  assert.equal(s.required.model, true);
  assert.equal(s.required.allowAllTools, true);
  assert.equal(s.optional.additionalMcpConfig, true);
  assert.equal(s.optional.availableTools, true);
  assert.equal(s.optional.disallowTempDir, true);
  assert.equal(s.optional.allowUrl, true);
  assert.equal(s.optional.denyUrl, true);
  assert.ok(isHelpSurfaceSupported(s));
});

test("help-probe: minimal help is supported (only required flags)", () => {
  const s = parseCopilotHelpSurface(MINIMAL_HELP);
  assert.equal(s.versionString, null);
  assert.equal(s.required.prompt, true);
  assert.equal(s.required.allowTool, true);
  assert.equal(s.required.denyTool, true);
  assert.equal(s.required.model, true);
  assert.equal(s.required.allowAllTools, true);
  assert.equal(s.optional.additionalMcpConfig, true);
  assert.equal(s.optional.availableTools, false);
  assert.equal(s.optional.disallowTempDir, false);
  assert.ok(isHelpSurfaceSupported(s));
});

test("help-probe: empty help fails the support check", () => {
  const s = parseCopilotHelpSurface(EMPTY_HELP);
  assert.equal(isHelpSurfaceSupported(s), false);
});

test("help-probe: missing single required flag fails the support check", () => {
  const partial = MINIMAL_HELP.replace("--deny-tool <spec>", "--banana <bunch>");
  const s = parseCopilotHelpSurface(partial);
  assert.equal(s.required.denyTool, false);
  assert.equal(isHelpSurfaceSupported(s), false);
});

test("help-probe: undefined help text yields zero-length surface, not throw", () => {
  // @ts-expect-error — exercising defensive runtime handling.
  const s = parseCopilotHelpSurface(undefined);
  assert.equal(s.rawLength, 0);
  assert.equal(isHelpSurfaceSupported(s), false);
});

// ---------------------------------------------------------------------------
// allowlist
// ---------------------------------------------------------------------------

test("allowlist: live registry with all catalog tools is ok", () => {
  const a = buildAuthoritativeAllowlist([
    ...COPILOT_AUTHORITATIVE_TOOL_CATALOG,
    "extra_unrelated_tool",
  ]);
  assert.equal(a.ok, true);
  assert.equal(a.missingRequired.length, 0);
  assert.deepEqual(
    [...a.tools].sort(),
    [...COPILOT_AUTHORITATIVE_TOOL_CATALOG].sort(),
  );
});

test("allowlist: bridge-local run_command is allowed even when absent upstream", () => {
  const a = buildAuthoritativeAllowlist([
    ...COPILOT_MINIMUM_AUTHORITATIVE_TOOLS,
  ]);
  assert.equal(a.ok, true);
  assert.ok(a.tools.includes("run_command"));
});

test("allowlist: missing minimum grounding tool flips ok to false", () => {
  const missing = COPILOT_MINIMUM_AUTHORITATIVE_TOOLS[
    COPILOT_MINIMUM_AUTHORITATIVE_TOOLS.length - 1
  ]!;
  const partial = COPILOT_AUTHORITATIVE_TOOL_CATALOG.filter((tool) => tool !== missing);
  const a = buildAuthoritativeAllowlist(partial);
  assert.equal(a.ok, false);
  assert.deepEqual([...a.missingRequired], [missing]);
});

test("allowlist: empty registry reports all minimum tools as missing", () => {
  const a = buildAuthoritativeAllowlist([]);
  assert.equal(a.ok, false);
  assert.equal(
    a.missingRequired.length,
    COPILOT_MINIMUM_AUTHORITATIVE_TOOLS.length,
  );
});

// ---------------------------------------------------------------------------
// mcp-config
// ---------------------------------------------------------------------------

test("mcp-config: builds a deterministic single-server artifact", () => {
  const artifact = buildCopilotMcpConfig({
    runId: "run-abc",
    transportToken: "tok-xyz",
    dreamgraphCommand: "node",
    dreamgraphArgs: ["./mcp-bridge.js", "--mode", "authoritative"],
    allowlist: ["query_resource", "read_source_code"],
  });

  assert.equal(artifact.filename, "mcp-config.json");

  const servers = artifact.content.mcpServers;
  const names = Object.keys(servers);
  assert.deepEqual(names, [DREAMGRAPH_AUTHORITATIVE_SERVER_NAME]);

  const dg = servers[DREAMGRAPH_AUTHORITATIVE_SERVER_NAME]!;
  assert.equal(dg.type, "stdio");
  assert.equal(dg.command, "node");
  assert.deepEqual([...dg.args], ["./mcp-bridge.js", "--mode", "authoritative"]);
  assert.equal(dg.env.DREAMGRAPH_MCP_TOKEN, "tok-xyz");
  assert.equal(dg.env.DREAMGRAPH_RUN_ID, "run-abc");

  assert.equal(artifact.content._dreamgraph_meta.runId, "run-abc");
  assert.notEqual(dg.command, "dg");
  assert.doesNotMatch(dg.command, /dreamgraph/i);
  assert.deepEqual(
    [...artifact.content._dreamgraph_meta.allowlist],
    ["query_resource", "read_source_code"],
  );
});

test("mcp-config: caller env wins for arbitrary keys, never for token", () => {
  const artifact = buildCopilotMcpConfig({
    runId: "run-1",
    transportToken: "tok-real",
    dreamgraphCommand: "node",
    dreamgraphArgs: [],
    dreamgraphEnv: {
      DEBUG: "dreamgraph:*",
      DREAMGRAPH_MCP_TOKEN: "tok-fake-from-caller",
    },
    allowlist: ["query_resource"],
  });

  const env = artifact.content.mcpServers[DREAMGRAPH_AUTHORITATIVE_SERVER_NAME]!.env;
  assert.equal(env.DEBUG, "dreamgraph:*");
  // Adapter-supplied token MUST overwrite any caller-supplied one.
  assert.equal(env.DREAMGRAPH_MCP_TOKEN, "tok-real");
});

test("mcp-config: serialization is stable and ends in newline", () => {
  const artifact = buildCopilotMcpConfig({
    runId: "r",
    transportToken: "t",
    dreamgraphCommand: "node",
    dreamgraphArgs: ["./bridge.js"],
    allowlist: ["query_resource"],
  });

  const a = serializeCopilotMcpConfig(artifact);
  const b = serializeCopilotMcpConfig(artifact);
  assert.equal(a, b);
  assert.ok(a.endsWith("\n"));
  // Two-space indent sanity check.
  assert.ok(a.includes('\n  "mcpServers"'));
});

test("mcp-config: rejects empty inputs with explicit messages", () => {
  assert.throws(
    () =>
      buildCopilotMcpConfig({
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
      buildCopilotMcpConfig({
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
      buildCopilotMcpConfig({
        runId: "r",
        transportToken: "t",
        dreamgraphCommand: "node",
        dreamgraphArgs: [],
        allowlist: [],
      }),
    /allowlist must contain at least one tool/,
  );
});

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

const FULL_SURFACE: CopilotHelpSurface = parseCopilotHelpSurface(FULL_HELP);
const MINIMAL_SURFACE: CopilotHelpSurface = parseCopilotHelpSurface(MINIMAL_HELP);

test("argv: emits model, allow-all-tools, native shell allow, deny-write, allow-tool per allowlist, prompt", () => {
  const plan = buildCopilotArgv({
    prompt: "Plan a refactor.",
    model: "claude-sonnet-4.5",
    authoritativeServer: DREAMGRAPH_AUTHORITATIVE_SERVER_NAME,
    authoritativeAllowlist: ["query_resource", "read_source_code"],
    helpSurface: FULL_SURFACE,
  });

  assert.deepEqual(
    [...plan.args],
    [
      "--model", "claude-sonnet-4.5",
      "--allow-all-tools",
      "--output-format", "json",
      "--deny-tool", "shell",
      "--deny-tool", "write",
      "--allow-tool", "dreamgraph(query_resource)",
      "--allow-tool", "dreamgraph(read_source_code)",
      "--disallow-temp-dir",
      "--prompt", "Plan a refactor.",
    ],
  );

  assert.equal(plan.policy.tempDirDisallowed, true);
  assert.equal(plan.policy.inlineShellDenied, true);
  assert.equal(plan.policy.inlineWriteDenied, true);
  assert.equal(plan.policy.allowAllToolsEnabled, true);
  assert.equal(plan.policy.availableToolsRestricted, false);
  assert.deepEqual(
    [...plan.policy.allowedToolSpecs],
    ["dreamgraph(query_resource)", "dreamgraph(read_source_code)"],
  );
  assert.deepEqual([...plan.policy.allowedNativeToolSpecs], []);
  assert.deepEqual([...plan.policy.deniedToolSpecs], ["shell", "write"]);
});

test("argv: no native command tools are advertised; shell execution is routed exclusively through dreamgraph:run_command", () => {
  const plan = buildCopilotArgv({
    prompt: "Run tests.",
    authoritativeServer: DREAMGRAPH_AUTHORITATIVE_SERVER_NAME,
    authoritativeAllowlist: ["run_command"],
    helpSurface: FULL_SURFACE,
  });

  assert.deepEqual([...COPILOT_NATIVE_COMMAND_TOOLS], []);
  assert.ok(!plan.args.includes("powershell"), "powershell must not be advertised: Copilot CLI 1.x has no such native tool");
  assert.ok(plan.args.includes("--deny-tool"));
  // shell is the real native shell tool; it must remain denied so the model is forced through dreamgraph:run_command
  const denyIdxs = plan.args.reduce<number[]>((acc, v, i) => (v === "--deny-tool" ? [...acc, i] : acc), []);
  const deniedVals = denyIdxs.map((i) => plan.args[i + 1]);
  assert.ok(deniedVals.includes("shell"));
  assert.deepEqual([...plan.policy.allowedNativeToolSpecs], []);
  assert.ok(plan.args.includes("dreamgraph(run_command)"));
});

test("argv: emits one --add-dir per addDirs entry, ordered, after --disallow-temp-dir and before --prompt", () => {
  const plan = buildCopilotArgv({
    prompt: "Hi.",
    authoritativeServer: DREAMGRAPH_AUTHORITATIVE_SERVER_NAME,
    authoritativeAllowlist: ["query_resource"],
    helpSurface: FULL_SURFACE,
    addDirs: ["C:/tmp/run-abc", "/var/tmp/run-xyz"],
  });
  const tempDirIdx = plan.args.indexOf("--disallow-temp-dir");
  const addDirIdx1 = plan.args.indexOf("--add-dir");
  const promptIdx = plan.args.indexOf("--prompt");
  assert.ok(tempDirIdx >= 0 && addDirIdx1 > tempDirIdx && promptIdx > addDirIdx1);
  assert.equal(plan.args[addDirIdx1 + 1], "C:/tmp/run-abc");
  assert.equal(plan.args[addDirIdx1 + 2], "--add-dir");
  assert.equal(plan.args[addDirIdx1 + 3], "/var/tmp/run-xyz");
  assert.deepEqual([...plan.policy.addedDirs], ["C:/tmp/run-abc", "/var/tmp/run-xyz"]);
});

test("argv: omits --add-dir entirely when addDirs is empty or absent", () => {
  const plan = buildCopilotArgv({
    prompt: "Hi.",
    authoritativeServer: DREAMGRAPH_AUTHORITATIVE_SERVER_NAME,
    authoritativeAllowlist: ["query_resource"],
    helpSurface: FULL_SURFACE,
  });
  assert.equal(plan.args.includes("--add-dir"), false);
  assert.deepEqual([...plan.policy.addedDirs], []);
});

test("argv: omits --disallow-temp-dir when help surface lacks it", () => {
  const plan = buildCopilotArgv({
    prompt: "Hi.",
    authoritativeServer: DREAMGRAPH_AUTHORITATIVE_SERVER_NAME,
    authoritativeAllowlist: ["query_resource"],
    helpSurface: MINIMAL_SURFACE,
  });
  assert.equal(plan.args.includes("--disallow-temp-dir"), false);
  assert.equal(plan.policy.tempDirDisallowed, false);
});

test("argv: never emits --additional-mcp-config (data plane lives on disk)", () => {
  // Per the LARGE PAYLOAD ISOLATION RULE the adapter delivers MCP
  // configuration via `<COPILOT_HOME>/mcp-config.json` inside an
  // isolated per-run COPILOT_HOME (set in env by the orchestrator).
  // Argv carries only small fixed-vocabulary control flags. Even
  // when the running CLI advertises `--additional-mcp-config` in
  // its help surface, the builder MUST NOT emit it — doing so would
  // re-introduce the cross-platform argv quoting and length
  // hazards the rule exists to eliminate.
  const plan = buildCopilotArgv({
    prompt: "Hi.",
    authoritativeServer: DREAMGRAPH_AUTHORITATIVE_SERVER_NAME,
    authoritativeAllowlist: ["query_resource"],
    helpSurface: FULL_SURFACE,
  });
  assert.equal(plan.args.includes("--additional-mcp-config"), false);
  for (const a of plan.args) {
    assert.ok(
      !(a.startsWith("{") && a.includes("mcpServers")),
      `argv token must not carry MCP JSON: ${a}`,
    );
  }
});

test("argv: always emits --allow-all-tools (required for non-interactive mode)", () => {
  const plan = buildCopilotArgv({
    prompt: "Hi.",
    authoritativeServer: DREAMGRAPH_AUTHORITATIVE_SERVER_NAME,
    authoritativeAllowlist: ["query_resource"],
    helpSurface: FULL_SURFACE,
  });
  assert.equal(plan.args.includes("--allow-all-tools"), true);
  assert.equal(plan.policy.allowAllToolsEnabled, true);
  // Safety preserved: shell + write are still denied AFTER --allow-all-tools.
  const allowAllIdx = plan.args.indexOf("--allow-all-tools");
  const denyShellIdx = plan.args.indexOf("shell");
  assert.ok(denyShellIdx > allowAllIdx);
});

test("argv: rejects empty prompt and empty allowlist", () => {
  assert.throws(
    () =>
      buildCopilotArgv({
        prompt: "",
        authoritativeServer: DREAMGRAPH_AUTHORITATIVE_SERVER_NAME,
        authoritativeAllowlist: ["query_resource"],
        helpSurface: FULL_SURFACE,
      }),
    /prompt is required/,
  );
  assert.throws(
    () =>
      buildCopilotArgv({
        prompt: "Hi.",
        authoritativeServer: DREAMGRAPH_AUTHORITATIVE_SERVER_NAME,
        authoritativeAllowlist: [],
        helpSurface: FULL_SURFACE,
      }),
    /authoritativeAllowlist must be non-empty/,
  );
});

// ---------------------------------------------------------------------------
// transcript-classifier
// ---------------------------------------------------------------------------

const CLASSIFY_CTX = {
  authoritativeServer: DREAMGRAPH_AUTHORITATIVE_SERVER_NAME,
  allowlist: ["query_resource", "read_source_code"] as const,
};

test("classifier: dreamgraph + allowlisted tool → authoritative", () => {
  assert.equal(
    classifyToolCall({ server: "dreamgraph", tool: "query_resource" }, CLASSIFY_CTX),
    "dreamgraph_authoritative",
  );
});

test("classifier: dreamgraph + non-allowlisted tool → rejected", () => {
  assert.equal(
    classifyToolCall({ server: "dreamgraph", tool: "edit_file" }, CLASSIFY_CTX),
    "dreamgraph_rejected",
  );
});

test("classifier: third-party MCP server → generic_context_mcp", () => {
  assert.equal(
    classifyToolCall({ server: "github", tool: "search_issues" }, CLASSIFY_CTX),
    "generic_context_mcp",
  );
});

test("classifier: inline sentinel → provider_inline_tool", () => {
  assert.equal(
    classifyToolCall(
      { server: COPILOT_INLINE_TOOL_SERVER, tool: "shell" },
      CLASSIFY_CTX,
    ),
    "provider_inline_tool",
  );
});
