import { describe, expect, it } from "vitest";

import {
  ARCHITECT_CONTINUATION_SCHEMA,
  buildArchitectContinuationPrompt,
  decideArchitectContinuation,
  decodeArchitectContinuationToken,
  parseArchitectContinuationEnvelope,
  synthesizeArchitectRecoveredContinuation,
  synthesizeArchitectRouteFailureContinuation,
} from "../src/architect/continuation.js";

const now = new Date("2026-06-08T20:30:00.000Z");

function validAssistantText(): string {
  return [
    "Slice report text.",
    "```architect_continuation",
    JSON.stringify({
      schema: ARCHITECT_CONTINUATION_SCHEMA,
      pass_id: "slice-1",
      status: "completed",
      summary: "Created the shared continuation contract.",
      work_completed: ["Added parser and token helpers."],
      files_touched: ["src/architect/continuation.ts"],
      graph_entities_touched: ["architect-continuation"],
      tool_trace_summary: ["read_source_code inspected plan", "create_file wrote module"],
      graph_plan_updates: ["implementation log pending"],
      evidence: ["tests cover parse and token validation"],
      blockers: [],
      uncertainty: 0.1,
      recommended_actions: [
        {
          id: "slice-2-adapter-routing",
          label: "Implement Slice 2",
          rationale: "Adapter manifests are the next dependency.",
          kind: "continue",
          prompt: "Add manifest routing to native and CLI adapters.",
          safe: true,
          recommended: true,
          required_tools: ["dreamgraph:read_source_code", "mcp__dreamgraph.patch_file", "runCommand", "bad tool name!"],
          preferred_tools: ["search_source_code", "dreamgraph:run_command", "search_source_code"],
        },
        {
          id: "unsafe-native-write",
          label: "Use native shell write\nnow",
          rationale: "Should remain visible but unavailable.",
          kind: "continue",
          prompt: "Use provider-native writes.",
          safe: false,
          recommended: false,
          required_tools: ["provider_native_shell"],
          preferred_tools: [],
          disabled_reason: "Out of policy.",
        },
        "not an action",
      ],
    }),
    "```",
  ].join("\n");
}

describe("Architect continuation contract", () => {
  it("parses valid envelopes into stable reports and sanitized action sets", () => {
    const result = parseArchitectContinuationEnvelope(validAssistantText(), {
      selected_plan_id: "architect-continuation",
      chat_scope: "plan",
      now,
    });

    expect(result.envelope).toMatchObject({
      pass_id: "slice-1",
      summary: "Created the shared continuation contract.",
      uncertainty: 0.1,
    });
    expect(result.report).toMatchObject({
      id: "architect-pass-3fb21d782c638be7",
      created_at: now.toISOString(),
      recommended_next_step: { id: "slice-2-adapter-routing" },
    });
    expect(result.report.continuation_options).toHaveLength(2);
    expect(result.report.continuation_options[0]).toMatchObject({
      label: "Implement Slice 2",
      required_tools: ["read_source_code", "patch_file", "run_command", "query_resource", "query_architecture_decisions", "enrich_seed_data"],
      preferred_tools: [
        "search_source_code",
        "graph_rag_retrieve",
        "cognitive_status",
        "get_cognitive_preamble",
        "modify_api_surface",
        "solidify_cognitive_insight",
        "record_architecture_decision",
      ],
    });
    expect(result.report.continuation_options[1]).toMatchObject({
      id: "unsafe-native-write",
      safe: false,
      label: "Use native shell write now",
      disabled_reason: "Out of policy.",
    });
    expect(result.diagnostics).toContain("recommended_action_dropped_not_object");
  });

  it("returns a stopped diagnostic decision for missing or malformed envelopes", () => {
    const parseResult = parseArchitectContinuationEnvelope("Plain assistant answer without a continuation block.", {
      selected_plan_id: "architect-continuation",
      chat_scope: "plan",
      now,
    });
    const decision = decideArchitectContinuation({
      parseResult,
      context: { selected_plan_id: "architect-continuation", chat_scope: "plan", completed_passes: 1, max_passes: 3, now },
      autonomyAllowsContinue: true,
    });

    expect(parseResult.envelope).toBeNull();
    expect(decision).toMatchObject({
      status: "stopped",
      reason: "missing_or_malformed_envelope",
      report: { uncertainty: 1 },
    });
    expect(decision.continuation_token).toBeTruthy();
  });

  it("synthesizes route-failure reports before envelope diagnostics", () => {
    const parseResult = synthesizeArchitectRouteFailureContinuation({
      reason: "empty_cli_bridge_response",
      adapter: "codex-cli",
      provider: "none",
      model: "auto",
      context: { selected_plan_id: "architect-continuation", chat_scope: "plan", completed_passes: 1, max_passes: 3, now },
    });
    const decision = decideArchitectContinuation({
      parseResult,
      context: { selected_plan_id: "architect-continuation", chat_scope: "plan", completed_passes: 1, max_passes: 3, now },
      autonomyAllowsContinue: true,
    });

    expect(parseResult.envelope).toMatchObject({
      pass_id: "route-failure",
      status: "failed",
      stop_reason: "empty_cli_bridge_response",
    });
    expect(parseResult.diagnostics[0]).toBe("empty_cli_bridge_response");
    expect(parseResult.diagnostics).not.toContain("missing_architect_continuation_envelope");
    expect(parseResult.report).toMatchObject({
      recommended_next_step: { id: "retry-route" },
      continuation_options: [
        expect.objectContaining({ id: "retry-route", safe: true }),
        expect.objectContaining({ id: "report-only", safe: true }),
        expect.objectContaining({ id: "manual-continue", safe: true }),
      ],
    });
    expect(decision).toMatchObject({
      status: "stopped",
      reason: "empty_cli_bridge_response",
      report: { pass_id: "route-failure" },
    });
    expect(decision.continuation_token).toBeTruthy();
  });

  it("accepts native-loop bare report JSON aliases", () => {
    const parseResult = parseArchitectContinuationEnvelope([
      "Investigated the displayed plan status from daemon-projected plan state.",
      JSON.stringify({
        version: 1,
        status: "completed",
        summary: "Investigated why the Envelope Fixes plan still displays as implementing.",
        work_completed: [
          { item: "Inspected plans directory and confirmed files exist." },
          { item: "Inspected plan projection code." },
        ],
        files_inspected: ["plans/envelope-fixes.md", "src/architect/plan-registry.ts"],
        evidence: [{ source: "src/architect/plan-registry.ts", detail: "Aggregate slice checkpoints are not expanded." }],
        uncertainty: ["No mutation or verification was performed."],
        blockers: [{ item: "Projection does not treat aggregate checkpoint id as a range." }],
        recommended_next_actions: [{ action: "Patch projection logic to recognize aggregate ordinal ranges." }],
      }, null, 2),
    ].join("\n"), {
      selected_plan_id: "envelope-fixes",
      chat_scope: "plan",
      now,
    });

    expect(parseResult.envelope).toMatchObject({
      pass_id: "pass",
      status: "completed",
      summary: "Investigated why the Envelope Fixes plan still displays as implementing.",
      work_completed: [
        "Inspected plans directory and confirmed files exist.",
        "Inspected plan projection code.",
      ],
      files_touched: ["plans/envelope-fixes.md", "src/architect/plan-registry.ts"],
      evidence: ["src/architect/plan-registry.ts: Aggregate slice checkpoints are not expanded."],
      blockers: ["Projection does not treat aggregate checkpoint id as a range."],
    });
    expect(parseResult.report.work_completed).toHaveLength(2);
    expect(parseResult.report.files_touched).toContain("src/architect/plan-registry.ts");
    expect(parseResult.report.recommended_next_step).toMatchObject({
      label: "Patch projection logic to recognize aggregate ordinal ranges.",
      kind: "continue",
    });
  });

  it("canonicalizes legacy bounded-pass report JSON into a rendered continuation report", () => {
    // Retry-pass fixtures exercise governed MCP obligation recovery without requiring a plan scope.
    const parseResult = parseArchitectContinuationEnvelope([
      "Completed the bounded retry pass.",
      JSON.stringify({
        pass_report_id: "architect-pass-0467092a3a97a166-retry-required-governed-tools",
        selected_plan_id: null,
        chat_scope: "project",
        completed_step: "Retry required governed tools",
        status: "completed",
        governed_tools_used: [
          {
            tool: "patch_file",
            purpose: "Satisfy missing governed MCP mutation obligation",
            outcome: "success",
            sanity: "Applied a bounded test-fixture mutation through the governed patch tool.",
          },
          {
            tool: "enrich_seed_data",
            purpose: "Record retry-pass evidence back into DreamGraph",
            outcome: "success",
            sanity: "Upserted bounded retry-pass capability evidence.",
          },
          {
            tool: "run_command",
            purpose: "Required verification",
            command: "git status --short",
            outcome: "success",
            exit_code: 0,
            sanity: "Repository status was readable.",
          },
        ],
        mutations_applied: ["tests/architect-continuation.test.ts"],
        verification: {
          command: "git status --short",
          exit_code: 0,
          passed: true,
          notes: "A bounded parser fixture mutation was applied in this pass.",
        },
        follow_up_recommendation: {
          next_action_id: "select-specific-mutation-target",
          rationale: "The prompt requested mutation only generically; the next pass should identify the exact file/change before editing.",
        },
      }, null, 2),
    ].join("\n"), {
      selected_plan_id: null,
      chat_scope: "project",
      now,
    });
    const decision = decideArchitectContinuation({
      parseResult,
      context: { selected_plan_id: null, chat_scope: "project", completed_passes: 3, max_passes: 50, now },
      autonomyAllowsContinue: true,
    });

    expect(parseResult.diagnostics).toContain("legacy_architect_report_json_canonicalized");
    expect(parseResult.envelope).toMatchObject({
      pass_id: "architect-pass-0467092a3a97a166-retry-required-governed-tools",
      status: "completed",
      summary: "Retry required governed tools completed.",
      work_completed: [
        expect.stringContaining("patch_file: success"),
        expect.stringContaining("enrich_seed_data: success"),
        expect.stringContaining("run_command: success"),
      ],
      tool_trace_summary: expect.arrayContaining([
        expect.stringContaining("verification; command=git status --short"),
      ]),
    });
    expect(parseResult.report.recommended_next_step).toMatchObject({
      id: "select-specific-mutation-target",
      kind: "request_user_input",
      recommended: true,
    });
    expect(decision).toMatchObject({
      status: "stopped",
      reason: "assistant_requested_user_input",
      selected_action: { id: "select-specific-mutation-target" },
    });
  });

  it("recovers a safe continuation action from legacy incomplete report JSON", () => {
    const parseResult = parseArchitectContinuationEnvelope([
      "Summary: completed slices 1-4; slices 5-12 remain pending.",
      "```architect_continuation",
      JSON.stringify({
        session_id: "architect-5b86cd19-abba-4c41-b291-4ef42cee18cf",
        plan: {
          name: "architect-continuation-proof-test",
          path: "plans/architect-continuation-proof-test.md",
          total_slices: 12,
          completed_slices: [1, 2, 3, 4],
          pending_slices: [5, 6, 7, 8, 9, 10, 11, 12],
        },
        work_completed: ["Created the draft plan.", "Completed slices 1-4."],
        blockers: ["Stopped before completing remaining slices."],
        uncertainty: 0,
        passes_required_so_far: 1,
        complete: false,
        next_required_action: "Continue with slice 5 by appending <!-- CONTINUATION TEST SLICE 5 --> to docs/workflows/_index.md, then proceed sequentially through slice 12.",
      }),
      "```",
    ].join("\n"), {
      selected_plan_id: null,
      chat_scope: "project",
      now,
    });
    const decision = decideArchitectContinuation({
      parseResult,
      context: { selected_plan_id: null, chat_scope: "project", completed_passes: 1, max_passes: 50, now },
      autonomyAllowsContinue: true,
    });

    expect(parseResult.diagnostics).toContain("recommended_actions_missing_or_not_array");
    expect(parseResult.diagnostics).toContain("recommended_actions_synthesized_from_legacy_report");
    expect(parseResult.report.recommended_next_step).toMatchObject({
      id: "continue-from-legacy-report",
      kind: "continue",
      safe: true,
      recommended: true,
    });
    expect(decision).toMatchObject({
      status: "continue",
      reason: "recommended_action_selected",
      selected_action: {
        id: "continue-from-legacy-report",
        prompt: expect.stringContaining("Continue with slice 5"),
      },
    });
  });

  it("infers continuation tools when the previous pass omits manifest fields", () => {
    const parseResult = parseArchitectContinuationEnvelope([
      "Pass report text.",
      "```architect_continuation",
      JSON.stringify({
        schema: ARCHITECT_CONTINUATION_SCHEMA,
        pass_id: "slice-empty-tools",
        status: "completed",
        summary: "Located the relevant UI registry context but did not patch yet.",
        work_completed: ["Queried UI elements only."],
        files_touched: [],
        graph_entities_touched: ["ui_registry"],
        tool_trace_summary: ["query_ui_elements inspected the registry"],
        graph_plan_updates: [],
        evidence: ["Next step needs implementation."],
        blockers: [],
        uncertainty: 0.2,
        recommended_actions: [{
          id: "implement-prompted-change",
          label: "Implement prompted change",
          rationale: "The previous pass only queried UI elements; continue by editing the relevant source and verifying the fix.",
          kind: "continue",
          prompt: "Use read_source_code to inspect the target, patch_file to implement the prompted changes, then run_command to verify.",
          safe: true,
          recommended: true,
          required_tools: [],
          preferred_tools: [],
        }],
      }),
      "```",
    ].join("\n"), {
      selected_plan_id: null,
      chat_scope: "project",
      now,
    });
    const decision = decideArchitectContinuation({
      parseResult,
      context: { selected_plan_id: null, chat_scope: "project", completed_passes: 1, max_passes: 3, now },
      autonomyAllowsContinue: true,
    });

    expect(decision).toMatchObject({
      status: "continue",
      selected_action: { id: "implement-prompted-change" },
      tool_manifest: {
        required_tools: ["query_resource", "query_architecture_decisions", "read_source_code", "patch_file", "enrich_seed_data", "run_command"],
        preferred_tools: [
          "graph_rag_retrieve",
          "cognitive_status",
          "get_cognitive_preamble",
          "modify_api_surface",
          "solidify_cognitive_insight",
          "record_architecture_decision",
          "query_ui_elements",
        ],
      },
    });
    const decoded = decodeArchitectContinuationToken(decision.continuation_token ?? "", { selected_plan_id: null, chat_scope: "project" });
    expect(decoded).toMatchObject({ ok: true });
    if (decoded.ok) {
      const prompt = buildArchitectContinuationPrompt(decoded.state, decision.selected_action!);
      expect(prompt).toContain("Required DreamGraph MCP tools for this pass: query_resource, query_architecture_decisions, read_source_code, patch_file, enrich_seed_data, run_command");
      expect(prompt).toContain("Preferred DreamGraph MCP tools for this pass: graph_rag_retrieve, cognitive_status, get_cognitive_preamble, modify_api_surface, solidify_cognitive_insight, record_architecture_decision, query_ui_elements");
    }
  });

  it("adds mutation and verification tools when a continuation action describes regression coverage but omits them", () => {
    const parseResult = parseArchitectContinuationEnvelope([
      "Pass report text.",
      "```architect_continuation",
      JSON.stringify({
        schema: ARCHITECT_CONTINUATION_SCHEMA,
        pass_id: "chat-history-investigation",
        status: "completed",
        summary: "Confirmed the implementation appears present but regression coverage remains.",
        work_completed: ["Inspected chat-history persistence helpers."],
        files_touched: ["src/architect/routes.ts", "tests/standalone-architect-routes.test.ts"],
        graph_entities_touched: [],
        tool_trace_summary: ["read_source_code inspected route and tests"],
        graph_plan_updates: [],
        evidence: ["Existing coverage did not yet prove runtimeDir isolation."],
        blockers: [],
        uncertainty: 0.2,
        recommended_actions: [{
          id: "add-chat-history-runtime-regressions",
          label: "Add and verify Architect chat-history runtimeDir persistence regressions",
          rationale: "The next pass must add focused tests and run targeted verification.",
          kind: "continue",
          prompt: "Add focused tests in tests/standalone-architect-routes.test.ts proving chat history is written under runtimeDir, restored by session/scope/plan, and isolated across runtime dirs. Run targeted vitest and a build/server sanity check.",
          safe: true,
          recommended: true,
          required_tools: ["read_source_code"],
          preferred_tools: [],
        }],
      }),
      "```",
    ].join("\n"), {
      selected_plan_id: null,
      chat_scope: "project",
      now,
    });
    const decision = decideArchitectContinuation({
      parseResult,
      context: { selected_plan_id: null, chat_scope: "project", completed_passes: 4, max_passes: 50, now },
      autonomyAllowsContinue: true,
    });

    expect(decision).toMatchObject({
      status: "continue",
      selected_action: { id: "add-chat-history-runtime-regressions" },
      tool_manifest: {
        required_tools: ["read_source_code", "query_resource", "query_architecture_decisions", "patch_file", "enrich_seed_data", "run_command"],
      },
    });
    expect(parseResult.report.recommended_next_step).toMatchObject({
      required_tools: ["read_source_code", "query_resource", "query_architecture_decisions", "patch_file", "enrich_seed_data", "run_command"],
    });
    const decoded = decodeArchitectContinuationToken(decision.continuation_token ?? "", { selected_plan_id: null, chat_scope: "project" });
    expect(decoded).toMatchObject({ ok: true });
    if (decoded.ok) {
      expect(decoded.state.required_tools).toEqual(["read_source_code", "query_resource", "query_architecture_decisions", "patch_file", "enrich_seed_data", "run_command"]);
    }
  });

  it("synthesizes compact fallback evidence instead of duplicating raw route traces", () => {
    const rawPatchPayload = "patch_file: completed filePath=src/architect/continuation.ts edits=[{old_text: 'Route Tool Trace spam repeated over and over', new_text: 'compact summary'}]";
    const rawTranscript = [
      "user: CURRENT USER REQUEST paste with hundreds of lines and raw tool trace",
      "assistant: Route Tool Trace:\npatch_file raw payload\n```json\n{\"raw\":true}\n```\nImplemented compact recovery rendering.",
    ];
    const parseResult = synthesizeArchitectRecoveredContinuation({
      reason: "assistant_text_missing_continuation_envelope",
      adapter: "codex-cli",
      provider: "none",
      model: "gpt-5.5",
      context: { selected_plan_id: "envelope-fixes", chat_scope: "plan", completed_passes: 1, max_passes: 3, now },
      route_tool_trace: [
        rawPatchPayload,
        "patch_file: completed filePath=src/architect/routes.ts edits=[{old_text: 'raw payload should not render'}]",
        "run_command: completed command=npm test -- architect-continuation",
        "read_source_code: completed filePath=src/architect/continuation.ts",
        "Route Tool Trace:",
      ],
      observed_file_mutations: [rawPatchPayload, "patch_file: failed filePath=src/architect/routes.ts edits=[{old_text: 'huge raw payload'}]"],
      verification_output: ["run_command: completed command=npm test -- architect-continuation stdout=2000 noisy lines"],
      chat_transcript: rawTranscript,
      assistant_reported_unverified: [rawTranscript[1]],
      implementation_log: [],
      mutation_tools_seen: true,
      verification_incomplete: false,
    });

    expect(parseResult.envelope).toBeNull();
    expect(parseResult.report.work_completed.length).toBeGreaterThan(0);
    expect(parseResult.report.work_completed.join("\n")).not.toBe("None recorded");
    expect(parseResult.report.tool_trace_summary).toContain("tools completed: 4");
    expect(parseResult.report.tool_trace_summary.some((item) => item.startsWith("verification ") && item.endsWith(": success"))).toBe(true);
    expect(parseResult.report.files_touched).toEqual(["src/architect/continuation.ts", "src/architect/routes.ts"]);
    expect(parseResult.report.fallback_evidence).toEqual([
      expect.objectContaining({ label: "Fallback Evidence Summary" }),
    ]);

    const renderedText = JSON.stringify(parseResult.report);
    expect(renderedText).toContain("Fallback Evidence Summary");
    expect(renderedText).toContain("mutations for src/architect/continuation.ts: 1");
    expect(renderedText).toContain("patch_file -> src/architect/routes.ts (failure)");
    expect(renderedText).toContain("chat transcript summarized: 1 user message(s), 1 assistant message(s); raw transcript omitted");
    expect(renderedText).not.toContain("Route Tool Trace spam repeated over and over");
    expect(renderedText).not.toContain("edits=[{old_text");
    expect(renderedText).not.toContain("CURRENT USER REQUEST");
    expect(renderedText).not.toContain("Files / Graph Entities Touched {");
    expect(parseResult.report.fallback_evidence?.[0]?.items.length).toBeLessThanOrEqual(16);
  });

  it("treats append_to_file as recovered mutation evidence", () => {
    const parseResult = synthesizeArchitectRecoveredContinuation({
      reason: "assistant_text_missing_continuation_envelope",
      adapter: "native_api_tool_loop",
      provider: "openai",
      model: "gpt-5.5",
      context: { selected_plan_id: "architect-continuation-proof-test", chat_scope: "plan", completed_passes: 1, max_passes: 50, now },
      route_tool_trace: [
        'append_to_file: completed {"filePath":"docs/workflows/_index.md","content":"<!-- marker -->"}',
        'append_to_file: completed {"filePath":"docs/architecture/_index.md","content":"<!-- marker -->"}',
      ],
      observed_file_mutations: [
        'append_to_file: completed {"filePath":"docs/workflows/_index.md","content":"<!-- marker -->"}',
        'append_to_file: completed {"filePath":"docs/architecture/_index.md","content":"<!-- marker -->"}',
      ],
      assistant_reported_unverified: ["Completed Slice 5 and Slice 6."],
      mutation_tools_seen: true,
      verification_incomplete: true,
    });

    expect(parseResult.envelope).toBeNull();
    expect(parseResult.report.files_touched).toEqual([
      "docs/workflows/_index.md",
      "docs/architecture/_index.md",
    ]);
    expect(parseResult.report.work_completed).toContain("assistant summary: Completed Slice 5 and Slice 6.");
    const renderedText = JSON.stringify(parseResult.report);
    expect(renderedText).toContain("mutations for docs/workflows/_index.md: 1");
    expect(renderedText).toContain("append_to_file -> docs/architecture/_index.md (success)");
    expect(renderedText).not.toContain("None recorded");
  });

  it("creates continuation decisions, manifests, prompts, and scoped tokens", () => {
    const parseResult = parseArchitectContinuationEnvelope(validAssistantText(), {
      selected_plan_id: "architect-continuation",
      chat_scope: "plan",
      now,
    });
    const decision = decideArchitectContinuation({
      parseResult,
      context: { selected_plan_id: "architect-continuation", chat_scope: "plan", completed_passes: 1, max_passes: 3, now },
      autonomyAllowsContinue: true,
    });

    expect(decision).toMatchObject({
      status: "continue",
      reason: "recommended_action_selected",
      selected_action: { id: "slice-2-adapter-routing" },
      tool_manifest: {
        required_tools: ["read_source_code", "patch_file", "run_command", "query_resource", "query_architecture_decisions", "enrich_seed_data"],
        preferred_tools: [
          "search_source_code",
          "graph_rag_retrieve",
          "cognitive_status",
          "get_cognitive_preamble",
          "modify_api_surface",
          "solidify_cognitive_insight",
          "record_architecture_decision",
        ],
      },
    });

    const token = decision.continuation_token ?? "";
    const decoded = decodeArchitectContinuationToken(token, { selected_plan_id: "architect-continuation", chat_scope: "plan" });
    expect(decoded).toMatchObject({ ok: true });
    if (decoded.ok) {
      expect(decoded.state).toMatchObject({
        selected_plan_id: "architect-continuation",
        chat_scope: "plan",
        selected_action_id: "slice-2-adapter-routing",
        required_tools: ["read_source_code", "patch_file", "run_command", "query_resource", "query_architecture_decisions", "enrich_seed_data"],
      });
      const prompt = buildArchitectContinuationPrompt(decoded.state, decision.selected_action!);
      expect(prompt).toContain("Selected plan id: architect-continuation");
      expect(prompt).toContain("Required DreamGraph MCP tools for this pass: read_source_code, patch_file, run_command, query_resource, query_architecture_decisions, enrich_seed_data");
      expect(prompt).toContain("Do not substitute provider-native shell, read, or write routes");
      expect(prompt).toContain("Add manifest routing to native and CLI adapters.");
    }

    expect(decodeArchitectContinuationToken(token, { selected_plan_id: "other-plan", chat_scope: "plan" })).toEqual({
      ok: false,
      reason: "continuation_token_plan_mismatch",
    });
    expect(decodeArchitectContinuationToken(token, { selected_plan_id: "architect-continuation", chat_scope: "project" })).toEqual({
      ok: false,
      reason: "continuation_token_scope_mismatch",
    });
  });

  it("waits for manual selection when autonomy does not allow continuation", () => {
    const parseResult = parseArchitectContinuationEnvelope(validAssistantText(), {
      selected_plan_id: "architect-continuation",
      chat_scope: "plan",
      now,
    });
    const decision = decideArchitectContinuation({
      parseResult,
      context: { selected_plan_id: "architect-continuation", chat_scope: "plan", completed_passes: 1, max_passes: 3, now },
      autonomyAllowsContinue: false,
    });

    expect(decision).toMatchObject({
      status: "wait",
      reason: "autonomy_requires_manual_selection",
      selected_action: null,
    });
    expect(decision.continuation_token).toBeTruthy();
  });
});
