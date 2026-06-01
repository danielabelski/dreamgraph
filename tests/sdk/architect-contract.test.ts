import { describe, expect, it } from "vitest";
import { PluginManifestSchema } from "../../packages/sdk/src/manifest.js";

const base = {
  id: "examples.action-checklist",
  version: "1.0.0",
  displayName: "Action Checklist",
  engine: { dreamgraph: ">=10.0.0" },
  main: "index.js",
  intent: "Contribute a plan-bound checklist tab",
  capabilities: ["architect:register_tab", "architect:read_plan", "architect:write_plan_state", "architect:register_sidebar_summary"],
  expectedEffects: ["render_architect_tab", "read_architect_plan_projection", "write_architect_plan_state", "render_architect_sidebar_summary"],
  architectTabs: [{ id: "examples.action-checklist.checklist", renderer: "checklist", planConnectivity: "required" }],
};

describe("Architect SDK manifest contract", () => {
  it("accepts a declared Action Checklist tab", () => {
    expect(PluginManifestSchema.safeParse(base).success).toBe(true);
  });

  it("rejects unprefixed Architect tab ids", () => {
    expect(PluginManifestSchema.safeParse({ ...base, architectTabs: [{ ...base.architectTabs[0], id: "other.checklist" }] }).success).toBe(false);
  });

  it("rejects missing Architect registration capability", () => {
    expect(PluginManifestSchema.safeParse({ ...base, capabilities: base.capabilities.filter((capability) => capability !== "architect:register_tab") }).success).toBe(false);
  });

  it("rejects undeclared Architect render effect", () => {
    expect(PluginManifestSchema.safeParse({ ...base, expectedEffects: base.expectedEffects.filter((effect) => effect !== "render_architect_tab") }).success).toBe(false);
  });

  it("rejects unknown renderer and malformed connectivity", () => {
    expect(PluginManifestSchema.safeParse({ ...base, architectTabs: [{ ...base.architectTabs[0], renderer: "iframe" }] }).success).toBe(false);
    expect(PluginManifestSchema.safeParse({ ...base, architectTabs: [{ ...base.architectTabs[0], planConnectivity: "selected" }] }).success).toBe(false);
  });
});
