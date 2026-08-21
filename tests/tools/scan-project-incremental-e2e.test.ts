import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { config } from "../../src/config/config.js";
import { setDataDirOverride } from "../../src/utils/paths.js";
import { invalidateCache, setDataDirResolver } from "../../src/utils/cache.js";
import { buildScanState, type ScanState, type StructuralEvidenceLedger } from "../../src/tools/scan-state.js";
import { claimForEntity, reconcileAddedModifiedEntities } from "../../src/tools/incremental-reconciliation.js";
import { generateStructuralFeatures } from "../../src/tools/structural-generators.js";
import { runScanProject } from "../../src/tools/scan-project.js";
import type { ProjectScan } from "../../src/tools/scan-types.js";

const roots: string[] = [];
const originalRepos = { ...config.repos };
const cacheFiles = ["features.json", "workflows.json", "data_model.json", "datastores.json", "ui_registry.json", "auxiliary.json", "scan_state.json", "index.json"];
function clearFixtureCaches(): void {
  for (const file of cacheFiles) invalidateCache(file);
}

async function makeFixture(): Promise<{ repo: string; data: string }> {
  const repo = mkdtempSync(join(tmpdir(), "dg-run-scan-e2e-repo-"));
  const data = mkdtempSync(join(tmpdir(), "dg-run-scan-e2e-data-"));
  roots.push(repo, data);
  await mkdir(join(repo, "src"), { recursive: true });
  for (const key of Object.keys(config.repos)) delete config.repos[key];
  config.repos.fixture = repo;
  setDataDirOverride(data);
  setDataDirResolver(() => data);
  clearFixtureCaches();
  for (const file of ["features.json", "workflows.json", "data_model.json", "datastores.json", "ui_registry.json", "auxiliary.json"]) {
    await writeFile(join(data, file), "[]", "utf8");
  }
  return { repo, data };
}

async function publishBaseline(
  repo: string,
  data: string,
  entities: Record<string, unknown>[],
  ledger?: StructuralEvidenceLedger,
  targets: Array<"features" | "workflows" | "data_model" | "ui"> = ["features", "workflows"],
): Promise<ScanState> {
  const state = await buildScanState({
    repos: { fixture: repo }, depth: "deep", targets, operation: "full",
  });
  state.evidence_ledger = ledger;
  await writeFile(join(data, "features.json"), JSON.stringify(entities, null, 2), "utf8");
  await writeFile(join(data, "scan_state.json"), JSON.stringify(state, null, 2), "utf8");
  clearFixtureCaches();
  return state;
}

function contentExtractor(scan: ProjectScan): Record<string, unknown>[] {
  return scan.files.flatMap((file) => [...(file.content ?? "").matchAll(/claim:([a-z-]+)/g)].map((match) => ({
    id: match[1],
    name: match[1],
    source_repo: scan.repoName,
    source_files: [file.rel],
    status: "active",
    links: [],
  })));
}

afterEach(async () => {
  for (const key of Object.keys(config.repos)) delete config.repos[key];
  Object.assign(config.repos, originalRepos);
  setDataDirResolver(() => config.dataDir);
  clearFixtureCaches();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe("Slice 5 runScanProject authoritative orchestration", () => {
  it("commits one added file through the existing target registry and preserves unrequested state", async () => {
    const { repo, data } = await makeFixture();
    await writeFile(join(repo, "src", "stable.ts"), "export const stable = 1;\n", "utf8");
    const initialScan: ProjectScan = {
      repoName: "fixture", repoRoot: repo, technology: "TypeScript",
      files: [{ abs: join(repo, "src", "stable.ts"), rel: "src/stable.ts", name: "stable.ts", ext: ".ts", dirParts: ["src"], size: 25 }],
      uiFiles: [], manifestContent: {}, topLevelDirs: ["src"],
      auxiliaryFiles: { test_suite: [], configuration: [], automation_script: [], mcp_tool: [] },
    };
    const baselineEntities = generateStructuralFeatures(initialScan);
    const baselineReconciliation = reconcileAddedModifiedEntities({
      existing: [], revision: "baseline",
      incoming: baselineEntities.map((entity) => ({
        repo: "fixture", target: "features" as const, kind: "features",
        entity, file_hashes: { "src/stable.ts": "baseline" },
      })),
    });
    await publishBaseline(repo, data, baselineEntities, baselineReconciliation.ledger);
    const untouchedWorkflow = [{ id: "manual-flow", name: "Manual", governed_note: "keep" }];
    await writeFile(join(data, "workflows.json"), JSON.stringify(untouchedWorkflow), "utf8");
    await mkdir(join(repo, "src", "new-area"), { recursive: true });
    await writeFile(join(repo, "src", "new-area", "added.ts"), "export const added = true;\n", "utf8");

    const routed: string[] = [];
    const parsed: string[] = [];
    const result = await runScanProject({
      mode: "incremental", repos: ["fixture"], targets: ["features"],
      test_hooks: { onExtractorSelected: (target, scan) => {
        routed.push(target);
        parsed.push(...scan.files.map((file) => file.rel));
        expect(scan.files[0].content_hash).toMatch(/^sha256:/);
        expect(scan.files[0].content).toContain("added");
      } },
    });

    expect(result.delta_preview?.repositories[0]).toMatchObject({ added: ["src/new-area/added.ts"], modified: [] });
    expect(result.incremental_metrics).toMatchObject({ parser_invocations: 1, unchanged_files_parsed: 0 });
    expect(routed).toEqual(["features"]);
    expect(parsed).toEqual(["src/new-area/added.ts"]);
    const committed = JSON.parse(await readFile(join(data, "features.json"), "utf8"));
    expect(committed.map((entity: { id: string }) => entity.id)).toEqual(expect.arrayContaining(["fixture_src", "fixture_src_new_area"]));
    expect(JSON.parse(await readFile(join(data, "workflows.json"), "utf8"))).toEqual(untouchedWorkflow);
    const nextState = JSON.parse(await readFile(join(data, "scan_state.json"), "utf8")) as ScanState;
    expect(nextState.previous_revision).toBeTruthy();
    expect(nextState.committed_revision).not.toBe(nextState.previous_revision);
    const addedClaim = Object.values(nextState.evidence_ledger!.claims).find((claim) => claim.legacy_entity_id === "fixture_src_new_area");
    expect(addedClaim?.supports).toEqual([expect.objectContaining({ path: "src/new-area/added.ts", content_hash: nextState.repos.fixture.files["src/new-area/added.ts"].content_hash })]);
    expect(nextState.coverage_ledger?.revision).toBe(nextState.committed_revision);
    expect(Object.values(nextState.coverage_ledger?.nodes ?? {}).filter((node) => !node.semantic_state)).toEqual([]);
    expect(Object.values(nextState.coverage_ledger?.nodes ?? {}).filter((node) => node.eligible).length).toBeGreaterThan(0);
    expect(Object.values(nextState.coverage_ledger?.nodes ?? {}).filter((node) => !node.eligible))
      .toEqual(expect.arrayContaining([expect.objectContaining({ reason: "no_active_source_support" })]));
    const ledgerBeforeNoChange = nextState.coverage_ledger;
    const unchanged = await runScanProject({ mode: "incremental", repos: ["fixture"], targets: ["features"] });
    expect(unchanged.delta_preview?.metrics.files_modified ?? 0).toBe(0);
    expect(unchanged.delta_preview?.metrics.files_added ?? 0).toBe(0);
    const converged = JSON.parse(await readFile(join(data, "scan_state.json"), "utf8")) as ScanState;
    expect(converged.coverage_ledger).toEqual(ledgerBeforeNoChange);
  });

  it("replaces only modified-file support, preserves governed and unchanged knowledge, and converges with a fresh B extraction", async () => {
    const { repo, data } = await makeFixture();
    await writeFile(join(repo, "src", "changed.ts"), "// claim:old\n// claim:shared\n", "utf8");
    await writeFile(join(repo, "src", "stable.ts"), "// claim:shared\n", "utf8");
    const baseline = await buildScanState({ repos: { fixture: repo }, depth: "deep", targets: ["features", "workflows"], operation: "full" });
    const incoming = [
      { id: "old", name: "old", source_repo: "fixture", source_files: ["src/changed.ts"], status: "active", links: [] },
      { id: "shared", name: "shared", source_repo: "fixture", source_files: ["src/changed.ts", "src/stable.ts"], status: "active", links: [] },
    ];
    const ledger = incoming.reduce<StructuralEvidenceLedger | undefined>((prior, entity) => reconcileAddedModifiedEntities({
      existing: incoming, previous_ledger: prior, revision: baseline.committed_revision,
      incoming: [{ repo: "fixture", target: "features", kind: "features", entity, file_hashes: Object.fromEntries(Object.entries(baseline.repos.fixture.files).map(([p, e]) => [p, e.content_hash])) }],
    }).ledger, undefined)!;
    await publishBaseline(repo, data, incoming.map((entity) => entity.id === "old" ? { ...entity, governed_note: "retain" } : entity), ledger);
    const untouchedWorkflow = [{ id: "flow", name: "Flow", historical_note: "retain" }];
    await writeFile(join(data, "workflows.json"), JSON.stringify(untouchedWorkflow), "utf8");
    await writeFile(join(repo, "src", "changed.ts"), "// claim:new\n// claim:shared\n", "utf8");

    const parsed: string[] = [];
    await runScanProject({
      mode: "incremental", repos: ["fixture"], targets: ["features"],
      test_hooks: {
        extractorOverrides: { features: contentExtractor },
        onExtractorSelected: (_target, scan) => parsed.push(...scan.files.map((file) => file.rel)),
      },
    });

    expect(parsed).toEqual(["src/changed.ts"]);
    const entities = JSON.parse(await readFile(join(data, "features.json"), "utf8")) as Array<Record<string, unknown>>;
    expect(entities.find((entity) => entity.id === "old")).toMatchObject({ governed_note: "retain" });
    expect(entities.find((entity) => entity.id === "new")).toBeTruthy();
    expect(entities.find((entity) => entity.id === "shared")).toBeTruthy();
    expect(JSON.parse(await readFile(join(data, "workflows.json"), "utf8"))).toEqual(untouchedWorkflow);
    const state = JSON.parse(await readFile(join(data, "scan_state.json"), "utf8")) as ScanState;
    const claims = Object.values(state.evidence_ledger!.claims);
    expect(claims.find((claim) => claim.legacy_entity_id === "old")).toMatchObject({ lifecycle: "deprecated", supports: [] });
    expect(claims.find((claim) => claim.legacy_entity_id === "shared")?.supports.map((support) => support.path).sort()).toEqual(["src/changed.ts", "src/stable.ts"]);
    const freshB = contentExtractor({
      repoName: "fixture", repoRoot: repo, technology: "test",
      files: await Promise.all(["src/changed.ts", "src/stable.ts"].map(async (rel) => ({
        abs: join(repo, ...rel.split("/")), rel, name: rel.split("/").at(-1)!, ext: ".ts", dirParts: ["src"],
        size: 0, content: await readFile(join(repo, ...rel.split("/")), "utf8"),
      }))),
      uiFiles: [], manifestContent: {}, topLevelDirs: ["src"],
      auxiliaryFiles: { test_suite: [], configuration: [], automation_script: [], mcp_tool: [] },
    });
    const activeIncrementalIds = claims.filter((claim) => claim.lifecycle === "active").map((claim) => claim.legacy_entity_id).sort();
    expect(activeIncrementalIds).toEqual([...new Set(freshB.map((entity) => String(entity.id)))].sort());
  });

  it("withdraws deleted support without purging governed knowledge", async () => {
    const { repo, data } = await makeFixture();
    await writeFile(join(repo, "src", "deleted.ts"), "// claim:solo\n", "utf8");
    const base = await buildScanState({ repos: { fixture: repo }, depth: "deep", targets: ["features"], operation: "full" });
    const entity = { id: "solo", name: "solo", source_repo: "fixture", source_files: ["src/deleted.ts"], status: "active", governed_note: "retain", links: [] };
    const claim = claimForEntity({ repo: "fixture", target: "features", kind: "features", entity, file_hashes: { "src/deleted.ts": base.repos.fixture.files["src/deleted.ts"].content_hash } });
    await publishBaseline(repo, data, [entity], { schema: "dreamgraph.structural_evidence.v1", revision: base.committed_revision, claims: { [claim.claim_id]: claim } }, ["features"]);
    await rm(join(repo, "src", "deleted.ts"));

    const result = await runScanProject({ mode: "incremental", repos: ["fixture"], targets: ["features"] });

    expect(result.delta_preview?.repositories[0].deleted).toEqual(["src/deleted.ts"]);
    expect(result.incremental_metrics?.parser_invocations).toBe(0);
    const entities = JSON.parse(await readFile(join(data, "features.json"), "utf8"));
    expect(entities).toEqual([expect.objectContaining({
      id: "solo", status: "deprecated", source_files: [], governed_note: "retain",
      evidence_review: expect.stringContaining("retained"),
    })]);
    const state = JSON.parse(await readFile(join(data, "scan_state.json"), "utf8")) as ScanState;
    expect(Object.values(state.evidence_ledger!.claims)[0]).toMatchObject({ lifecycle: "deprecated", supports: [] });
  });

  it("rebinds an unambiguous same-content rename and keeps identity active", async () => {
    const { repo, data } = await makeFixture();
    await writeFile(join(repo, "src", "before.ts"), "// claim:continuity\n", "utf8");
    const base = await buildScanState({ repos: { fixture: repo }, depth: "deep", targets: ["features"], operation: "full" });
    const entity = { id: "continuity", name: "continuity", source_repo: "fixture", source_files: ["src/before.ts"], status: "active", governed_note: "retain", links: [] };
    const claim = claimForEntity({ repo: "fixture", target: "features", kind: "features", entity, file_hashes: { "src/before.ts": base.repos.fixture.files["src/before.ts"].content_hash } });
    await publishBaseline(repo, data, [entity], { schema: "dreamgraph.structural_evidence.v1", revision: base.committed_revision, claims: { [claim.claim_id]: claim } }, ["features"]);
    await writeFile(join(repo, "src", "after.ts"), await readFile(join(repo, "src", "before.ts")));
    await rm(join(repo, "src", "before.ts"));

    const result = await runScanProject({
      mode: "incremental", repos: ["fixture"], targets: ["features"],
      test_hooks: { extractorOverrides: { features: contentExtractor } },
    });

    expect(result.delta_preview?.repositories[0].renamed).toEqual([
      expect.objectContaining({ from: "src/before.ts", to: "src/after.ts" }),
    ]);
    const state = JSON.parse(await readFile(join(data, "scan_state.json"), "utf8")) as ScanState;
    expect(Object.values(state.evidence_ledger!.claims)[0]).toMatchObject({
      legacy_entity_id: "continuity", lifecycle: "active",
      supports: [expect.objectContaining({ path: "src/after.ts" })],
    });
    const entities = JSON.parse(await readFile(join(data, "features.json"), "utf8"));
    expect(entities).toEqual([expect.objectContaining({ id: "continuity", source_files: ["src/after.ts"], governed_note: "retain" })]);
  });

  it.each([
    ["stable", 0, 1, true],
    ["changes once", 1, 2, true],
    ["keeps changing", 3, 3, false],
  ] as const)("uses a stable captured snapshot when the file %s", async (_label, mutations, expectedParses, succeeds) => {
    const { repo, data } = await makeFixture();
    await writeFile(join(repo, "src", "changed.ts"), "// claim:old\n", "utf8");
    const base = await buildScanState({ repos: { fixture: repo }, depth: "deep", targets: ["features"], operation: "full" });
    const entity = { id: "old", name: "old", source_repo: "fixture", source_files: ["src/changed.ts"], status: "active", links: [] };
    const claim = claimForEntity({ repo: "fixture", target: "features", kind: "features", entity, file_hashes: { "src/changed.ts": base.repos.fixture.files["src/changed.ts"].content_hash } });
    await publishBaseline(repo, data, [entity], { schema: "dreamgraph.structural_evidence.v1", revision: base.committed_revision, claims: { [claim.claim_id]: claim } }, ["features"]);
    await writeFile(join(repo, "src", "changed.ts"), "// claim:new-0\n", "utf8");
    let parses = 0;
    const operation = runScanProject({
      mode: "incremental", repos: ["fixture"], targets: ["features"],
      test_hooks: {
        extractorOverrides: { features: (scan) => { parses++; return contentExtractor(scan); } },
        afterExtractionAttempt: async (attempt) => {
          if (attempt <= mutations) await writeFile(join(repo, "src", "changed.ts"), `// claim:new-${attempt}\n`, "utf8");
        },
      },
    });
    if (succeeds) await expect(operation).resolves.toMatchObject({ incremental_metrics: { parser_invocations: 1 } });
    else await expect(operation).rejects.toThrow("INCREMENTAL_SOURCE_UNSTABLE");
    expect(parses).toBe(expectedParses);
    const committedState = JSON.parse(await readFile(join(data, "scan_state.json"), "utf8")) as ScanState;
    if (succeeds) {
      const support = Object.values(committedState.evidence_ledger!.claims).find((candidate) => candidate.lifecycle === "active")!.supports[0];
      expect(support.content_hash).toBe(committedState.repos.fixture.files[support.path].content_hash);
    } else {
      expect(committedState.committed_revision).toBe(base.committed_revision);
      expect(JSON.parse(await readFile(join(data, "features.json"), "utf8"))).toEqual([entity]);
    }
  });
});
