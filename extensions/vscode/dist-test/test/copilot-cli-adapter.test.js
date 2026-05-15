"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — Slice 1 pure-module tests.
//
// Covers help-probe, mcp-config generator, allowlist builder,
// argv builder, transcript classifier. No I/O, no spawn — every
// input is a literal string or object so the suite runs in <1s.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const index_js_1 = require("../architect-core/adapters/copilot-cli/index.js");
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
(0, node_test_1.default)("help-probe: parses full help surface", () => {
    const s = (0, index_js_1.parseCopilotHelpSurface)(FULL_HELP, "copilot 1.4.2");
    strict_1.default.equal(s.versionString, "copilot 1.4.2");
    strict_1.default.equal(s.required.prompt, true);
    strict_1.default.equal(s.required.allowTool, true);
    strict_1.default.equal(s.required.denyTool, true);
    strict_1.default.equal(s.required.model, true);
    strict_1.default.equal(s.required.allowAllTools, true);
    strict_1.default.equal(s.optional.additionalMcpConfig, true);
    strict_1.default.equal(s.optional.availableTools, true);
    strict_1.default.equal(s.optional.disallowTempDir, true);
    strict_1.default.equal(s.optional.allowUrl, true);
    strict_1.default.equal(s.optional.denyUrl, true);
    strict_1.default.ok((0, index_js_1.isHelpSurfaceSupported)(s));
});
(0, node_test_1.default)("help-probe: minimal help is supported (only required flags)", () => {
    const s = (0, index_js_1.parseCopilotHelpSurface)(MINIMAL_HELP);
    strict_1.default.equal(s.versionString, null);
    strict_1.default.equal(s.required.prompt, true);
    strict_1.default.equal(s.required.allowTool, true);
    strict_1.default.equal(s.required.denyTool, true);
    strict_1.default.equal(s.required.model, true);
    strict_1.default.equal(s.required.allowAllTools, true);
    strict_1.default.equal(s.optional.additionalMcpConfig, true);
    strict_1.default.equal(s.optional.availableTools, false);
    strict_1.default.equal(s.optional.disallowTempDir, false);
    strict_1.default.ok((0, index_js_1.isHelpSurfaceSupported)(s));
});
(0, node_test_1.default)("help-probe: empty help fails the support check", () => {
    const s = (0, index_js_1.parseCopilotHelpSurface)(EMPTY_HELP);
    strict_1.default.equal((0, index_js_1.isHelpSurfaceSupported)(s), false);
});
(0, node_test_1.default)("help-probe: missing single required flag fails the support check", () => {
    const partial = MINIMAL_HELP.replace("--deny-tool <spec>", "--banana <bunch>");
    const s = (0, index_js_1.parseCopilotHelpSurface)(partial);
    strict_1.default.equal(s.required.denyTool, false);
    strict_1.default.equal((0, index_js_1.isHelpSurfaceSupported)(s), false);
});
(0, node_test_1.default)("help-probe: undefined help text yields zero-length surface, not throw", () => {
    // @ts-expect-error — exercising defensive runtime handling.
    const s = (0, index_js_1.parseCopilotHelpSurface)(undefined);
    strict_1.default.equal(s.rawLength, 0);
    strict_1.default.equal((0, index_js_1.isHelpSurfaceSupported)(s), false);
});
// ---------------------------------------------------------------------------
// allowlist
// ---------------------------------------------------------------------------
(0, node_test_1.default)("allowlist: live registry with all required tools is ok", () => {
    const a = (0, index_js_1.buildAuthoritativeAllowlist)([
        ...index_js_1.COPILOT_REQUIRED_AUTHORITATIVE_TOOLS,
        "extra_unrelated_tool",
    ]);
    strict_1.default.equal(a.ok, true);
    strict_1.default.equal(a.missingRequired.length, 0);
    strict_1.default.deepEqual([...a.tools].sort(), [...index_js_1.COPILOT_REQUIRED_AUTHORITATIVE_TOOLS].sort());
});
(0, node_test_1.default)("allowlist: missing required tool flips ok to false", () => {
    const partial = index_js_1.COPILOT_REQUIRED_AUTHORITATIVE_TOOLS.slice(0, -1);
    const a = (0, index_js_1.buildAuthoritativeAllowlist)(partial);
    strict_1.default.equal(a.ok, false);
    strict_1.default.deepEqual([...a.missingRequired], [index_js_1.COPILOT_REQUIRED_AUTHORITATIVE_TOOLS[index_js_1.COPILOT_REQUIRED_AUTHORITATIVE_TOOLS.length - 1]]);
});
(0, node_test_1.default)("allowlist: empty registry reports all required as missing", () => {
    const a = (0, index_js_1.buildAuthoritativeAllowlist)([]);
    strict_1.default.equal(a.ok, false);
    strict_1.default.equal(a.missingRequired.length, index_js_1.COPILOT_REQUIRED_AUTHORITATIVE_TOOLS.length);
});
// ---------------------------------------------------------------------------
// mcp-config
// ---------------------------------------------------------------------------
(0, node_test_1.default)("mcp-config: builds a deterministic single-server artifact", () => {
    const artifact = (0, index_js_1.buildCopilotMcpConfig)({
        runId: "run-abc",
        transportToken: "tok-xyz",
        dreamgraphCommand: "node",
        dreamgraphArgs: ["./mcp-bridge.js", "--mode", "authoritative"],
        allowlist: ["query_resource", "read_source_code"],
    });
    strict_1.default.equal(artifact.filename, "mcp-config.json");
    const servers = artifact.content.mcpServers;
    const names = Object.keys(servers);
    strict_1.default.deepEqual(names, [index_js_1.DREAMGRAPH_AUTHORITATIVE_SERVER_NAME]);
    const dg = servers[index_js_1.DREAMGRAPH_AUTHORITATIVE_SERVER_NAME];
    strict_1.default.equal(dg.type, "stdio");
    strict_1.default.equal(dg.command, "node");
    strict_1.default.deepEqual([...dg.args], ["./mcp-bridge.js", "--mode", "authoritative"]);
    strict_1.default.equal(dg.env.DREAMGRAPH_MCP_TOKEN, "tok-xyz");
    strict_1.default.equal(dg.env.DREAMGRAPH_RUN_ID, "run-abc");
    strict_1.default.equal(artifact.content._dreamgraph_meta.runId, "run-abc");
    strict_1.default.deepEqual([...artifact.content._dreamgraph_meta.allowlist], ["query_resource", "read_source_code"]);
});
(0, node_test_1.default)("mcp-config: caller env wins for arbitrary keys, never for token", () => {
    const artifact = (0, index_js_1.buildCopilotMcpConfig)({
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
    const env = artifact.content.mcpServers[index_js_1.DREAMGRAPH_AUTHORITATIVE_SERVER_NAME].env;
    strict_1.default.equal(env.DEBUG, "dreamgraph:*");
    // Adapter-supplied token MUST overwrite any caller-supplied one.
    strict_1.default.equal(env.DREAMGRAPH_MCP_TOKEN, "tok-real");
});
(0, node_test_1.default)("mcp-config: serialization is stable and ends in newline", () => {
    const artifact = (0, index_js_1.buildCopilotMcpConfig)({
        runId: "r",
        transportToken: "t",
        dreamgraphCommand: "node",
        dreamgraphArgs: ["./bridge.js"],
        allowlist: ["query_resource"],
    });
    const a = (0, index_js_1.serializeCopilotMcpConfig)(artifact);
    const b = (0, index_js_1.serializeCopilotMcpConfig)(artifact);
    strict_1.default.equal(a, b);
    strict_1.default.ok(a.endsWith("\n"));
    // Two-space indent sanity check.
    strict_1.default.ok(a.includes('\n  "mcpServers"'));
});
(0, node_test_1.default)("mcp-config: rejects empty inputs with explicit messages", () => {
    strict_1.default.throws(() => (0, index_js_1.buildCopilotMcpConfig)({
        runId: "",
        transportToken: "t",
        dreamgraphCommand: "node",
        dreamgraphArgs: [],
        allowlist: ["query_resource"],
    }), /runId is required/);
    strict_1.default.throws(() => (0, index_js_1.buildCopilotMcpConfig)({
        runId: "r",
        transportToken: "t",
        dreamgraphCommand: "",
        dreamgraphArgs: [],
        allowlist: ["query_resource"],
    }), /dreamgraphCommand is required/);
    strict_1.default.throws(() => (0, index_js_1.buildCopilotMcpConfig)({
        runId: "r",
        transportToken: "t",
        dreamgraphCommand: "node",
        dreamgraphArgs: [],
        allowlist: [],
    }), /allowlist must contain at least one tool/);
});
// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------
const FULL_SURFACE = (0, index_js_1.parseCopilotHelpSurface)(FULL_HELP);
const MINIMAL_SURFACE = (0, index_js_1.parseCopilotHelpSurface)(MINIMAL_HELP);
(0, node_test_1.default)("argv: emits model, allow-all-tools, deny-shell, deny-write, allow-tool per allowlist, prompt", () => {
    const plan = (0, index_js_1.buildCopilotArgv)({
        prompt: "Plan a refactor.",
        model: "claude-sonnet-4.5",
        authoritativeServer: index_js_1.DREAMGRAPH_AUTHORITATIVE_SERVER_NAME,
        authoritativeAllowlist: ["query_resource", "read_source_code"],
        helpSurface: FULL_SURFACE,
    });
    strict_1.default.deepEqual([...plan.args], [
        "--model", "claude-sonnet-4.5",
        "--allow-all-tools",
        "--deny-tool", "shell",
        "--deny-tool", "write",
        "--allow-tool", "dreamgraph:query_resource",
        "--allow-tool", "dreamgraph:read_source_code",
        "--disallow-temp-dir",
        "--prompt", "Plan a refactor.",
    ]);
    strict_1.default.equal(plan.policy.tempDirDisallowed, true);
    strict_1.default.equal(plan.policy.inlineShellDenied, true);
    strict_1.default.equal(plan.policy.inlineWriteDenied, true);
    strict_1.default.equal(plan.policy.allowAllToolsEnabled, true);
    strict_1.default.equal(plan.policy.availableToolsRestricted, false);
    strict_1.default.deepEqual([...plan.policy.allowedToolSpecs], ["dreamgraph:query_resource", "dreamgraph:read_source_code"]);
    strict_1.default.deepEqual([...plan.policy.deniedToolSpecs], ["shell", "write"]);
});
(0, node_test_1.default)("argv: omits --disallow-temp-dir when help surface lacks it", () => {
    const plan = (0, index_js_1.buildCopilotArgv)({
        prompt: "Hi.",
        authoritativeServer: index_js_1.DREAMGRAPH_AUTHORITATIVE_SERVER_NAME,
        authoritativeAllowlist: ["query_resource"],
        helpSurface: MINIMAL_SURFACE,
    });
    strict_1.default.equal(plan.args.includes("--disallow-temp-dir"), false);
    strict_1.default.equal(plan.policy.tempDirDisallowed, false);
});
(0, node_test_1.default)("argv: never emits --additional-mcp-config (data plane lives on disk)", () => {
    // Per the LARGE PAYLOAD ISOLATION RULE the adapter delivers MCP
    // configuration via `<COPILOT_HOME>/mcp-config.json` inside an
    // isolated per-run COPILOT_HOME (set in env by the orchestrator).
    // Argv carries only small fixed-vocabulary control flags. Even
    // when the running CLI advertises `--additional-mcp-config` in
    // its help surface, the builder MUST NOT emit it — doing so would
    // re-introduce the cross-platform argv quoting and length
    // hazards the rule exists to eliminate.
    const plan = (0, index_js_1.buildCopilotArgv)({
        prompt: "Hi.",
        authoritativeServer: index_js_1.DREAMGRAPH_AUTHORITATIVE_SERVER_NAME,
        authoritativeAllowlist: ["query_resource"],
        helpSurface: FULL_SURFACE,
    });
    strict_1.default.equal(plan.args.includes("--additional-mcp-config"), false);
    for (const a of plan.args) {
        strict_1.default.ok(!(a.startsWith("{") && a.includes("mcpServers")), `argv token must not carry MCP JSON: ${a}`);
    }
});
(0, node_test_1.default)("argv: always emits --allow-all-tools (required for non-interactive mode)", () => {
    const plan = (0, index_js_1.buildCopilotArgv)({
        prompt: "Hi.",
        authoritativeServer: index_js_1.DREAMGRAPH_AUTHORITATIVE_SERVER_NAME,
        authoritativeAllowlist: ["query_resource"],
        helpSurface: FULL_SURFACE,
    });
    strict_1.default.equal(plan.args.includes("--allow-all-tools"), true);
    strict_1.default.equal(plan.policy.allowAllToolsEnabled, true);
    // Safety preserved: shell + write are still denied AFTER --allow-all-tools.
    const allowAllIdx = plan.args.indexOf("--allow-all-tools");
    const denyShellIdx = plan.args.indexOf("shell");
    strict_1.default.ok(denyShellIdx > allowAllIdx);
});
(0, node_test_1.default)("argv: rejects empty prompt and empty allowlist", () => {
    strict_1.default.throws(() => (0, index_js_1.buildCopilotArgv)({
        prompt: "",
        authoritativeServer: index_js_1.DREAMGRAPH_AUTHORITATIVE_SERVER_NAME,
        authoritativeAllowlist: ["query_resource"],
        helpSurface: FULL_SURFACE,
    }), /prompt is required/);
    strict_1.default.throws(() => (0, index_js_1.buildCopilotArgv)({
        prompt: "Hi.",
        authoritativeServer: index_js_1.DREAMGRAPH_AUTHORITATIVE_SERVER_NAME,
        authoritativeAllowlist: [],
        helpSurface: FULL_SURFACE,
    }), /authoritativeAllowlist must be non-empty/);
});
// ---------------------------------------------------------------------------
// transcript-classifier
// ---------------------------------------------------------------------------
const CLASSIFY_CTX = {
    authoritativeServer: index_js_1.DREAMGRAPH_AUTHORITATIVE_SERVER_NAME,
    allowlist: ["query_resource", "read_source_code"],
};
(0, node_test_1.default)("classifier: dreamgraph + allowlisted tool → authoritative", () => {
    strict_1.default.equal((0, index_js_1.classifyToolCall)({ server: "dreamgraph", tool: "query_resource" }, CLASSIFY_CTX), "dreamgraph_authoritative");
});
(0, node_test_1.default)("classifier: dreamgraph + non-allowlisted tool → rejected", () => {
    strict_1.default.equal((0, index_js_1.classifyToolCall)({ server: "dreamgraph", tool: "edit_file" }, CLASSIFY_CTX), "dreamgraph_rejected");
});
(0, node_test_1.default)("classifier: third-party MCP server → generic_context_mcp", () => {
    strict_1.default.equal((0, index_js_1.classifyToolCall)({ server: "github", tool: "search_issues" }, CLASSIFY_CTX), "generic_context_mcp");
});
(0, node_test_1.default)("classifier: inline sentinel → provider_inline_tool", () => {
    strict_1.default.equal((0, index_js_1.classifyToolCall)({ server: index_js_1.COPILOT_INLINE_TOOL_SERVER, tool: "shell" }, CLASSIFY_CTX), "provider_inline_tool");
});
//# sourceMappingURL=copilot-cli-adapter.test.js.map