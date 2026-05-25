// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Codex CLI adapter - adapter-private type surface (Slice 1).

export const CODEX_CLI_PROVIDER_ID = "codex-cli" as const;
export type CodexCliProviderId = typeof CODEX_CLI_PROVIDER_ID;

export type CodexCliErrorCode =
  | "CODEX_CLI_NOT_FOUND"
  | "CODEX_CLI_VERSION_UNSUPPORTED"
  | "CODEX_HELP_SURFACE_UNSUPPORTED"
  | "CODEX_NOT_LOGGED_IN"
  | "CODEX_USAGE_LIMIT"
  | "CODEX_MODEL_UNSUPPORTED"
  | "CODEX_POLICY_DENIED"
  | "DREAMGRAPH_TOOL_MISSING"
  | "DREAMGRAPH_TOOL_POLICY_BLOCKED"
  | "DREAMGRAPH_TOOL_SCHEMA_ARGS"
  | "DREAMGRAPH_TOOL_AUTHORIZATION_NEEDED"
  | "DREAMGRAPH_MCP_RUNTIME_FAILURE"
  | "MCP_PROBE_FAILED"
  | "MCP_ISOLATION_UNSUPPORTED"
  | "DREAMGRAPH_TOOL_REGISTRY_MISMATCH"
  | "WORKSPACE_NOT_OPTED_IN"
  | "CWD_POLICY_VIOLATION"
  | "CONFIG_OVERRIDE_POLICY_UNSUPPORTED"
  | "TIMEOUT"
  | "OUTPUT_LIMIT_EXCEEDED"
  | "AUTHORITATIVE_TOOL_REJECTED"
  | "GLOBAL_MCP_VISIBLE_IN_AUTHORITATIVE_MODE"
  | "INLINE_WRITE_OR_SHELL_ATTEMPTED"
  | "PATCH_OUT_OF_WORKSPACE"
  | "DIRECT_WORKSPACE_WRITE_DETECTED"
  | "CANCELLED"
  | "CODEX_RUN_NONZERO_EXIT"
  | "CODEX_RUN_SIGNALED";

export const CODEX_MINIMUM_AUTHORITATIVE_TOOLS = Object.freeze([
  "query_resource",
  "graph_rag_retrieve",
  "shortest_path",
  "query_api_surface",
  "read_source_code",
  "list_directory",
  "search_source_code",
  "list_markdown_chapters",
  "read_markdown_chapter",
  "cognitive_status",
] as const);

// Bridge-local verification is explicitly exposed when the host policy allows
// it. Source and graph reads/mutations prefer DreamGraph's repo-aware upstream
// tools so multi-repository instances do not depend on a single VS Code
// workspace root.
export const CODEX_BRIDGE_LOCAL_AUTHORITATIVE_TOOLS = Object.freeze([
  "run_command",
] as const);

export const CODEX_AUTHORITATIVE_TOOL_CATALOG = Object.freeze([
  ...CODEX_MINIMUM_AUTHORITATIVE_TOOLS,
  "read_local_file",
  "run_command",
  "create_file",
  "edit_file",
  "delete_file",
  "rename_file",
  "write_file",
  "modify_entity",
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
] as const);

export const CODEX_REQUIRED_AUTHORITATIVE_TOOLS =
  CODEX_MINIMUM_AUTHORITATIVE_TOOLS;

export type CodexAuthoritativeToolName =
  (typeof CODEX_AUTHORITATIVE_TOOL_CATALOG)[number];

export const DREAMGRAPH_AUTHORITATIVE_SERVER_NAME = "dreamgraph" as const;
export type DreamgraphAuthoritativeServerName =
  typeof DREAMGRAPH_AUTHORITATIVE_SERVER_NAME;

export interface CodexHelpSurface {
  readonly rawLength: number;
  readonly versionString: string | null;
  readonly root: {
    readonly execCommand: boolean;
    readonly askForApproval: boolean;
  };
  readonly exec: {
    readonly json: boolean;
    readonly model: boolean;
    readonly cd: boolean;
    readonly sandbox: boolean;
    readonly askForApproval: boolean;
    readonly config: boolean;
    readonly profile: boolean;
    readonly addDir: boolean;
    readonly outputLastMessage: boolean;
    readonly outputSchema: boolean;
    readonly skipGitRepoCheck: boolean;
    readonly ignoreUserConfig: boolean;
    readonly ignoreRules: boolean;
    readonly ephemeral: boolean;
    readonly positionalStdinPrompt: boolean;
  };
  readonly safety: {
    readonly sandboxModes: readonly string[];
    readonly approvalModes: readonly string[];
    readonly fullAutoDeprecated: boolean;
    readonly dangerousBypass: boolean;
  };
}

export interface AuthoritativeAllowlist {
  readonly tools: readonly string[];
  readonly missingRequired: readonly string[];
  readonly ok: boolean;
}

export interface CodexMcpConfigInput {
  readonly runId: string;
  readonly transportToken: string;
  readonly dreamgraphCommand: string;
  readonly dreamgraphArgs: readonly string[];
  readonly dreamgraphEnv?: Readonly<Record<string, string>>;
  readonly allowlist: readonly string[];
}

export interface CodexMcpConfigArtifact {
  readonly filename: "config.toml";
  readonly content: string;
  readonly metadata: {
    readonly runId: string;
    readonly authoritativeServer: DreamgraphAuthoritativeServerName;
    readonly allowlist: readonly string[];
  };
}

export interface CodexMcpBridgePlanInput {
  readonly runId: string;
  readonly transportToken: string;
  readonly dreamgraphCommand: string;
  readonly dreamgraphArgs: readonly string[];
  readonly dreamgraphEnv?: Readonly<Record<string, string>>;
  readonly liveToolNames: readonly string[];
}

export interface CodexMcpBridgePlan {
  readonly allowlist: AuthoritativeAllowlist;
  readonly config: CodexMcpConfigArtifact;
  readonly configOverrides: readonly CodexConfigOverride[];
  readonly registry: {
    readonly authoritativeServer: DreamgraphAuthoritativeServerName;
    readonly requiredTools: readonly string[];
    readonly allowedTools: readonly string[];
    readonly missingRequired: readonly string[];
  };
}

export interface CodexConfigOverride {
  readonly key: string;
  readonly value: string | number | boolean;
}

export interface CodexArgvInput {
  readonly workspace: string;
  readonly model?: string;
  readonly profile?: string;
  readonly outputLastMessagePath?: string;
  readonly outputSchemaPath?: string;
  readonly configOverrides?: readonly CodexConfigOverride[];
  readonly addDirs?: readonly string[];
  readonly skipGitRepoCheck?: boolean;
  readonly ignoreUserConfig?: boolean;
  readonly ignoreRules?: boolean;
  readonly ephemeral?: boolean;
  readonly helpSurface: CodexHelpSurface;
}

export interface CodexArgvPlan {
  readonly args: readonly string[];
  readonly policy: {
    readonly sandboxMode: "read-only";
    readonly approvalMode: "never" | "not-advertised";
    readonly promptSource: "stdin-positional-dash";
    readonly jsonEventsEnabled: boolean;
    readonly userConfigIgnored: boolean;
    readonly rulesIgnored: boolean;
    readonly ephemeral: boolean;
    readonly gitRepoCheckSkipped: boolean;
    readonly addedDirs: readonly string[];
    readonly configOverrides: readonly string[];
  };
}

export type ToolCallClass =
  | "dreamgraph_authoritative"
  | "dreamgraph_rejected"
  | "generic_context_mcp"
  | "provider_inline_tool";

export interface ToolCallObservation {
  readonly server: string;
  readonly tool: string;
}

export type CodexToolCallWitnessStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export interface CodexToolCallWitness {
  readonly server: string;
  readonly tool: string;
  readonly status: CodexToolCallWitnessStatus;
  readonly detail?: string;
  readonly source: "structured-event" | "diagnostic";
  readonly sequence: number;
}

export interface ToolCallClassificationContext {
  readonly authoritativeServer: DreamgraphAuthoritativeServerName;
  readonly allowlist: readonly string[];
}

export const CODEX_INLINE_TOOL_SERVER = "<inline>" as const;

export interface CodexTokenUsage {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly raw: unknown;
}

export interface CodexStructuredError {
  readonly type: string;
  readonly code?: string;
  readonly message: string;
  readonly retryAt?: string;
  readonly raw: unknown;
}

export interface CodexUsageLimitInfo {
  readonly message: string;
  readonly code?: string;
  readonly retryAt?: string;
}

export interface CodexTranscriptTurnStats {
  readonly started: number;
  readonly completed: number;
}

export interface CodexCliTranscript {
  readonly assistantText: string;
  readonly assistantDeltas: readonly string[];
  readonly diagnostics: readonly string[];
  readonly hasStderrErrors: boolean;
  readonly notLoggedIn: boolean;
  readonly toolCalls: readonly ToolCallObservation[];
  readonly toolCallWitnesses: readonly CodexToolCallWitness[];
  readonly usage: CodexTokenUsage | null;
  readonly structuredErrors: readonly CodexStructuredError[];
  readonly usageLimit: CodexUsageLimitInfo | null;
  readonly modelUnsupported: boolean;
  readonly policyDenied: boolean;
  readonly pluginSyncWarnings: readonly string[];
  readonly turns: CodexTranscriptTurnStats;
  readonly completedItemCount: number;
}

export interface CodexCliRunResult {
  readonly provider: CodexCliProviderId;
  readonly runId: string;
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly failureCode?: CodexCliErrorCode;
  readonly durationMs: number;
  readonly argv: readonly string[];
  readonly transcript: CodexCliTranscript;
  readonly toolCalls: readonly ToolCallObservation[];
  readonly toolCallWitnesses: readonly CodexToolCallWitness[];
}
