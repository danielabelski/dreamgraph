import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import {
  ensureArchitectNativeSupportTools,
  missingRequiredArchitectToolCalls,
  selectArchitectTools,
  synthesizeArchitectNativeToolLoopRecoveryText,
  type ArchitectToolTraceEntry,
} from "../src/architect/native-tool-loop.js";
import { ARCHITECT_TOOL_GROUPS, isRequiredArchitectToolSatisfied, selectArchitectToolNames } from "../src/architect/tool-selection.js";
import { decideArchitectContinuation, parseArchitectContinuationEnvelope } from "../src/architect/continuation.js";

function tool(name: string): any {
  return {
    name,
    description: `${name} tool`,
    input_schema: { type: "object", properties: {} },
  };
}

describe("Architect native tool loop continuation manifests", () => {
  it("advertises required continuation tools even when message has no graph keywords", () => {
    const selection = selectArchitectTools([
      tool("query_resource"),
      tool("query_architecture_decisions"),
      tool("read_source_code"),
      tool("patch_file"),
      tool("run_command"),
      tool("search_source_code"),
      tool("cognitive_status"),
    ], {
      message: "Continue the selected action.",
      manifest: {
        required_tools: ["patch_file", "read_source_code", "patch_file"],
        preferred_tools: ["run_command", "search_source_code"],
      },
    });

    expect(selection.required_tools).toEqual(["patch_file", "read_source_code", "query_resource", "query_architecture_decisions"]);
    expect(selection.unavailable_required_tools).toEqual([]);
    expect(selection.tools.map((entry) => entry.name).slice(0, 4)).toEqual([
      "patch_file",
      "read_source_code",
      "query_resource",
      "query_architecture_decisions",
    ]);
  });

  it("reports unavailable required tools without using provider-invalid names", () => {
    const selection = selectArchitectTools([
      tool("query_resource"),
      tool("read_source_code"),
      tool("run_command"),
      tool("bad.tool"),
    ], {
      message: "Continue the selected action.",
      manifest: {
        required_tools: ["patch_file", "read_source_code", "bad.tool"],
        preferred_tools: ["run_command"],
      },
    });

    expect(selection.required_tools).toEqual(["patch_file", "read_source_code", "query_resource", "query_architecture_decisions"]);
    expect(selection.unavailable_required_tools).toEqual(["patch_file", "query_architecture_decisions"]);
    expect(selection.tools.map((entry) => entry.name)).toContain("read_source_code");
    expect(selection.tools.map((entry) => entry.name)).not.toContain("bad.tool");
  });

  it("infers and advertises mutation and verification tools from continuation text even when manifest is weak", () => {
    const available = [
      tool("query_resource"),
      tool("query_architecture_decisions"),
      tool("graph_health_report"),
      tool("search_source_code"),
      tool("read_source_code"),
      tool("list_directory"),
      tool("patch_file"),
      tool("run_command"),
      tool("append_to_file"),
      tool("enrich_seed_data"),
    ];
    const selection = selectArchitectTools(available, {
      message: "Add focused tests proving runtimeDir chat history persistence, then run targeted vitest and a build/server sanity check.",
      manifest: {
        required_tools: ["read_source_code"],
        preferred_tools: [],
      },
    });

    expect(selection.required_tools).toEqual(["read_source_code", "query_resource", "query_architecture_decisions", "graph_health_report", "patch_file", "enrich_seed_data", "run_command"]);
    expect(selection.unavailable_required_tools).toEqual([]);
    expect(selection.tools.map((entry) => entry.name)).toEqual(expect.arrayContaining([
      "read_source_code",
      "patch_file",
      "run_command",
      "append_to_file",
    ]));
  });

  it("infers governed write tools from a manual continuation message without a token manifest", () => {
    const selection = selectArchitectTools([
      tool("query_resource"),
      tool("query_architecture_decisions"),
      tool("graph_health_report"),
      tool("search_source_code"),
      tool("read_source_code"),
      tool("list_directory"),
      tool("patch_file"),
      tool("run_command"),
      tool("enrich_seed_data"),
    ], "Continue with governed tools only. Add regression coverage in tests/standalone-architect-routes.test.ts and verify with vitest.");

    expect(selection.required_tools).toEqual(["query_resource", "query_architecture_decisions", "graph_health_report", "read_source_code", "patch_file", "enrich_seed_data", "run_command"]);
    expect(selection.tools.map((entry) => entry.name).slice(0, 7)).toEqual([
      "query_resource",
      "query_architecture_decisions",
      "graph_health_report",
      "read_source_code",
      "patch_file",
      "enrich_seed_data",
      "run_command",
    ]);
  });

  it("selects the full source patch and verification group for stable chat-history continuation prompts", () => {
    const available = [
      "query_resource",
      "graph_rag_retrieve",
      "graph_health_report",
      "query_api_surface",
      "search_source_code",
      "read_source_code",
      "list_directory",
      "patch_file",
      "edit_file",
      "create_file",
      "append_to_file",
      "rename_file",
      "delete_file",
      "run_command",
      "query_architecture_decisions",
      "enrich_seed_data",
    ].map(tool);
    const message = [
      "Continue selected action patch-stable-architect-chat-history-key.",
      "Inspect the Architect chat transcript path helper and relevant standalone route tests.",
      "Patch src/architect/routes.ts so default project-scope chat-history requests use a stable storage key.",
      "Add/update a regression proving restart hydration and run the relevant standalone Architect route tests.",
    ].join(" ");
    const selection = selectArchitectTools(available, {
      message,
      manifest: {
        required_tools: ["read_source_code"],
        preferred_tools: [],
      },
    });

    expect(selection.required_tools).toEqual(["read_source_code", "query_resource", "query_architecture_decisions", "graph_health_report", "patch_file", "enrich_seed_data", "run_command"]);
    expect(selection.groups).toEqual(expect.arrayContaining(["core_read", "source_write", "verification", "graph_write", "adr"]));
    expect(selection.tools.map((entry) => entry.name).slice(0, 7)).toEqual([
      "read_source_code",
      "query_resource",
      "query_architecture_decisions",
      "graph_health_report",
      "patch_file",
      "enrich_seed_data",
      "run_command",
    ]);
    expect(selection.tools.map((entry) => entry.name)).toEqual(expect.arrayContaining([
      "edit_file",
      "create_file",
      "append_to_file",
      "run_command",
    ]));
  });

  it("keeps grouped selection available from the standalone planner for patch and verification passes", () => {
    const decision = selectArchitectToolNames({
      prompt: "Patch src/architect/routes.ts, add a regression in tests/standalone-architect-routes.test.ts, then run targeted vitest and build checks.",
      availableToolNames: [
        "query_resource",
        "query_architecture_decisions",
        "graph_health_report",
        "search_source_code",
        "read_source_code",
        "list_directory",
        "patch_file",
        "append_to_file",
        "edit_file",
        "create_file",
        "enrich_seed_data",
        "run_command",
      ],
      manifest: null,
      autonomy: false,
    });

    expect(decision.required_tools).toEqual(["query_resource", "query_architecture_decisions", "graph_health_report", "read_source_code", "patch_file", "enrich_seed_data", "run_command"]);
    expect(decision.selected).toEqual(expect.arrayContaining([
      "query_resource",
      "search_source_code",
      "read_source_code",
      "patch_file",
      "append_to_file",
      "run_command",
    ]));
    expect(decision.mutating).toBe(true);
    expect(decision.verifying).toBe(true);
  });

  it("requires health assessment and a targeted dream schedule for major implementation work", () => {
    const decision = selectArchitectToolNames({
      prompt: "Implement a new cross-module workflow and verify the feature with focused tests.",
      availableToolNames: [
        "query_resource", "query_architecture_decisions", "graph_health_report",
        "read_source_code", "patch_file", "enrich_seed_data", "schedule_dream", "run_command",
      ],
      manifest: null,
      autonomy: false,
    });

    expect(decision.required_tools).toEqual(expect.arrayContaining([
      "graph_health_report",
      "enrich_seed_data",
      "schedule_dream",
    ]));
    expect(decision.unavailable_required_tools).toEqual([]);
  });

  it("exposes the governed MCP action for a user-requested re-scan", () => {
    const decision = selectArchitectToolNames({
      prompt: "Re-scan project and refresh UI metadata.",
      availableToolNames: [
        "query_resource", "query_architecture_decisions", "graph_health_report", "scan_project",
      ],
      manifest: null,
      autonomy: false,
    });

    expect(decision.required_tools).toContain("graph_health_report");
    expect(decision.selected).toContain("scan_project");
    expect(decision.required_tools).not.toContain("bootstrap_instance");
  });

  it("always pins run_command when it is present in the native tool surface", () => {
    const decision = selectArchitectToolNames({
      prompt: "What is the graph health?",
      availableToolNames: [
        "cognitive_status",
        "query_resource",
        "query_architecture_decisions",
        "read_source_code",
        "run_command",
      ],
      manifest: null,
      autonomy: true,
    });

    expect(decision.required_tools).toEqual(["query_resource", "query_architecture_decisions"]);
    expect(decision.selected).toContain("run_command");
    expect(decision.rationale).toContain("pinned[run_command]");
  });

  it("keeps pinned run_command when the selected tool surface is capped", () => {
    const availableToolNames = [
      "run_command",
      ...new Set(Object.values(ARCHITECT_TOOL_GROUPS).flat()),
    ];
    const decision = selectArchitectToolNames({
      prompt: [
        "Patch source, verify with tests, update ADR context, inspect UI registry,",
        "review cognitive dream status, schedule follow-up, scan_project, generate visual flow,",
        "and complete discipline verification.",
      ].join(" "),
      availableToolNames,
      autonomy: true,
    });

    expect(decision.selected).toContain("run_command");
    expect(decision.rationale).toContain("pinned[run_command]");
    expect(decision.rationale).toContain("cap=");
  });

  it("adds native run_command as a daemon support tool when upstream MCP omits it", () => {
    const tools = ensureArchitectNativeSupportTools([
      tool("query_resource"),
      tool("read_source_code"),
    ]);

    expect(tools.map((entry) => entry.name)).toEqual([
      "query_resource",
      "read_source_code",
      "run_command",
    ]);
    expect(tools.find((entry) => entry.name === "run_command")?.inputSchema).toMatchObject({
      required: ["command"],
    });
  });

  it("suppresses stale mutation tools when the current prompt forbids file mutation", () => {
    const decision = selectArchitectToolNames({
      prompt: "Run the bounded verification using run_command only. Do not mutate files.",
      availableToolNames: [
        "query_resource",
        "query_architecture_decisions",
        "read_source_code",
        "patch_file",
        "append_to_file",
        "run_command",
      ],
      manifest: {
        required_tools: ["patch_file"],
        preferred_tools: ["append_to_file"],
      },
      autonomy: true,
    });

    expect(decision.required_tools).toEqual(["query_resource", "query_architecture_decisions", "run_command"]);
    expect(decision.selected).toContain("run_command");
    expect(decision.selected).not.toContain("patch_file");
    expect(decision.selected).not.toContain("append_to_file");
    expect(decision.rationale).toContain("no-mutation directive");
  });

  it("keeps missing mutation obligations when the retry prompt says inspect only as needed", () => {
    const decision = selectArchitectToolNames({
      prompt: [
        "Continue the same selected Architect pass.",
        "Satisfy these missing governed MCP tool obligations before finalizing: patch_file.",
        "Inspect only as needed, apply the requested mutation through DreamGraph MCP mutation tools, run the required verification through run_command when available, and finish with a fenced architect_continuation envelope.",
      ].join("\n"),
      availableToolNames: [
        "query_resource",
        "query_architecture_decisions",
        "read_source_code",
        "search_source_code",
        "patch_file",
        "enrich_seed_data",
        "run_command",
        "query_ui_elements",
      ],
      manifest: {
        required_tools: ["patch_file"],
        preferred_tools: ["read_source_code", "search_source_code", "run_command"],
      },
      autonomy: true,
    });

    expect(decision.required_tools).toEqual(["patch_file", "query_resource", "query_architecture_decisions", "read_source_code", "enrich_seed_data", "run_command"]);
    expect(decision.selected).toEqual(expect.arrayContaining(["query_resource", "query_architecture_decisions", "read_source_code", "patch_file", "enrich_seed_data", "run_command"]));
    expect(decision.required_tools).not.toContain("query_ui_elements");
    expect(decision.rationale).not.toContain("no-mutation directive");
    expect(decision.rationale).not.toContain("UI intent");
  });

  it("does not promote recovery prompt graph-write examples into required obligations", () => {
    const decision = selectArchitectToolNames({
      prompt: [
        "Continue the same selected Architect pass.",
        "Satisfy these missing governed MCP tool obligations before finalizing: patch_file, graph_rag_retrieve.",
        "Ground the pass with DreamGraph graph and ADR tools, apply any requested mutation through governed DreamGraph MCP mutation tools, record resulting source/graph/ADR changes through the appropriate graph-write tool such as enrich_seed_data, modify_api_surface, solidify_cognitive_insight, or record_architecture_decision, run required verification through run_command when available, and finish with a fenced architect_continuation envelope.",
      ].join("\n"),
      availableToolNames: [
        "query_resource",
        "query_architecture_decisions",
        "graph_rag_retrieve",
        "read_source_code",
        "search_source_code",
        "patch_file",
        "enrich_seed_data",
        "modify_api_surface",
        "solidify_cognitive_insight",
        "record_architecture_decision",
        "get_cognitive_preamble",
        "cognitive_status",
        "run_command",
      ],
      manifest: null,
      autonomy: true,
    });

    expect(decision.required_tools).toEqual(["query_resource", "query_architecture_decisions", "patch_file", "graph_rag_retrieve", "read_source_code", "enrich_seed_data", "run_command"]);
    expect(decision.selected).toEqual(expect.arrayContaining([
      "modify_api_surface",
      "solidify_cognitive_insight",
      "record_architecture_decision",
      "get_cognitive_preamble",
      "cognitive_status",
    ]));
    expect(decision.required_tools).not.toContain("modify_api_surface");
    expect(decision.required_tools).not.toContain("solidify_cognitive_insight");
    expect(decision.required_tools).not.toContain("record_architecture_decision");
    expect(decision.required_tools).not.toContain("get_cognitive_preamble");
    expect(decision.required_tools).not.toContain("cognitive_status");
  });

  it("keeps graph-only recovery prompts from re-requiring source mutation tools", () => {
    const decision = selectArchitectToolNames({
      prompt: [
        "Continue the same selected Architect pass.",
        "Satisfy these missing governed MCP tool obligations before finalizing: graph_rag_retrieve.",
        "Ground the pass with DreamGraph graph and ADR tools, apply any requested mutation through governed DreamGraph MCP mutation tools, record resulting source/graph/ADR changes through the appropriate graph-write tool, run required verification through run_command when available, and finish with a fenced architect_continuation envelope.",
      ].join("\n"),
      availableToolNames: [
        "query_resource",
        "query_architecture_decisions",
        "graph_rag_retrieve",
        "read_source_code",
        "patch_file",
        "enrich_seed_data",
        "run_command",
      ],
      manifest: null,
      autonomy: true,
    });

    expect(decision.required_tools).toEqual(["query_resource", "query_architecture_decisions", "graph_rag_retrieve"]);
    expect(decision.selected).toContain("graph_rag_retrieve");
    expect(decision.required_tools).not.toContain("patch_file");
    expect(decision.required_tools).not.toContain("enrich_seed_data");
    expect(decision.required_tools).not.toContain("run_command");
  });

  it("keeps directly named available tools exposed before broad group capping", () => {
    const availableToolNames = [
      "wire_links",
      "run_command",
      ...new Set(Object.values(ARCHITECT_TOOL_GROUPS).flat()),
    ];
    const decision = selectArchitectToolNames({
      prompt: [
        "Patch source, verify with tests, update ADR context, inspect UI registry,",
        "review cognitive dream status, schedule follow-up, scan_project, generate visual flow,",
        "complete discipline verification, and use wire_links for graph evidence.",
      ].join(" "),
      availableToolNames,
      autonomy: true,
    });

    expect(decision.selected).toContain("wire_links");
    expect(decision.rationale).toContain("tool-name[wire_links]");
    expect(decision.rationale).toContain("cap=");
  });

  it("does not pass unrelated unknown tools through during high-intent mutation passes", () => {
    const decision = selectArchitectToolNames({
      prompt: "Patch src/architect/routes.ts and run tests.",
      availableToolNames: [
        "query_resource",
        "read_source_code",
        "patch_file",
        "run_command",
        "get_workflow",
        "webhook_register",
      ],
      manifest: null,
      autonomy: true,
    });

    expect(decision.selected).toEqual(expect.arrayContaining(["read_source_code", "patch_file", "run_command"]));
    expect(decision.selected).not.toContain("get_workflow");
    expect(decision.selected).not.toContain("webhook_register");
  });

  it("detects unsatisfied required mutation and verification obligations after read-only tool use", () => {
    const trace: ArchitectToolTraceEntry[] = [{
      iteration: 1,
      tool: "read_source_code",
      args_summary: "src/architect/routes.ts",
      status: "completed",
      duration_ms: 10,
      result_preview: "route code",
    }];

    expect(missingRequiredArchitectToolCalls({
      required_tools: ["read_source_code", "patch_file", "run_command"],
      unavailable_required_tools: [],
    }, trace)).toEqual(["patch_file", "run_command"]);
  });

  it("treats equivalent governed mutation and read tools as satisfying required obligations", () => {
    expect(isRequiredArchitectToolSatisfied("read_source_code", ["search_source_code"])).toBe(true);
    expect(isRequiredArchitectToolSatisfied("patch_file", ["append_to_file"])).toBe(true);
    expect(isRequiredArchitectToolSatisfied("enrich_seed_data", ["modify_api_surface"])).toBe(true);
    expect(isRequiredArchitectToolSatisfied("enrich_seed_data", ["record_architecture_decision"])).toBe(true);
    expect(isRequiredArchitectToolSatisfied("run_command", ["append_to_file"])).toBe(false);
    expect(missingRequiredArchitectToolCalls({
      required_tools: ["read_source_code", "patch_file", "enrich_seed_data", "run_command"],
      unavailable_required_tools: [],
    }, [
      {
        iteration: 1,
        tool: "search_source_code",
        args_summary: "routes",
        status: "completed",
        duration_ms: 10,
        result_preview: "matches",
      },
      {
        iteration: 1,
        tool: "append_to_file",
        args_summary: "docs/workflows/_index.md",
        status: "completed",
        duration_ms: 10,
        result_preview: "ok",
      },
      {
        iteration: 1,
        tool: "modify_api_surface",
        args_summary: "src/architect/routes.ts",
        status: "completed",
        duration_ms: 10,
        result_preview: "api facts updated",
      },
      {
        iteration: 2,
        tool: "run_command",
        args_summary: "npm test",
        status: "failed",
        duration_ms: 10,
        result_preview: "test failed",
      },
    ])).toEqual([]);
  });

  it("keeps the legacy priority heuristic for non-continuation turns", () => {
    const selection = selectArchitectTools([
      tool("search_source_code"),
      tool("query_resource"),
      tool("query_architecture_decisions"),
      tool("cognitive_status"),
    ], "What is the graph health?");

    expect(selection.tools.map((entry) => entry.name).slice(0, 2)).toEqual(["query_resource", "query_architecture_decisions"]);
    expect(selection.required_tools).toEqual(["query_resource", "query_architecture_decisions"]);
  });

  it("finalizes tool-using native turns that return prose without a continuation envelope", async () => {
    const source = await readFile(new URL("../src/architect/native-tool-loop.ts", import.meta.url), "utf-8");

    expect(source).toContain("trace.length > 0 && !hasArchitectContinuationEnvelopeText(finalText)");
    expect(source).toContain("rawMessages.push({ role: \"assistant\", content: finalText.trim() });");
    expect(source).toContain("missing_continuation_envelope_after_tool_use");
    expect(source).toContain("synthesizeArchitectNativeToolLoopRecoveryText");
    expect(source).toContain("function hasArchitectContinuationEnvelopeText");
  });

  it("synthesizes a parseable continuation envelope after native tool work when the provider omits one", () => {
    const trace: ArchitectToolTraceEntry[] = [{
      iteration: 1,
      tool: "append_to_file",
      args_summary: JSON.stringify({ filePath: "docs/workflows/_index.md", content: "<!-- marker -->" }),
      status: "completed",
      duration_ms: 12,
      result_preview: JSON.stringify({ success: true }),
    }];
    const text = synthesizeArchitectNativeToolLoopRecoveryText({
      assistantText: "Slice 5 completed: appended the continuation proof marker.",
      trace,
      stopReason: "missing_continuation_envelope_after_tool_use",
    });
    const parseResult = parseArchitectContinuationEnvelope(text, {
      selected_plan_id: "architect-continuation-proof-test",
      chat_scope: "plan",
      now: new Date("2026-06-11T00:00:00.000Z"),
    });
    const decision = decideArchitectContinuation({
      parseResult,
      context: {
        selected_plan_id: "architect-continuation-proof-test",
        chat_scope: "plan",
        completed_passes: 1,
        max_passes: 50,
        now: new Date("2026-06-11T00:00:00.000Z"),
      },
      autonomyAllowsContinue: true,
    });

    expect(text).toContain("```architect_continuation");
    expect(parseResult.envelope).toMatchObject({
      pass_id: "native-tool-loop-recovered",
      status: "completed",
      files_touched: ["docs/workflows/_index.md"],
      stop_reason: "missing_continuation_envelope_after_tool_use",
    });
    expect(parseResult.report.work_completed).toContain("append_to_file -> docs/workflows/_index.md (completed)");
    expect(parseResult.report.recommended_next_step).toMatchObject({
      id: "continue-from-recovered-native-tool-loop",
      safe: true,
    });
    expect(decision).toMatchObject({
      status: "continue",
      reason: "recommended_action_selected",
      selected_action: { id: "continue-from-recovered-native-tool-loop" },
    });
  });

  it("does not synthesize a continuation action when the provider text says all remaining work is complete", () => {
    const trace: ArchitectToolTraceEntry[] = [{
      iteration: 1,
      tool: "append_to_file",
      args_summary: JSON.stringify({ filePath: "docs/tensions/_index.md" }),
      status: "completed",
      duration_ms: 9,
      result_preview: JSON.stringify({ success: true }),
    }];
    const text = synthesizeArchitectNativeToolLoopRecoveryText({
      assistantText: "All remaining slices from the active plan preamble are now completed.",
      trace,
      stopReason: "missing_continuation_envelope_after_tool_use",
    });
    const parseResult = parseArchitectContinuationEnvelope(text, {
      selected_plan_id: "architect-continuation-proof-test",
      chat_scope: "plan",
      now: new Date("2026-06-11T00:00:00.000Z"),
    });

    expect(parseResult.envelope).toMatchObject({
      status: "completed",
      recommended_actions: [],
    });
    expect(parseResult.report.recommended_next_step).toBeNull();
  });
});
