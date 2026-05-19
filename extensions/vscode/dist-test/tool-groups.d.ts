/**
 * DreamGraph Tool Group Whitelisting (Layer 1 → Layer 2 plumbing).
 *
 * Selects a small intent-appropriate subset of MCP+local tools to send with each
 * LLM request, instead of dumping all 69+ tool schemas (≈82 KB / ≈20k tokens) on
 * every call. Sending fewer tool schemas is the single largest input-token saving
 * available — schemas are sent on every pass of the agentic loop, multiplying the
 * cost across long conversations.
 *
 * Strategy: small default toolsets keyed by inferred ArchitectTask + a heuristic
 * keyword scan of the user prompt. Unknown tools (3rd-party MCP servers etc.) are
 * passed through untouched so we never silently break a user's setup.
 *
 * @see plans/cost-explosion-2026-04-25 for the diagnosis that motivated this.
 */
import type { ArchitectTask } from './prompts/index.js';
export declare const TOOL_GROUPS: {
    /** Reads — always available. Cheap, safe. */
    readonly core_read: readonly ["query_resource", "graph_rag_retrieve", "shortest_path", "query_api_surface", "read_source_code", "list_directory", "read_local_file", "search_source_code", "list_markdown_chapters", "read_markdown_chapter"];
    /** File writes — only when intent is clearly mutating. */
    readonly core_write: readonly ["edit_file", "create_file", "rename_file", "delete_file", "write_file", "modify_entity", "run_command", "append_to_file", "patch_file", "edit_markdown_section", "patch_markdown_chapter"];
    /** Graph mutations — knowledge-graph editing. */
    readonly graph_write: readonly ["enrich_seed_data", "enrich_parser_nodes", "solidify_cognitive_insight", "register_ui_element", "modify_api_surface", "edit_entity"];
    /** ADR lifecycle. */
    readonly adr: readonly ["record_architecture_decision", "query_architecture_decisions", "deprecate_architecture_decision"];
    /** Cognitive read-only inspection. */
    readonly cognitive_read: readonly ["cognitive_status", "get_dream_insights", "query_dreams", "get_causal_insights", "get_temporal_insights", "get_system_narrative", "get_system_story", "get_cognitive_preamble", "get_remediation_plan", "query_self_metrics", "query_architecture_decisions"];
    /** Cognitive run / mutate. */
    readonly cognitive_run: readonly ["dream_cycle", "normalize_dreams", "nightmare_cycle", "lucid_dream", "lucid_action", "wake_from_lucid"];
    /** Scheduling. */
    readonly scheduler: readonly ["schedule_dream", "list_schedules", "update_schedule", "run_schedule_now", "delete_schedule", "get_schedule_history"];
    /** Project bootstrap / scanning — heavy operations. */
    readonly project_scan: readonly ["init_graph", "scan_project", "extract_api_surface"];
    /** Documentation + visualization output. */
    readonly docs_visuals: readonly ["generate_visual_flow", "export_living_docs", "generate_ui_migration_plan", "export_dream_archetypes"];
    /** Ops / debug introspection. */
    readonly ops_debug: readonly ["query_self_metrics", "query_runtime_metrics", "query_db_schema", "git_log", "git_blame", "fetch_web_page"];
    /** Disciplined-execution session. */
    readonly discipline: readonly ["discipline_start_session", "discipline_transition", "discipline_check_tool", "discipline_get_session", "discipline_record_delta", "discipline_submit_plan", "discipline_approve_plan", "discipline_verify", "discipline_complete_session"];
    /** Dangerous maintenance — never default. */
    readonly maintenance_dangerous: readonly ["clear_dreams", "import_dream_archetypes", "dispatch_cognitive_event", "metacognitive_analysis", "init_graph"];
};
export type ToolGroupKey = keyof typeof TOOL_GROUPS;
export declare const MAX_TOOLS_DEFAULT = 12;
export declare const MAX_TOOLS_MUTATION = 18;
export declare const MAX_TOOLS_AUTONOMY = 24;
export interface ToolSelectionDecision {
    /** Names of selected tools (in priority order). */
    selected: string[];
    /** Group keys that contributed. */
    groups: ToolGroupKey[];
    /** Whether write tools were included. */
    mutating: boolean;
    /** Whether autonomy is engaged (raises cap). */
    autonomy: boolean;
    /** Human-readable rationale for the inspector channel. */
    rationale: string;
}
/**
 * Select an intent-appropriate subset of tool names.
 *
 * Returns *names*; the caller filters its full ToolDefinition[] against this set.
 * Tools that exist but don't match any group are kept as a small "passthrough"
 * tail (up to the cap) so 3rd-party MCP tools still work — but never crowd out
 * the curated selection.
 */
export declare function selectToolGroups(args: {
    task: ArchitectTask;
    intentMode?: string;
    prompt: string;
    autonomy: boolean;
    availableToolNames: string[];
    /**
     * Tools the previous assistant turn explicitly suggested by name.
     * Forced into the selection ahead of group expansion so brief follow-ups
     * ("yes", "do it", "go ahead") can still resolve the intended tool.
     * Caller is responsible for clearing/decaying these between turns.
     */
    primedTools?: string[];
}): ToolSelectionDecision;
//# sourceMappingURL=tool-groups.d.ts.map