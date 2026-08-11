import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scheduleTargetedDreamStabilization } from "../../src/cognitive/targeted-dreams.js";
import { focusFactSnapshot, type FactEntity, type FactSnapshot } from "../../src/cognitive/strategies/_shared.js";
import { loadGraphMaintenanceState } from "../../src/cognitive/graph-maintenance-state.js";
import { executeEnrichSeedData } from "../../src/tools/enrich-seed-data.js";
import { getDataDir, setDataDirOverride } from "../../src/utils/paths.js";

let tempDir: string;
let previousDataDir: string;
let previousMajorThreshold: string | undefined;

function entity(id: string, links: string[]): FactEntity {
  return {
    id,
    type: "feature",
    name: id,
    description: `${id} has enough semantic context for a focused graph snapshot fixture.`,
    domain: "test",
    keywords: [],
    source_repo: "dreamgraph",
    source_files: [],
    tags: [],
    category: "test",
    links: links.map((target) => ({ target, type: "feature", relationship: "relates_to", description: "fixture", strength: "medium" })),
    steps: [],
    key_fields: [],
    relationships: [],
    descriptionTokens: new Set(),
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "dg-targeted-dream-"));
  previousDataDir = getDataDir();
  previousMajorThreshold = process.env.DREAMGRAPH_MAJOR_GRAPH_CHANGE_NODES;
  setDataDirOverride(tempDir);
});

afterEach(async () => {
  setDataDirOverride(previousDataDir);
  if (previousMajorThreshold === undefined) delete process.env.DREAMGRAPH_MAJOR_GRAPH_CHANGE_NODES;
  else process.env.DREAMGRAPH_MAJOR_GRAPH_CHANGE_NODES = previousMajorThreshold;
  await rm(tempDir, { recursive: true, force: true });
});

describe("targeted graph stabilization", () => {
  it("limits a dream snapshot to the requested multi-hop neighborhood", () => {
    const entities = new Map([
      ["a", entity("a", ["b"])],
      ["b", entity("b", ["c"])],
      ["c", entity("c", ["d"])],
      ["d", entity("d", [])],
    ]);
    const snapshot: FactSnapshot = {
      entities,
      edgeSet: new Set(["a|b", "b|c", "c|d"]),
      domains: new Set(["test"]),
      sourceFileIndex: new Map(),
      degree: new Map([["a", 1], ["b", 2], ["c", 2], ["d", 1]]),
    };

    const focused = focusFactSnapshot(snapshot, ["a"], 2);

    expect([...focused.entities.keys()]).toEqual(["a", "b", "c"]);
    expect([...focused.edgeSet]).toEqual(["a|b", "b|c"]);
    expect(focused.degree.get("c")).toBe(1);
  });

  it("persists bounded focused schedules and reuses the same stabilization request", async () => {
    const request = {
      entity_ids: ["feature-a", "workflow-b"],
      reason: "Major workflow implementation changed linked responsibilities",
      interval_ms: 60_000,
      max_runs: 2,
    };

    const first = await scheduleTargetedDreamStabilization(request);
    const second = await scheduleTargetedDreamStabilization(request);
    const state = await loadGraphMaintenanceState();

    expect(first.scheduled).toHaveLength(2);
    expect(first.scheduled[0].parameters).toMatchObject({
      focus_entities: ["feature-a", "workflow-b"],
      focus_hops: 2,
      focus_reason: request.reason,
      maintenance_origin: "major_graph_change",
    });
    expect(first.scheduled.every((schedule) => schedule.max_runs === 2)).toBe(true);
    expect(second.scheduled).toHaveLength(0);
    expect(second.reused).toHaveLength(2);
    expect(state.targeted_dream_schedule_ids).toEqual(expect.arrayContaining(first.scheduled.map((schedule) => schedule.id)));
  });

  it("automatically schedules stabilization after a major curated graph write", async () => {
    process.env.DREAMGRAPH_MAJOR_GRAPH_CHANGE_NODES = "2";

    const result = await executeEnrichSeedData({
      target: "features",
      entries: [
        { id: "feature-a", name: "Feature A", description: "Owns the first side of a major cross-feature implementation contract." },
        { id: "feature-b", name: "Feature B", description: "Owns the second side and consumes the resulting architectural behavior." },
      ],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.targeted_dream_schedules.created).toBe(2);
    expect(result.data.targeted_dream_schedules.schedule_ids).toHaveLength(2);
  });
});
