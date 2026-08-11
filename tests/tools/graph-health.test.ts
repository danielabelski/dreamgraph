import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assessGraphHealth } from "../../src/tools/graph-health.js";
import { config } from "../../src/config/config.js";
import { getDataDir, setDataDirOverride } from "../../src/utils/paths.js";

let tempDir: string;
let previousDataDir: string;
let previousRepos: Record<string, string>;
let previousDatabaseUrl: string;

async function writeJson(name: string, value: unknown): Promise<void> {
  await writeFile(join(tempDir, name), JSON.stringify(value, null, 2), "utf-8");
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "dg-graph-health-"));
  previousDataDir = getDataDir();
  previousRepos = { ...config.repos };
  previousDatabaseUrl = config.database.connectionString;
  setDataDirOverride(tempDir);
  for (const key of Object.keys(config.repos)) delete config.repos[key];
  config.database.connectionString = "";
});

afterEach(async () => {
  for (const key of Object.keys(config.repos)) delete config.repos[key];
  Object.assign(config.repos, previousRepos);
  config.database.connectionString = previousDatabaseUrl;
  setDataDirOverride(previousDataDir);
  await rm(tempDir, { recursive: true, force: true });
});

describe("graph health assessment", () => {
  it("explains hollow parser knowledge and recommends enrichment before scanning", async () => {
    const now = new Date().toISOString();
    await writeJson("features.json", [
      {
        id: "generated-assembly",
        name: "generated-assembly",
        description: "Generated Assembly — 4 source file(s) in src/generated-assembly/",
        source_kind: "scanner",
        source_repo: "dreamgraph",
        links: [],
        enrichment: { enriched: false },
      },
      {
        id: "architect-runtime",
        name: "Architect Runtime",
        description: "Coordinates graph-grounded architectural work so implementation decisions remain traceable to intent, constraints, evidence, and follow-up verification across the active project.",
        intent: "Keep architectural reasoning and implementation synchronized with durable DreamGraph evidence.",
        category: "architecture",
        source_repo: "dreamgraph",
        links: [{ target: "generated-assembly", relationship: "interprets" }],
        enrichment: { enriched: true, enriched_at: now },
      },
    ]);
    await writeJson("workflows.json", []);
    await writeJson("data_model.json", []);
    await writeJson("capabilities.json", []);
    await writeJson("datastores.json", []);
    await writeJson("ui_registry.json", { metadata: {}, elements: [] });
    await writeJson("auxiliary_entities.json", { entries: [] });
    await writeJson("graph_maintenance.json", {
      schema_version: "1.0.0",
      last_scan_at: now,
      last_enrichment_at: now,
      last_datastore_scan_at: null,
      last_major_graph_change_at: null,
      last_scan_git_heads: {},
      datastore_connection_fingerprint: null,
      targeted_dream_schedule_ids: [],
    });

    const report = await assessGraphHealth();

    expect(report.metrics.parser_only_nodes).toBe(1);
    expect(report.metrics.hollow_descriptions).toBe(1);
    expect(report.metrics.machine_name_leakage).toBe(1);
    expect(report.observations.find((item) => item.signal === "hollow_descriptions")?.reasoning_impact).toContain("semantic matching");
    expect(report.primary_recommendation).toMatchObject({
      tool: "enrich_parser_nodes",
      requires_user_approval: true,
      arguments: { force: true, context_hops: 3 },
    });
  });

  it("uses project scan rather than bootstrap as the smallest repair for an empty graph", async () => {
    const report = await assessGraphHealth();

    expect(report.status).toBe("empty");
    expect(report.inventory.total).toBe(0);
    expect(report.primary_recommendation?.tool).toBe("scan_project");
    expect(report.recommendations.some((item) => item.tool === "bootstrap_instance")).toBe(false);
  });
});
