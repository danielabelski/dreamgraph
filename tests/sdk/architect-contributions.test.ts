import { afterEach, describe, expect, it } from "vitest";
import type { PluginManifest } from "../../packages/sdk/src/manifest.js";
import { _resetArchitectContributionsForTest, dispatchArchitectTabAction, listArchitectTabs, loadArchitectTabSnapshot, registerArchitectTab } from "../../src/plugins/architect-contributions.js";

const manifest = {
  id: "examples.action-checklist",
  version: "1.0.0",
  displayName: "Action Checklist",
  engine: { dreamgraph: ">=10.0.0" },
  main: "index.js",
  intent: "test",
  capabilities: ["architect:register_tab", "architect:read_plan", "architect:write_plan_state", "architect:register_sidebar_summary"],
  expectedEffects: ["render_architect_tab", "read_architect_plan_projection", "write_architect_plan_state", "render_architect_sidebar_summary"],
  forbiddenEffects: [],
  architectTabs: [{ id: "examples.action-checklist.checklist", renderer: "checklist", planConnectivity: "required" }],
  tools: [], resources: [], ui: [], policies: [], archetypeProviders: [], markdownFences: [], policy: { phasePermissions: [], writableFiles: [] },
} satisfies PluginManifest;

const definition = {
  id: "examples.action-checklist.checklist",
  title: "Action Checklist",
  renderer: "checklist" as const,
  planConnectivity: "required" as const,
  stateSchema: { type: "object" },
  actions: [{ id: "toggle", inputSchema: { type: "object", required: ["type", "itemId"], properties: { type: { type: "string" }, itemId: { type: "string" } } } }],
  sidebarSummary: { kind: "checklist-progress" as const },
  badges: [{ id: "remaining", kind: "count" as const }],
  loadState: ({ planId }: { planId: string | null }) => ({ planId, items: [] }),
  handleAction: (action: unknown) => ({ action }),
};

afterEach(() => _resetArchitectContributionsForTest());

describe("Architect contribution registry", () => {
  it("registers, projects, snapshots, dispatches, and unloads a checklist tab", async () => {
    const unregister = registerArchitectTab(manifest, definition);
    expect(listArchitectTabs()).toEqual([expect.objectContaining({ id: definition.id, renderer: "checklist" })]);
    await expect(loadArchitectTabSnapshot(definition.id, "living-dreamgraph")).resolves.toEqual(expect.objectContaining({ planId: "living-dreamgraph" }));
    await expect(dispatchArchitectTabAction(definition.id, "living-dreamgraph", { type: "toggle", itemId: "slice-d" }, null)).resolves.toEqual(expect.objectContaining({ planId: "living-dreamgraph" }));
    unregister();
    expect(listArchitectTabs()).toEqual([]);
  });

  it("rejects missing explicit plan and malformed action", async () => {
    registerArchitectTab(manifest, definition);
    await expect(loadArchitectTabSnapshot(definition.id, null)).rejects.toMatchObject({ code: "architect_plan_required" });
    await expect(dispatchArchitectTabAction(definition.id, "living-dreamgraph", { type: "toggle" }, null)).rejects.toMatchObject({ code: "architect_action_schema_invalid" });
  });
});
