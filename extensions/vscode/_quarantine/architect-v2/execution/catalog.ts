// architect-v2/execution/catalog.ts
// Slice 4 — Native DreamGraph tool catalog.
//
// STRICT ISOLATION (ADR-140): no import from v1.
//
// ADR-155: this catalog is the SOURCE OF TRUTH. The MCP roster is queried
// only to confirm liveness (see inventory.ts). DreamGraph tools are NATIVE
// to the agent — not discovered, not negotiated. Adding/removing entries
// requires an ADR (per ADR-155 guard rail).
//
// (Preserved concept from v1 tool-groups — but as a single ordered table
// keyed by intent + tier, with no per-mode allowlists.)

import type { Tier } from "./tiers.js";
import type { Intent } from "./intents.js";

export type ToolKind = "mcp" | "vscode" | "shell";

export interface ToolDescriptor {
  /** Exact tool name as the dispatcher will invoke it. */
  readonly tool: string;
  readonly tier: Tier;
  readonly intent: Intent;
  readonly kind: ToolKind;
  /**
   * Optional VS Code capability requirement (e.g. `'lm.tool'`). Used by
   * `buildCapabilityInventory` to filter Tier-4 entries against the live
   * `VsCodeCapabilityProbe`.
   */
  readonly requires?: readonly string[];
  readonly notes?: string;
}

// ---------------------------------------------------------------------------
// Tier 1 — DreamGraph MCP knowledge / read
// ---------------------------------------------------------------------------

const T1: readonly ToolDescriptor[] = Object.freeze([
  { tool: "mcp_dreamgraph_query_resource", tier: 1, intent: "graph.read", kind: "mcp" },
  { tool: "mcp_dreamgraph_graph_rag_retrieve", tier: 1, intent: "graph.rag", kind: "mcp" },
  { tool: "mcp_dreamgraph_shortest_path", tier: 1, intent: "graph.shortest_path", kind: "mcp" },
  { tool: "mcp_dreamgraph_read_source_code", tier: 1, intent: "entity.read", kind: "mcp" },
  { tool: "mcp_dreamgraph_query_api_surface", tier: 1, intent: "api.query", kind: "mcp" },
  { tool: "mcp_dreamgraph_extract_api_surface", tier: 1, intent: "api.query", kind: "mcp" },
  { tool: "mcp_dreamgraph_read_markdown_chapter", tier: 1, intent: "markdown.read", kind: "mcp" },
  { tool: "mcp_dreamgraph_list_markdown_chapters", tier: 1, intent: "markdown.list_chapters", kind: "mcp" },
  { tool: "mcp_dreamgraph_list_directory", tier: 1, intent: "dir.list", kind: "mcp" },
  { tool: "mcp_dreamgraph_read_source_code", tier: 1, intent: "file.read", kind: "mcp" },
  { tool: "mcp_dreamgraph_search_source_code", tier: 1, intent: "source.search", kind: "mcp" },
  { tool: "mcp_dreamgraph_git_log", tier: 1, intent: "git.read.log", kind: "mcp" },
  { tool: "mcp_dreamgraph_git_blame", tier: 1, intent: "git.read.blame", kind: "mcp" },
  { tool: "mcp_dreamgraph_query_dreams", tier: 1, intent: "dream.read", kind: "mcp" },
  { tool: "mcp_dreamgraph_get_dream_insights", tier: 1, intent: "dream.read", kind: "mcp" },
  { tool: "mcp_dreamgraph_get_temporal_insights", tier: 1, intent: "dream.read", kind: "mcp" },
  { tool: "mcp_dreamgraph_get_causal_insights", tier: 1, intent: "dream.read", kind: "mcp" },
  { tool: "mcp_dreamgraph_query_runtime_metrics", tier: 1, intent: "runtime.read", kind: "mcp" },
  { tool: "mcp_dreamgraph_query_self_metrics", tier: 1, intent: "self.metrics", kind: "mcp" },
  { tool: "mcp_dreamgraph_fetch_web_page", tier: 1, intent: "web.fetch", kind: "mcp" },
  { tool: "mcp_dreamgraph_get_system_narrative", tier: 1, intent: "narrative.read", kind: "mcp" },
  { tool: "mcp_dreamgraph_get_system_story", tier: 1, intent: "narrative.read", kind: "mcp" },
  { tool: "mcp_dreamgraph_query_architecture_decisions", tier: 1, intent: "adr.read", kind: "mcp" },
  { tool: "mcp_dreamgraph_search_data_model", tier: 1, intent: "data_model.search", kind: "mcp" },
  { tool: "mcp_dreamgraph_query_db_schema", tier: 1, intent: "db_schema.query", kind: "mcp" },
  { tool: "mcp_dreamgraph_query_ui_elements", tier: 1, intent: "ui.query", kind: "mcp" },
  { tool: "mcp_dreamgraph_get_schedule_history", tier: 1, intent: "schedule.read", kind: "mcp" },
  { tool: "mcp_dreamgraph_list_schedules", tier: 1, intent: "schedule.read", kind: "mcp" },
  { tool: "mcp_dreamgraph_webhook_list", tier: 1, intent: "webhook.read", kind: "mcp" },
  { tool: "mcp_dreamgraph_webhook_dead_letter_list", tier: 1, intent: "webhook.read", kind: "mcp" },
  { tool: "mcp_dreamgraph_get_remediation_plan", tier: 1, intent: "remediation.read", kind: "mcp" },
  { tool: "mcp_dreamgraph_discipline_get_session", tier: 1, intent: "discipline.read", kind: "mcp" },
]);

// ---------------------------------------------------------------------------
// Tier 2 — DreamGraph MCP mutation
// ---------------------------------------------------------------------------

const T2: readonly ToolDescriptor[] = Object.freeze([
  { tool: "mcp_dreamgraph_create_file", tier: 2, intent: "file.create", kind: "mcp" },
  { tool: "mcp_dreamgraph_edit_file", tier: 2, intent: "file.edit", kind: "mcp" },
  { tool: "mcp_dreamgraph_patch_file", tier: 2, intent: "file.patch", kind: "mcp" },
  { tool: "mcp_dreamgraph_append_to_file", tier: 2, intent: "file.append", kind: "mcp" },
  { tool: "mcp_dreamgraph_delete_file", tier: 2, intent: "file.delete", kind: "mcp" },
  { tool: "mcp_dreamgraph_rename_file", tier: 2, intent: "file.rename", kind: "mcp" },
  { tool: "mcp_dreamgraph_patch_markdown_chapter", tier: 2, intent: "markdown.patch_chapter", kind: "mcp" },
  { tool: "mcp_dreamgraph_edit_markdown_section", tier: 2, intent: "markdown.edit_section", kind: "mcp" },
  { tool: "mcp_dreamgraph_edit_entity", tier: 2, intent: "entity.edit", kind: "mcp" },
  { tool: "mcp_dreamgraph_modify_api_surface", tier: 2, intent: "api.modify", kind: "mcp" },
  { tool: "mcp_dreamgraph_wire_links", tier: 2, intent: "graph.wire", kind: "mcp" },
  { tool: "mcp_dreamgraph_scan_project", tier: 2, intent: "graph.scan", kind: "mcp" },
  { tool: "mcp_dreamgraph_scan_database", tier: 2, intent: "graph.scan_database", kind: "mcp" },
  { tool: "mcp_dreamgraph_init_graph", tier: 2, intent: "graph.init", kind: "mcp" },
  { tool: "mcp_dreamgraph_enrich_seed_data", tier: 2, intent: "seed.enrich", kind: "mcp" },
  { tool: "mcp_dreamgraph_register_ui_element", tier: 2, intent: "ui.register", kind: "mcp" },
  { tool: "mcp_dreamgraph_normalize_dreams", tier: 2, intent: "dreams.normalize", kind: "mcp" },
  { tool: "mcp_dreamgraph_import_dream_archetypes", tier: 2, intent: "dreams.import", kind: "mcp" },
  { tool: "mcp_dreamgraph_export_dream_archetypes", tier: 2, intent: "dreams.export", kind: "mcp" },
]);

// ---------------------------------------------------------------------------
// Tier 3 — DreamGraph MCP verification + cognitive + senses
// ---------------------------------------------------------------------------

const T3: readonly ToolDescriptor[] = Object.freeze([
  { tool: "mcp_dreamgraph_discipline_verify", tier: 3, intent: "verify.discipline", kind: "mcp" },
  { tool: "mcp_dreamgraph_discipline_check_tool", tier: 3, intent: "verify.invariant", kind: "mcp" },
  { tool: "mcp_dreamgraph_query_runtime_metrics", tier: 3, intent: "runtime.metrics", kind: "mcp" },
  { tool: "mcp_dreamgraph_cognitive_status", tier: 3, intent: "cognitive.status", kind: "mcp" },
  { tool: "mcp_dreamgraph_solidify_cognitive_insight", tier: 3, intent: "cognitive.solidify", kind: "mcp" },
  { tool: "mcp_dreamgraph_resolve_tension", tier: 3, intent: "cognitive.resolve_tension", kind: "mcp" },
  { tool: "mcp_dreamgraph_dispatch_cognitive_event", tier: 3, intent: "cognitive.event", kind: "mcp" },
  { tool: "mcp_dreamgraph_get_cognitive_preamble", tier: 3, intent: "cognitive.preamble", kind: "mcp" },
  { tool: "mcp_dreamgraph_metacognitive_analysis", tier: 3, intent: "metacognition.analyze", kind: "mcp" },
  { tool: "mcp_dreamgraph_dream_cycle", tier: 3, intent: "dream.cycle", kind: "mcp" },
  { tool: "mcp_dreamgraph_nightmare_cycle", tier: 3, intent: "dream.nightmare", kind: "mcp" },
  { tool: "mcp_dreamgraph_lucid_dream", tier: 3, intent: "dream.lucid.start", kind: "mcp" },
  { tool: "mcp_dreamgraph_lucid_action", tier: 3, intent: "dream.lucid.act", kind: "mcp" },
  { tool: "mcp_dreamgraph_wake_from_lucid", tier: 3, intent: "dream.lucid.wake", kind: "mcp" },
  { tool: "mcp_dreamgraph_record_architecture_decision", tier: 3, intent: "adr.record", kind: "mcp" },
  { tool: "mcp_dreamgraph_deprecate_architecture_decision", tier: 3, intent: "adr.deprecate", kind: "mcp" },
  { tool: "mcp_dreamgraph_schedule_dream", tier: 3, intent: "schedule.manage", kind: "mcp" },
  { tool: "mcp_dreamgraph_update_schedule", tier: 3, intent: "schedule.manage", kind: "mcp" },
  { tool: "mcp_dreamgraph_delete_schedule", tier: 3, intent: "schedule.manage", kind: "mcp" },
  { tool: "mcp_dreamgraph_run_schedule_now", tier: 3, intent: "schedule.run_now", kind: "mcp" },
  { tool: "mcp_dreamgraph_webhook_register", tier: 3, intent: "webhook.manage", kind: "mcp" },
  { tool: "mcp_dreamgraph_webhook_remove", tier: 3, intent: "webhook.manage", kind: "mcp" },
  { tool: "mcp_dreamgraph_webhook_set_enabled", tier: 3, intent: "webhook.manage", kind: "mcp" },
  { tool: "mcp_dreamgraph_webhook_replay", tier: 3, intent: "webhook.replay", kind: "mcp" },
  { tool: "mcp_dreamgraph_webhook_test", tier: 3, intent: "webhook.test", kind: "mcp" },
  { tool: "mcp_dreamgraph_plugin_reload", tier: 3, intent: "plugin.manage", kind: "mcp" },
  { tool: "mcp_dreamgraph_plugin_unload", tier: 3, intent: "plugin.manage", kind: "mcp" },
  { tool: "mcp_dreamgraph_discipline_start_session", tier: 3, intent: "discipline.session", kind: "mcp" },
  { tool: "mcp_dreamgraph_discipline_submit_plan", tier: 3, intent: "discipline.session", kind: "mcp" },
  { tool: "mcp_dreamgraph_discipline_approve_plan", tier: 3, intent: "discipline.session", kind: "mcp" },
  { tool: "mcp_dreamgraph_discipline_record_tool_call", tier: 3, intent: "discipline.session", kind: "mcp" },
  { tool: "mcp_dreamgraph_discipline_record_delta", tier: 3, intent: "discipline.session", kind: "mcp" },
  { tool: "mcp_dreamgraph_discipline_transition", tier: 3, intent: "discipline.session", kind: "mcp" },
  { tool: "mcp_dreamgraph_discipline_complete_session", tier: 3, intent: "discipline.session", kind: "mcp" },
  { tool: "mcp_dreamgraph_export_living_docs", tier: 3, intent: "living_docs.export", kind: "mcp" },
  { tool: "mcp_dreamgraph_generate_ui_migration_plan", tier: 3, intent: "ui_migration.plan", kind: "mcp" },
  { tool: "mcp_dreamgraph_generate_visual_flow", tier: 3, intent: "visual_flow.generate", kind: "mcp" },
]);

// ---------------------------------------------------------------------------
// Tier 4 — VS Code editor APIs (fallback only)
// ---------------------------------------------------------------------------

const T4: readonly ToolDescriptor[] = Object.freeze([
  {
    tool: "vscode.languages.getDiagnostics",
    tier: 4,
    intent: "editor.diagnostics",
    kind: "vscode",
    requires: ["editor.diagnostics"],
    notes: "Editor-native — no DreamGraph equivalent.",
  },
  {
    tool: "vscode.commands.executeCommand:vscode.executeWorkspaceSymbolProvider",
    tier: 4,
    intent: "editor.symbol",
    kind: "vscode",
    requires: ["editor.symbol"],
    notes: "VS Code language-server-backed symbol search; complements MCP graph reads with editor-side index state.",
  },
  {
    tool: "vscode.window.showTextDocument",
    tier: 4,
    intent: "editor.openFile",
    kind: "vscode",
    requires: ["editor.openFile"],
    notes: "UI surface only.",
  },
  {
    tool: "vscode.commands.executeCommand",
    tier: 4,
    intent: "editor.command",
    kind: "vscode",
    requires: ["editor.command"],
    notes: "Catch-all for editor commands without a DreamGraph equivalent.",
  },
  {
    tool: "vscode.lm.invokeTool",
    tier: 4,
    intent: "lm.tool",
    kind: "vscode",
    requires: ["lm.tool"],
    notes: "VS Code Language Model tool surface — used only for tools the host registers that DreamGraph cannot satisfy.",
  },
]);

// ---------------------------------------------------------------------------
// Tier 5 — Shell + clipboard (kept-by-design exceptions)
// ---------------------------------------------------------------------------

const T5: readonly ToolDescriptor[] = Object.freeze([
  {
    tool: "shell.run",
    tier: 5,
    intent: "shell.run",
    kind: "shell",
    notes: "Build/test/lint/git commands. No DreamGraph equivalent for arbitrary processes.",
  },
  {
    tool: "vscode.env.clipboard.readText",
    tier: 5,
    intent: "clipboard.read",
    kind: "shell",
    notes: "Local UI capability — kept by design (see execution/README.md).",
  },
  {
    tool: "vscode.env.clipboard.writeText",
    tier: 5,
    intent: "clipboard.write",
    kind: "shell",
    notes: "Local UI capability — kept by design (see execution/README.md).",
  },
]);

/**
 * The single source of truth for what tools v2 considers native or fallback.
 * Order within each tier is meaningful: ties at the same tier+intent are
 * resolved by declaration order in `selectExecutor`.
 */
export const NATIVE_TOOL_CATALOG: readonly ToolDescriptor[] = Object.freeze([
  ...T1,
  ...T2,
  ...T3,
  ...T4,
  ...T5,
]);
