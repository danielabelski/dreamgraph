import {
  ExperimentalEventKinds,
  type ExperimentalEventKind,
} from "@dreamgraph/sdk/events/experimental";
import {
  StableEventKinds,
  type PluginCapability,
  type PluginEffect,
  type PluginManifest,
  type PluginRejectReason,
  type StableEventKind,
} from "@dreamgraph/sdk";

/**
 * Result of evaluating a host gate against a plugin manifest or invocation.
 *
 * Pure data: gates never throw and never emit telemetry on their own. The
 * caller (loader / invocation wrapper) decides whether to publish a
 * `plugin.output.rejected` event based on the seam being checked.
 */
export type GateResult =
  | { ok: true }
  | { ok: false; reason: PluginRejectReason; detail?: string };

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/;

function pluginIdPrefix(pluginId: string): string {
  return `${pluginId}.`;
}

function pluginUriPrefix(pluginId: string): string {
  return `plugin://${pluginId}/`;
}

/**
 * Verify a tool registration is allowed under the manifest's declared
 * capabilities and the SDK naming rule.
 */
export function gateToolRegistration(args: {
  manifest: Pick<PluginManifest, "id" | "capabilities">;
  toolName: string;
  builtInToolNames?: ReadonlySet<string>;
}): GateResult {
  if (!args.manifest.capabilities.includes("tools:register")) {
    return { ok: false, reason: "tool_capability_missing" };
  }
  const required = pluginIdPrefix(args.manifest.id);
  if (!args.toolName.startsWith(required)) {
    return {
      ok: false,
      reason: "tool_name_unprefixed",
      detail: `Tool '${args.toolName}' must start with '${required}'`,
    };
  }
  if (args.builtInToolNames?.has(args.toolName)) {
    return {
      ok: false,
      reason: "tool_name_collision",
      detail: `Tool '${args.toolName}' collides with a built-in tool`,
    };
  }
  return { ok: true };
}

/**
 * Verify a resource registration is allowed.
 */
export function gateResourceRegistration(args: {
  manifest: Pick<PluginManifest, "id" | "capabilities">;
  uri: string;
}): GateResult {
  if (!args.manifest.capabilities.includes("resources:register")) {
    return { ok: false, reason: "resource_capability_missing" };
  }
  const required = pluginUriPrefix(args.manifest.id);
  if (!args.uri.startsWith(required)) {
    return {
      ok: false,
      reason: "resource_uri_out_of_namespace",
      detail: `Resource '${args.uri}' must start with '${required}'`,
    };
  }
  return { ok: true };
}

/**
 * Verify an event subscription is allowed for both stable and experimental
 * kinds. The experimental gate also enforces the instance opt-in flag.
 */
export function gateEventSubscription(args: {
  manifest: Pick<PluginManifest, "capabilities">;
  kind: string;
  /** Whether the host instance has set `experimental_plugins: true`. */
  experimentalEnabled: boolean;
}): GateResult {
  const isStable = (StableEventKinds as readonly string[]).includes(args.kind);
  const isExperimental = (ExperimentalEventKinds as readonly string[]).includes(
    args.kind,
  );
  if (!isStable && !isExperimental) {
    return {
      ok: false,
      reason: "event_kind_not_declared",
      detail: `Unknown event kind '${args.kind}'`,
    };
  }
  if (isStable) {
    if (!args.manifest.capabilities.includes("events:read")) {
      return { ok: false, reason: "event_capability_missing" };
    }
    return { ok: true };
  }
  // experimental
  if (!args.manifest.capabilities.includes("events:read:experimental")) {
    return { ok: false, reason: "event_kind_experimental" };
  }
  if (!args.experimentalEnabled) {
    return { ok: false, reason: "experimental_events_disabled" };
  }
  return { ok: true };
}

/**
 * Verify that an effect about to be performed is inside the manifest's
 * declared envelope. Used by every host-mediated effect path before commit.
 */
export function gateEffect(args: {
  manifest: Pick<PluginManifest, "expectedEffects" | "forbiddenEffects">;
  effect: PluginEffect;
}): GateResult {
  if ((args.manifest.forbiddenEffects ?? []).includes(args.effect)) {
    return {
      ok: false,
      reason: "effect_forbidden",
      detail: `Effect '${args.effect}' is in forbiddenEffects`,
    };
  }
  if (!args.manifest.expectedEffects.includes(args.effect)) {
    return {
      ok: false,
      reason: "effect_undeclared",
      detail: `Effect '${args.effect}' is not in expectedEffects`,
    };
  }
  return { ok: true };
}

/**
 * Verify the host execution policy permits loading this plugin in-process.
 *
 * Per `plans/DREAMGRAPH_SDK_ROADMAP.md` §5.2:
 * - if `allowInProcessPlugins !== true`, plugins are out-of-process by default;
 * - a plugin may still be loaded in-process when `trusted: true`;
 * - this is an extra-safety bridge until M8 worker isolation lands.
 */
export function gateInProcessLoad(args: {
  allowInProcessPlugins: boolean;
  trusted: boolean;
}): GateResult {
  if (args.allowInProcessPlugins) return { ok: true };
  if (args.trusted) return { ok: true };
  return {
    ok: false,
    reason: "in_process_execution_disabled",
    detail:
      "Host has allowInProcessPlugins=false and plugin is not marked trusted",
  };
}

/**
 * Verify a plugin id satisfies the SDK naming rule. The SDK schema already
 * enforces this; we re-check at the host boundary to defend against bypass
 * via raw-JSON manifests that skip the zod schema.
 */
export function gatePluginId(pluginId: string): GateResult {
  if (!PLUGIN_ID_RE.test(pluginId)) {
    return {
      ok: false,
      reason: "manifest_invalid",
      detail: `Plugin id '${pluginId}' is not a valid DNS-like identifier`,
    };
  }
  return { ok: true };
}

/**
 * Type guards usable from external callers.
 */
export function isStableEventKind(value: unknown): value is StableEventKind {
  return (
    typeof value === "string" && (StableEventKinds as readonly string[]).includes(value)
  );
}

export function isExperimentalEventKind(
  value: unknown,
): value is ExperimentalEventKind {
  return (
    typeof value === "string" &&
    (ExperimentalEventKinds as readonly string[]).includes(value)
  );
}

/**
 * Convenience: the union of all capability values the SDK currently exposes.
 * Re-exported for host consumers that need a runtime list.
 */
export const KNOWN_CAPABILITIES: readonly PluginCapability[] = [
  "events:read",
  "events:read:experimental",
  "events:emit",
  "tools:register",
  "resources:register",
  "resources:read",
  "ui:register",
  "policy:propose",
  "schedule:register_action",
  "webhooks:emit",
  "archetypes:provide",
  "providers:register",
];
