"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Codex CLI adapter - adapter-private type surface (Slice 1).
Object.defineProperty(exports, "__esModule", { value: true });
exports.CODEX_INLINE_TOOL_SERVER = exports.DREAMGRAPH_AUTHORITATIVE_SERVER_NAME = exports.CODEX_REQUIRED_AUTHORITATIVE_TOOLS = exports.CODEX_AUTHORITATIVE_TOOL_CATALOG = exports.CODEX_BRIDGE_LOCAL_AUTHORITATIVE_TOOLS = exports.CODEX_MINIMUM_AUTHORITATIVE_TOOLS = exports.CODEX_CLI_PROVIDER_ID = void 0;
exports.CODEX_CLI_PROVIDER_ID = "codex-cli";
exports.CODEX_MINIMUM_AUTHORITATIVE_TOOLS = Object.freeze([
    "query_resource",
    "query_api_surface",
    "read_source_code",
    "search_source_code",
    "list_directory",
    "list_markdown_chapters",
    "read_markdown_chapter",
    "graph_rag_retrieve",
    "shortest_path",
    "query_db_schema",
]);
exports.CODEX_BRIDGE_LOCAL_AUTHORITATIVE_TOOLS = Object.freeze([
    "run_command",
]);
exports.CODEX_AUTHORITATIVE_TOOL_CATALOG = Object.freeze([
    ...exports.CODEX_MINIMUM_AUTHORITATIVE_TOOLS,
    "create_file",
    "edit_file",
    "delete_file",
    "rename_file",
    "edit_entity",
    "patch_file",
    "append_to_file",
    "edit_markdown_section",
    "patch_markdown_chapter",
    "enrich_seed_data",
    "enrich_parser_nodes",
    "solidify_cognitive_insight",
    "register_ui_element",
    "modify_api_surface",
    "record_architecture_decision",
    "query_architecture_decisions",
    "deprecate_architecture_decision",
    "cognitive_status",
    "get_dream_insights",
    "query_dreams",
    "get_causal_insights",
    "get_temporal_insights",
    "get_system_narrative",
    "get_system_story",
    "get_cognitive_preamble",
    "get_remediation_plan",
    "query_self_metrics",
    "dream_cycle",
    "normalize_dreams",
    "nightmare_cycle",
    "lucid_dream",
    "lucid_action",
    "wake_from_lucid",
    "schedule_dream",
    "list_schedules",
    "update_schedule",
    "run_schedule_now",
    "delete_schedule",
    "get_schedule_history",
    "init_graph",
    "scan_project",
    "extract_api_surface",
    "generate_visual_flow",
    "export_living_docs",
    "generate_ui_migration_plan",
    "export_dream_archetypes",
    "git_log",
    "git_blame",
    "fetch_web_page",
    ...exports.CODEX_BRIDGE_LOCAL_AUTHORITATIVE_TOOLS,
]);
exports.CODEX_REQUIRED_AUTHORITATIVE_TOOLS = exports.CODEX_MINIMUM_AUTHORITATIVE_TOOLS;
exports.DREAMGRAPH_AUTHORITATIVE_SERVER_NAME = "dreamgraph";
exports.CODEX_INLINE_TOOL_SERVER = "<inline>";
//# sourceMappingURL=types.js.map