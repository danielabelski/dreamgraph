import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const root = await mkdtemp(join(tmpdir(), "dreamgraph-architect-state-"));
vi.mock("../../src/utils/paths.js", () => ({
  dataPath: (name: string) => join(root, name),
  getDataDir: () => root,
}));
vi.mock("../../src/architect/plan-registry.js", () => ({ listPlanFiles: async () => ["living-dreamgraph.md", "other.md"] }));

const { readArchitectPluginPlanState, writeArchitectPluginPlanState } = await import("../../src/plugins/architect-plan-state.js");

beforeAll(() => undefined);
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe("Architect plugin plan state", () => {
  it("isolates keys and rejects stale revisions", async () => {
    const scope = { pluginId: "examples.action-checklist", planId: "living-dreamgraph", tabTypeId: "examples.action-checklist.checklist", key: "checklist" };
    expect(await readArchitectPluginPlanState(scope)).toBeNull();
    const first = await writeArchitectPluginPlanState({ ...scope, value: { items: ["a"] } });
    await expect(writeArchitectPluginPlanState({ ...scope, value: { items: ["b"] }, revision: "stale" })).rejects.toMatchObject({ code: "architect_revision_stale" });
    const second = await writeArchitectPluginPlanState({ ...scope, value: { items: ["b"] }, revision: first.revision });
    expect(second.value).toEqual({ items: ["b"] });
    expect(await readArchitectPluginPlanState({ ...scope, pluginId: "other.plugin" })).toBeNull();
  });

  it("requires an explicit existing plan", async () => {
    await expect(readArchitectPluginPlanState({ pluginId: "p", planId: null, tabTypeId: "p.tab", key: "k" })).rejects.toMatchObject({ code: "architect_plan_required" });
    await expect(readArchitectPluginPlanState({ pluginId: "p", planId: "missing", tabTypeId: "p.tab", key: "k" })).rejects.toMatchObject({ code: "architect_plan_not_found" });
  });
});
