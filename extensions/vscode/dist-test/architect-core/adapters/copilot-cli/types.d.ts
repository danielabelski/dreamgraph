/**
 * Stable identifier for this provider adapter. The Architect core uses this
 * to route a `CallProviderInput` to this adapter when integration lands.
 */
export declare const COPILOT_CLI_PROVIDER_ID: "copilot-cli";
export type CopilotCliProviderId = typeof COPILOT_CLI_PROVIDER_ID;
/**
 * Canonical machine-readable failure modes for the Copilot CLI adapter.
 *
 * Hardened in Slice 1 of plans/SUBSCRIPTION_LLM_SURFACE.md §1.15. These
 * codes appear verbatim in audit-log entries and `ProviderProposal`
 * failure payloads so the host can react deterministically.
 */
export type CopilotCliErrorCode = "COPILOT_CLI_NOT_FOUND" | "COPILOT_CLI_VERSION_UNSUPPORTED" | "COPILOT_HELP_SURFACE_UNSUPPORTED" | "COPILOT_NOT_LOGGED_IN" | "MCP_PROBE_FAILED" | "MCP_ISOLATION_UNSUPPORTED" | "DREAMGRAPH_TOOL_REGISTRY_MISMATCH" | "WORKSPACE_NOT_OPTED_IN" | "CWD_POLICY_VIOLATION" | "PERMISSION_ARG_POLICY_UNSUPPORTED" | "TIMEOUT" | "OUTPUT_LIMIT_EXCEEDED" | "AUTHORITATIVE_TOOL_REJECTED" | "GLOBAL_MCP_VISIBLE_IN_AUTHORITATIVE_MODE" | "INLINE_WRITE_OR_SHELL_ATTEMPTED" | "PATCH_OUT_OF_WORKSPACE" | "DIRECT_WORKSPACE_WRITE_DETECTED" | "CANCELLED" | "COPILOT_RUN_NONZERO_EXIT" | "COPILOT_RUN_SIGNALED";
/**
 * Minimum required-tool catalogue for the DreamGraph authoritative MCP
 * exposed to Copilot CLI. These graph/source reads are the fail-closed
 * grounding surface: if any are missing, the adapter refuses to launch with
 * `DREAMGRAPH_TOOL_REGISTRY_MISMATCH`.
 */
export declare const COPILOT_MINIMUM_AUTHORITATIVE_TOOLS: readonly ["query_resource", "query_api_surface", "read_source_code", "search_source_code", "list_directory", "list_markdown_chapters", "read_markdown_chapter", "graph_rag_retrieve", "shortest_path", "query_db_schema"];
/**
 * Tools served by the Copilot CLI stdio bridge itself rather than by
 * the upstream DreamGraph daemon. They are still authoritative
 * DreamGraph MCP tools from Copilot CLI's perspective because the
 * generated MCP server name is `dreamgraph`.
 */
export declare const COPILOT_BRIDGE_LOCAL_AUTHORITATIVE_TOOLS: readonly ["run_command"];
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
export declare const COPILOT_NATIVE_COMMAND_TOOLS: readonly [];
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
export declare const COPILOT_AUTHORITATIVE_TOOL_CATALOG: readonly ["query_resource", "query_api_surface", "read_source_code", "search_source_code", "list_directory", "list_markdown_chapters", "read_markdown_chapter", "graph_rag_retrieve", "shortest_path", "query_db_schema", "create_file", "edit_file", "delete_file", "rename_file", "edit_entity", "patch_file", "append_to_file", "edit_markdown_section", "patch_markdown_chapter", "enrich_seed_data", "enrich_parser_nodes", "solidify_cognitive_insight", "register_ui_element", "modify_api_surface", "record_architecture_decision", "query_architecture_decisions", "deprecate_architecture_decision", "cognitive_status", "get_dream_insights", "query_dreams", "get_causal_insights", "get_temporal_insights", "get_system_narrative", "get_system_story", "get_cognitive_preamble", "get_remediation_plan", "query_self_metrics", "dream_cycle", "normalize_dreams", "nightmare_cycle", "lucid_dream", "lucid_action", "wake_from_lucid", "schedule_dream", "list_schedules", "update_schedule", "run_schedule_now", "delete_schedule", "get_schedule_history", "init_graph", "scan_project", "extract_api_surface", "generate_visual_flow", "export_living_docs", "generate_ui_migration_plan", "export_dream_archetypes", "git_log", "git_blame", "fetch_web_page", "run_command"];
/**
 * Backwards-compatible alias for the fail-closed minimum set. New code that
 * builds argv/tool manifests should use `COPILOT_AUTHORITATIVE_TOOL_CATALOG`
 * plus the live-registry intersection, not this minimum-only list.
 */
export declare const COPILOT_REQUIRED_AUTHORITATIVE_TOOLS: readonly ["query_resource", "query_api_surface", "read_source_code", "search_source_code", "list_directory", "list_markdown_chapters", "read_markdown_chapter", "graph_rag_retrieve", "shortest_path", "query_db_schema"];
export type CopilotAuthoritativeToolName = (typeof COPILOT_AUTHORITATIVE_TOOL_CATALOG)[number];
/**
 * Logical name of the authoritative MCP server as seen by Copilot CLI.
 * Must match the `name` key under `mcpServers` in the generated
 * `mcp-config.json`.
 */
export declare const DREAMGRAPH_AUTHORITATIVE_SERVER_NAME: "dreamgraph";
export type DreamgraphAuthoritativeServerName = typeof DREAMGRAPH_AUTHORITATIVE_SERVER_NAME;
/**
 * Distilled view of `copilot --help` output. Only flags this adapter
 * actually relies on are tracked. Each field reports presence/absence
 * derived from real help text — never fabricated.
 *
 * Required flags (adapter aborts with COPILOT_HELP_SURFACE_UNSUPPORTED if
 * any of these is not seen in the help output):
 *   prompt        — `-p` / `--prompt`
 *   allowTool     — `--allow-tool`
 *   denyTool      — `--deny-tool`
 *   model         — `--model`
 *   allowAllTools — `--allow-all-tools` (the CLI's own help text
 *                    documents this as "required for non-interactive
 *                    mode"; safety is preserved by the adapter's
 *                    unconditional `--deny-tool shell` and
 *                    `--deny-tool write` which take precedence)
 *
 * Optional flags (presence reported, absence tolerated):
 *   availableTools      — `--available-tools` (used to hard-limit tool surface)
 *   disallowTempDir     — `--disallow-temp-dir` (workspace isolation hardening)
 *   allowUrl            — `--allow-url`
 *   denyUrl             — `--deny-url`
 *   additionalMcpConfig — `--additional-mcp-config` (per-session MCP
 *                          server injection on argv). Tracked but NOT
 *                          required: the adapter follows the
 *                          control-plane / data-plane split and
 *                          delivers MCP config via
 *                          `<COPILOT_HOME>/mcp-config.json` (the
 *                          documented data-plane path) inside an
 *                          isolated per-run `COPILOT_HOME`. Argv stays
 *                          tiny, payload travels by file.
 */
export interface CopilotHelpSurface {
    /** Raw help-text length, useful as a fingerprint in audit entries. */
    readonly rawLength: number;
    /** Verbatim version string parsed from `--version`-style output, if present. */
    readonly versionString: string | null;
    readonly required: {
        readonly prompt: boolean;
        readonly allowTool: boolean;
        readonly denyTool: boolean;
        readonly model: boolean;
        readonly allowAllTools: boolean;
    };
    readonly optional: {
        readonly availableTools: boolean;
        readonly disallowTempDir: boolean;
        readonly allowUrl: boolean;
        readonly denyUrl: boolean;
        readonly additionalMcpConfig: boolean;
    };
}
/**
 * Result of validating the live DreamGraph tool registry against the
 * required authoritative tool set.
 */
export interface AuthoritativeAllowlist {
    /** Tool names actually exposed (intersection of required and live). */
    readonly tools: readonly string[];
    /** Required tools that were missing from the live registry. */
    readonly missingRequired: readonly string[];
    /** True iff every required tool is present in the live registry. */
    readonly ok: boolean;
}
/**
 * Inputs for generating the per-run isolated `mcp-config.json` that
 * Copilot CLI reads from `$COPILOT_HOME/mcp-config.json`.
 */
export interface CopilotMcpConfigInput {
    /** Per-run identifier, embedded for traceability. */
    readonly runId: string;
    /** Opaque transport token the DreamGraph MCP will validate on connect. */
    readonly transportToken: string;
    /**
     * Executable Copilot CLI will spawn to launch the authoritative
     * DreamGraph MCP (e.g. node, npx, or an absolute path).
     */
    readonly dreamgraphCommand: string;
    /** Argv passed to `dreamgraphCommand`. */
    readonly dreamgraphArgs: readonly string[];
    /** Optional environment overrides for the MCP child process. */
    readonly dreamgraphEnv?: Readonly<Record<string, string>>;
    /**
     * Authoritative tool allowlist. Recorded inside the config blob for
     * audit purposes (Copilot CLI itself enforces tool gating via
     * `--allow-tool` / `--available-tools`, not via this file).
     */
    readonly allowlist: readonly string[];
}
/**
 * Generated MCP config artifact. Caller writes `content` (JSON-serialized)
 * to `<copilotHome>/<filename>`.
 */
export interface CopilotMcpConfigArtifact {
    readonly filename: "mcp-config.json";
    readonly content: {
        readonly mcpServers: Readonly<Record<string, {
            readonly type: "stdio";
            readonly command: string;
            readonly args: readonly string[];
            readonly env: Readonly<Record<string, string>>;
        }>>;
        readonly _dreamgraph_meta: {
            readonly runId: string;
            readonly authoritativeServer: DreamgraphAuthoritativeServerName;
            readonly allowlist: readonly string[];
        };
    };
}
/**
 * Inputs for building the argv that the adapter will hand to
 * `child_process.spawn` in a later slice.
 */
export interface CopilotArgvInput {
    /** The user-visible prompt text. */
    readonly prompt: string;
    /** Optional model override (e.g. `claude-sonnet-4.5`). */
    readonly model?: string;
    /** Authoritative MCP server name + per-tool allowlist. */
    readonly authoritativeServer: DreamgraphAuthoritativeServerName;
    readonly authoritativeAllowlist: readonly string[];
    /**
     * Help-surface probe result. Optional flags that were NOT detected in
     * the running CLI's help output are silently omitted from argv.
     */
    readonly helpSurface: CopilotHelpSurface;
    /**
     * Extra directories the CLI's file-access layer should treat as
     * allowed for read tools. Emitted as one `--add-dir <path>` per entry.
     * The orchestrator uses this to expose the per-run scratch directory
     * (where `prompt.md` lives) when the prompt is delivered via the
     * file-redirect directive instead of inline argv.
     */
    readonly addDirs?: readonly string[];
}
/**
 * Result of the pure argv builder. The caller passes `args` straight to
 * `spawn(executable, args, …)`. `policy` records the safety decisions
 * baked into argv so they can be replayed in the audit log.
 */
export interface CopilotArgvPlan {
    readonly args: readonly string[];
    readonly policy: {
        readonly availableToolsRestricted: boolean;
        readonly tempDirDisallowed: boolean;
        readonly inlineShellDenied: boolean;
        readonly inlineWriteDenied: boolean;
        readonly allowAllToolsEnabled: boolean;
        readonly allowedNativeToolSpecs: readonly string[];
        readonly allowedToolSpecs: readonly string[];
        readonly deniedToolSpecs: readonly string[];
        readonly addedDirs: readonly string[];
    };
}
/**
 * Categorisation of a single tool-call observed in the Copilot CLI
 * transcript. Slice 1 only requires this discrimination — richer detail
 * (timings, payload sizes) belongs to a later slice.
 */
export type ToolCallClass = "dreamgraph_authoritative" | "dreamgraph_rejected" | "generic_context_mcp" | "provider_inline_tool";
export interface ToolCallObservation {
    /**
     * MCP server name as reported by Copilot CLI. Provider-inline tools
     * (e.g. the CLI's own `shell` / `write` surfaces) report the sentinel
     * value `"<inline>"`.
     */
    readonly server: string;
    /** Tool name as reported by the server (or inline surface). */
    readonly tool: string;
}
export interface ToolCallClassificationContext {
    readonly authoritativeServer: DreamgraphAuthoritativeServerName;
    readonly allowlist: readonly string[];
}
/**
 * Sentinel used in `ToolCallObservation.server` to denote a non-MCP
 * tool (`shell`, `write`, …) that the CLI exposes natively.
 */
export declare const COPILOT_INLINE_TOOL_SERVER: "<inline>";
//# sourceMappingURL=types.d.ts.map