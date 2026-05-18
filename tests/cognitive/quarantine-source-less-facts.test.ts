/**
 * Integration test — `quarantineSourceLessFacts` end-to-end.
 *
 * Seeds canonical seed files with a mix of grounded/ungrounded entities plus
 * dream nodes/edges and validated edges that touch the ungrounded ones, then
 * asserts the post-quarantine state and the on-disk quarantine report.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDataDirOverride } from "../../src/utils/paths.js";
import { invalidateCache, setDataDirResolver } from "../../src/utils/cache.js";
import { engine } from "../../src/cognitive/engine.js";

let tempDir: string;

async function seedFile(name: string, data: unknown): Promise<void> {
  await writeFile(join(tempDir, name), JSON.stringify(data, null, 2), "utf-8");
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "dg-quarantine-"));
  setDataDirOverride(tempDir);
  setDataDirResolver(() => tempDir);
  invalidateCache();
});

afterEach(async () => {
  invalidateCache();
  await rm(tempDir, { recursive: true, force: true });
});

describe("quarantineSourceLessFacts", () => {
  it("keeps grounded canonical entities and quarantines source-less ones", async () => {
    await seedFile("features.json", [
      {
        id: "feat_grounded",
        name: "Grounded Feature",
        description: "real",
        source_repo: "proj",
        source_files: ["src/grounded.ts"],
        provenance_kind: "source_backed",
        domain: "core",
        keywords: ["g"],
        links: [],
      },
      {
        id: "feat_orphan",
        name: "Phantom Feature",
        description: "no repo, no files",
        domain: "core",
        keywords: ["x"],
        links: [],
      },
    ]);
    await seedFile("workflows.json", [
      {
        id: "wf_hub_grounded",
        name: "Grounded Hub",
        description: "hub backed by grounded supports",
        source_repo: "proj",
        provenance_kind: "derived_hub",
        derived_from_node_ids: ["feat_grounded"],
        domain: "core",
        keywords: [],
        steps: [],
        links: [],
      },
      {
        id: "wf_hub_ungrounded",
        name: "Ungrounded Hub",
        description: "hub whose support is itself phantom",
        source_repo: "proj",
        provenance_kind: "derived_hub",
        derived_from_node_ids: ["feat_orphan"],
        domain: "core",
        keywords: [],
        steps: [],
        links: [],
      },
    ]);
    await seedFile("data_model.json", [
      {
        id: "dm_human",
        name: "Human Asserted Model",
        description: "asserted, no files",
        source_repo: "proj",
        human_asserted: true,
        provenance_kind: "human_asserted",
        domain: "core",
        keywords: [],
        links: [],
      },
    ]);

    const result = await engine.quarantineSourceLessFacts();

    expect(result.quarantined_nodes).toBe(2); // feat_orphan + wf_hub_ungrounded
    expect(result.affected_node_ids).toContain("feat_orphan");
    expect(result.affected_node_ids).toContain("wf_hub_ungrounded");
    expect(result.affected_node_ids).not.toContain("feat_grounded");
    expect(result.affected_node_ids).not.toContain("wf_hub_grounded");
    expect(result.affected_node_ids).not.toContain("dm_human");

    const features = JSON.parse(await readFile(join(tempDir, "features.json"), "utf-8"));
    expect(features.map((f: { id: string }) => f.id)).toEqual(["feat_grounded"]);

    const workflows = JSON.parse(await readFile(join(tempDir, "workflows.json"), "utf-8"));
    expect(workflows.map((w: { id: string }) => w.id)).toEqual(["wf_hub_grounded"]);

    const dataModel = JSON.parse(await readFile(join(tempDir, "data_model.json"), "utf-8"));
    expect(dataModel.map((d: { id: string }) => d.id)).toEqual(["dm_human"]);

    expect(existsSync(result.quarantine_file)).toBe(true);
    const report = JSON.parse(await readFile(result.quarantine_file, "utf-8"));
    expect(report.canonical_nodes).toHaveLength(2);
    expect(report.invariant).toMatch(/grounded/i);
  });

  it("cascades quarantine to validated edges and tensions that reference ungrounded nodes", async () => {
    await seedFile("features.json", [
      {
        id: "feat_keep",
        name: "Keep",
        description: "k",
        source_repo: "proj",
        source_files: ["src/keep.ts"],
        provenance_kind: "source_backed",
        domain: "core",
        keywords: [],
        links: [],
      },
      {
        id: "feat_drop",
        name: "Drop",
        description: "no repo",
        domain: "core",
        keywords: [],
        links: [],
      },
    ]);
    await seedFile("validated_edges.json", {
      edges: [
        { id: "ve_keep", from: "feat_keep", to: "feat_keep", type: "self", confidence: 1, validated_at: "2025-01-01T00:00:00Z" },
        { id: "ve_drop", from: "feat_keep", to: "feat_drop", type: "uses", confidence: 1, validated_at: "2025-01-01T00:00:00Z" },
      ],
      metadata: { total_validated: 2, last_validation_run: "2025-01-01T00:00:00Z" },
    });
    await seedFile("tension_log.json", {
      signals: [
        {
          id: "tens_drop",
          type: "missing_link",
          domain: "core",
          entities: ["feat_drop"],
          description: "phantom referenced here",
          urgency: 0.5,
          first_seen: "2025-01-01T00:00:00Z",
          last_seen: "2025-01-01T00:00:00Z",
          frequency: 1,
        },
        {
          id: "tens_keep",
          type: "missing_link",
          domain: "core",
          entities: ["feat_keep"],
          description: "grounded only",
          urgency: 0.5,
          first_seen: "2025-01-01T00:00:00Z",
          last_seen: "2025-01-01T00:00:00Z",
          frequency: 1,
        },
      ],
      resolved_tensions: [],
    });

    const result = await engine.quarantineSourceLessFacts();

    expect(result.quarantined_nodes).toBe(1);
    expect(result.quarantined_validated_edges).toBe(1);
    expect(result.quarantined_active_tensions).toBe(1);

    const validated = JSON.parse(await readFile(join(tempDir, "validated_edges.json"), "utf-8"));
    expect(validated.edges.map((e: { id: string }) => e.id)).toEqual(["ve_keep"]);
    expect(validated.metadata.total_validated).toBe(1);

    const tensions = JSON.parse(await readFile(join(tempDir, "tension_log.json"), "utf-8"));
    expect(tensions.signals.map((s: { id: string }) => s.id)).toEqual(["tens_keep"]);
  });

  it("is a no-op when every canonical entity is grounded", async () => {
    await seedFile("features.json", [
      {
        id: "feat_only",
        name: "Only",
        description: "only",
        source_repo: "proj",
        source_files: ["src/only.ts"],
        provenance_kind: "source_backed",
        domain: "core",
        keywords: [],
        links: [],
      },
    ]);

    const result = await engine.quarantineSourceLessFacts();

    expect(result.quarantined_nodes).toBe(0);
    expect(result.quarantined_validated_edges).toBe(0);
    expect(result.quarantined_active_tensions).toBe(0);
    expect(result.affected_node_ids).toEqual([]);

    // The quarantine report is still written for auditability.
    const files = await readdir(tempDir);
    expect(files.some((f) => f.startsWith("source_less_fact_quarantine_"))).toBe(true);
  });
});
