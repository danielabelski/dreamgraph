import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { gatherDataStats } from "../src/cli/commands/status.js";

const tempDirs: string[] = [];

async function fixtureDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dg-status-"));
  tempDirs.push(dir);
  return dir;
}

async function writeJson(dir: string, file: string, value: unknown): Promise<void> {
  await writeFile(join(dir, file), JSON.stringify(value), "utf-8");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("dg status data stats", () => {
  it("reports the deduplicated Explorer-visible graph node count", async () => {
    const dir = await fixtureDir();
    await writeJson(dir, "features.json", [{ id: "feature-1" }, { id: "feature-2" }]);
    await writeJson(dir, "workflows.json", { workflows: [{ id: "workflow-1" }, { id: "feature-1" }] });
    await writeJson(dir, "data_model.json", [{ id: "model-1", storage: "unknown" }]);
    await writeJson(dir, "capabilities.json", [{ id: "capability-1" }]);
    await writeJson(dir, "datastores.json", [{ id: "store-1" }, { id: "unknown" }, { id: "stub", _schema: true }]);
    await writeJson(dir, "dream_graph.json", {
      nodes: [{ id: "model-1" }, { id: "dream-1" }],
      edges: [{ from: "feature-1", to: "feature-2" }, { from: "dream-1", to: "model-1" }],
    });
    await writeJson(dir, "tension_log.json", { signals: [{ id: "tension-1" }] });
    await writeJson(dir, "ui_registry.json", {
      elements: [
        { id: "ui-1", name: "Panel", source_repo: "dreamgraph" },
        { id: "ui-unscoped", name: "Draft" },
      ],
    });

    const stats = await gatherDataStats(dir);

    expect(stats.graphNodes).toBe(10);
    expect(stats.graphEdges).toBe(2);
    expect(stats.tensions).toBe(1);
    expect(stats.uiElements).toBe(2);
  });
});
