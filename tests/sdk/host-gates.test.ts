import { describe, expect, it } from "vitest";
import {
  gateEffect,
  gateEventSubscription,
  gateInProcessLoad,
  gatePluginId,
  gateResourceRegistration,
  gateToolRegistration,
} from "../../packages/host/src/gates.js";

const baseManifest = {
  id: "example.plugin",
  capabilities: [
    "tools:register",
    "resources:register",
    "events:read",
  ] as const,
  expectedEffects: ["emit_tool", "emit_resource"] as const,
  forbiddenEffects: ["write_internal_graph"] as const,
};

describe("host capability gates", () => {
  it("accepts a properly prefixed tool when capability is held", () => {
    const result = gateToolRegistration({
      manifest: baseManifest,
      toolName: "example.plugin.echo",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an unprefixed tool name with the canonical reason", () => {
    const result = gateToolRegistration({
      manifest: baseManifest,
      toolName: "echo",
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, reason: "tool_name_unprefixed" }),
    );
  });

  it("rejects a tool that collides with a built-in name", () => {
    const result = gateToolRegistration({
      manifest: baseManifest,
      toolName: "example.plugin.echo",
      builtInToolNames: new Set(["example.plugin.echo"]),
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, reason: "tool_name_collision" }),
    );
  });

  it("rejects a tool registration without tools:register", () => {
    const result = gateToolRegistration({
      manifest: { id: "example.plugin", capabilities: ["events:read"] },
      toolName: "example.plugin.echo",
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, reason: "tool_capability_missing" }),
    );
  });

  it("rejects a resource URI outside the plugin namespace", () => {
    const result = gateResourceRegistration({
      manifest: baseManifest,
      uri: "system://overview",
    });
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        reason: "resource_uri_out_of_namespace",
      }),
    );
  });

  it("accepts a stable event subscription with events:read", () => {
    const result = gateEventSubscription({
      manifest: baseManifest,
      kind: "snapshot.changed",
      experimentalEnabled: false,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a stable event subscription without events:read", () => {
    const result = gateEventSubscription({
      manifest: { capabilities: [] },
      kind: "snapshot.changed",
      experimentalEnabled: false,
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, reason: "event_capability_missing" }),
    );
  });

  it("rejects an experimental subscription that lacks the experimental capability", () => {
    const result = gateEventSubscription({
      manifest: baseManifest,
      kind: "tension.created",
      experimentalEnabled: true,
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, reason: "event_kind_experimental" }),
    );
  });

  it("rejects an experimental subscription when the instance has not opted in", () => {
    const result = gateEventSubscription({
      manifest: { capabilities: ["events:read:experimental"] },
      kind: "tension.created",
      experimentalEnabled: false,
    });
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        reason: "experimental_events_disabled",
      }),
    );
  });

  it("rejects an unknown event kind", () => {
    const result = gateEventSubscription({
      manifest: baseManifest,
      kind: "totally.fake",
      experimentalEnabled: true,
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, reason: "event_kind_not_declared" }),
    );
  });

  it("rejects a forbidden effect even when expectedEffects would allow it", () => {
    const result = gateEffect({
      manifest: {
        expectedEffects: ["write_internal_graph"],
        forbiddenEffects: ["write_internal_graph"],
      },
      effect: "write_internal_graph",
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, reason: "effect_forbidden" }),
    );
  });

  it("rejects an undeclared effect", () => {
    const result = gateEffect({
      manifest: baseManifest,
      effect: "invoke_llm",
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, reason: "effect_undeclared" }),
    );
  });

  it("denies in-process load when host switch is off and plugin is untrusted", () => {
    const result = gateInProcessLoad({
      allowInProcessPlugins: false,
      trusted: false,
    });
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        reason: "in_process_execution_disabled",
      }),
    );
  });

  it("allows in-process load when plugin is trusted even if switch is off", () => {
    const result = gateInProcessLoad({
      allowInProcessPlugins: false,
      trusted: true,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an invalid plugin id at the host boundary", () => {
    const result = gatePluginId("INVALID_ID!");
    expect(result).toEqual(
      expect.objectContaining({ ok: false, reason: "manifest_invalid" }),
    );
  });
});
