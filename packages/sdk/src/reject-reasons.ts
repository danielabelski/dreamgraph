/**
 * Typed enumeration of the semantic reasons the host may refuse a
 * plugin-mediated effect, registration, or invocation.
 *
 * This is the source of truth for `plugin.output.rejected{ reason }` payloads
 * and is mirrored by the host capability/effect gate registry described in
 * `plans/DREAMGRAPH_SDK_ROADMAP.md` (§M0 Gap 3 allow/deny table).
 *
 * Plugin authors and host implementors MUST agree on this exact set so that
 * operators can reason about denials without reading host source.
 */
export const PluginRejectReasons = [
  // tools:register
  "tool_name_unprefixed",
  "tool_name_collision",
  "tool_capability_missing",

  // resources:register
  "resource_uri_out_of_namespace",
  "resource_capability_missing",

  // events:read / events:read:experimental
  "event_kind_not_declared",
  "event_kind_experimental",
  "experimental_events_disabled",
  "event_capability_missing",

  // events:emit
  "effect_undeclared",
  "effect_forbidden",
  "emit_capability_missing",

  // schedule:register_action
  "action_id_collision",
  "action_schema_missing",
  "schedule_capability_missing",

  // webhooks:emit (post-M5)
  "webhook_unsigned",
  "webhook_target_blocked",
  "webhook_capability_missing",

  // invoke_llm
  "llm_budget_exceeded",
  "llm_disabled",
  "llm_capability_missing",

  // ui:register
  "ui_id_unprefixed",
  "ui_capability_missing",

  // policy:propose
  "policy_weakening_rejected",
  "policy_capability_missing",

  // archetypes:provide
  "archetype_schema_invalid",
  "archetype_capability_missing",

  // markdown:register_fence
  "markdown_fence_capability_missing",
  "markdown_fence_language_collision",
  "markdown_fence_language_invalid",

  // providers:register (post-MVP)
  "provider_capability_missing",

  // architect tabs
  "architect_tab_capability_missing",
  "architect_plan_state_capability_missing",
  "architect_tab_id_unprefixed",
  "architect_tab_collision",
  "architect_tab_undeclared",
  "architect_action_unknown",
  "architect_action_schema_invalid",
  "architect_plan_required",
  "architect_plan_not_found",
  "architect_revision_stale",
  "architect_tab_unavailable",

  // host execution boundary
  "in_process_execution_disabled",
  "plugin_quarantined",
  "event_loop_stall",
  "handler_timeout",
  "handler_threw",
  "manifest_invalid",
  "engine_version_mismatch",
] as const;

export type PluginRejectReason = (typeof PluginRejectReasons)[number];

/**
 * Bucket a reject reason by the seam it belongs to. Useful for operator UIs
 * that group plugin denials by surface.
 */
export type PluginRejectSeam =
  | "tools"
  | "resources"
  | "events"
  | "schedule"
  | "webhooks"
  | "llm"
  | "ui"
  | "policy"
  | "archetypes"
  | "markdown_fences"
  | "providers"
  | "architect"
  | "host";

const REASON_TO_SEAM: Record<PluginRejectReason, PluginRejectSeam> = {
  tool_name_unprefixed: "tools",
  tool_name_collision: "tools",
  tool_capability_missing: "tools",
  resource_uri_out_of_namespace: "resources",
  resource_capability_missing: "resources",
  event_kind_not_declared: "events",
  event_kind_experimental: "events",
  experimental_events_disabled: "events",
  event_capability_missing: "events",
  effect_undeclared: "events",
  effect_forbidden: "events",
  emit_capability_missing: "events",
  action_id_collision: "schedule",
  action_schema_missing: "schedule",
  schedule_capability_missing: "schedule",
  webhook_unsigned: "webhooks",
  webhook_target_blocked: "webhooks",
  webhook_capability_missing: "webhooks",
  llm_budget_exceeded: "llm",
  llm_disabled: "llm",
  llm_capability_missing: "llm",
  ui_id_unprefixed: "ui",
  ui_capability_missing: "ui",
  policy_weakening_rejected: "policy",
  policy_capability_missing: "policy",
  archetype_schema_invalid: "archetypes",
  archetype_capability_missing: "archetypes",
  markdown_fence_capability_missing: "markdown_fences",
  markdown_fence_language_collision: "markdown_fences",
  markdown_fence_language_invalid: "markdown_fences",
  provider_capability_missing: "providers",
  architect_tab_capability_missing: "architect",
  architect_plan_state_capability_missing: "architect",
  architect_tab_id_unprefixed: "architect",
  architect_tab_collision: "architect",
  architect_tab_undeclared: "architect",
  architect_action_unknown: "architect",
  architect_action_schema_invalid: "architect",
  architect_plan_required: "architect",
  architect_plan_not_found: "architect",
  architect_revision_stale: "architect",
  architect_tab_unavailable: "architect",
  in_process_execution_disabled: "host",
  plugin_quarantined: "host",
  event_loop_stall: "host",
  handler_timeout: "host",
  handler_threw: "host",
  manifest_invalid: "host",
  engine_version_mismatch: "host",
};

export function rejectSeamOf(reason: PluginRejectReason): PluginRejectSeam {
  return REASON_TO_SEAM[reason];
}

export function isPluginRejectReason(value: unknown): value is PluginRejectReason {
  return typeof value === "string" && (PluginRejectReasons as readonly string[]).includes(value);
}
