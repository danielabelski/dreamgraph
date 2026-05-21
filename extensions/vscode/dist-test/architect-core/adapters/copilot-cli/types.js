"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — adapter-private type surface (Slice 1).
//
// These types describe the headless Copilot CLI invocation contract used by
// the adapter. They are intentionally NOT exported from `architect-core` —
// the adapter is consumed only via its barrel (`./index.ts`) and integrates
// with the Architect core via the existing `ProviderPort` seam in a later
// slice. Per the binding rule "no empty stubs", this file declares only
// concrete types and readonly constants — no functions yet.
//
// Provider-agnostic note: `providerId` is fixed to `"copilot-cli"` for this
// adapter. The Copilot-CLI-specific shape lives entirely behind this seam;
// the rest of the system never sees these types.
Object.defineProperty(exports, "__esModule", { value: true });
exports.COPILOT_INLINE_TOOL_SERVER = exports.DREAMGRAPH_AUTHORITATIVE_SERVER_NAME = exports.COPILOT_REQUIRED_AUTHORITATIVE_TOOLS = exports.COPILOT_AUTHORITATIVE_TOOL_CATALOG = exports.COPILOT_NATIVE_COMMAND_TOOLS = exports.COPILOT_BRIDGE_LOCAL_AUTHORITATIVE_TOOLS = exports.COPILOT_MINIMUM_AUTHORITATIVE_TOOLS = exports.COPILOT_CLI_PROVIDER_ID = void 0;
/**
 * Stable identifier for this provider adapter. The Architect core uses this
 * to route a `CallProviderInput` to this adapter when integration lands.
 */
exports.COPILOT_CLI_PROVIDER_ID = "copilot-cli";
/**
 * Minimum required-tool catalogue for the DreamGraph authoritative MCP
 * exposed to Copilot CLI. These graph/source reads are the fail-closed
 * grounding surface: if any are missing, the adapter refuses to launch with
 * `DREAMGRAPH_TOOL_REGISTRY_MISMATCH`.
 */
exports.COPILOT_MINIMUM_AUTHORITATIVE_TOOLS = Object.freeze([
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
/**
 * Tools served by the Copilot CLI stdio bridge itself rather than by
 * the upstream DreamGraph daemon. They are still authoritative
 * DreamGraph MCP tools from Copilot CLI's perspective because the
 * generated MCP server name is `dreamgraph`.
 */
exports.COPILOT_BRIDGE_LOCAL_AUTHORITATIVE_TOOLS = Object.freeze([
    "run_command",
]);
/**
 * Copilot CLI-native command tools the adapter intentionally exposes in
 * addition to DreamGraph MCP tools. These names are the CLI runtime's
 * bare tool identifiers; user-facing traces render them with the
 * `cli:` provenance prefix.
 *
 * Currently empty: GitHub Copilot CLI 1.x exposes a single native shell
 * tool named `shell` (grammar `shell(<command-pattern>)`), which the
 * adapter denies in argv because all shell execution must flow through
 * the audited, workspace-constrained `dreamgraph:run_command` bridge
 * tool. There is no native `powershell` tool to allow. Re-populate this
 * list only when a CLI-native command route is genuinely available AND
 * accepted by adapter policy.
 */
exports.COPILOT_NATIVE_COMMAND_TOOLS = Object.freeze([]);
/**
 * Full audited authoritative tool catalogue the Copilot CLI adapter may
 * expose when each tool exists on the live bridge surface. This deliberately
 * includes DreamGraph-native markdown, graph, source-edit, cognitive, and
 * verification tools so the CLI is not trapped in a read-only planning loop.
 *
 * Dangerous maintenance tools remain excluded; inline provider shell/write
 * surfaces are still denied in argv.ts. `run_command` is served by the bridge
 * as a guarded DreamGraph MCP tool because it is host-local in the VS Code
 * extension, not a daemon tool.
 */
exports.COPILOT_AUTHORITATIVE_TOOL_CATALOG = Object.freeze([
    ...exports.COPILOT_MINIMUM_AUTHORITATIVE_TOOLS,
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
    ...exports.COPILOT_BRIDGE_LOCAL_AUTHORITATIVE_TOOLS,
]);
/**
 * Backwards-compatible alias for the fail-closed minimum set. New code that
 * builds argv/tool manifests should use `COPILOT_AUTHORITATIVE_TOOL_CATALOG`
 * plus the live-registry intersection, not this minimum-only list.
 */
exports.COPILOT_REQUIRED_AUTHORITATIVE_TOOLS = exports.COPILOT_MINIMUM_AUTHORITATIVE_TOOLS;
/**
 * Logical name of the authoritative MCP server as seen by Copilot CLI.
 * Must match the `name` key under `mcpServers` in the generated
 * `mcp-config.json`.
 */
exports.DREAMGRAPH_AUTHORITATIVE_SERVER_NAME = "dreamgraph";
/**
 * Sentinel used in `ToolCallObservation.server` to denote a non-MCP
 * tool (`shell`, `write`, …) that the CLI exposes natively.
 */
exports.COPILOT_INLINE_TOOL_SERVER = "<inline>";
//# sourceMappingURL=types.js.map