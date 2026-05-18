/**
 * Slice 2 — `applyScannerUiElements` bulk-merge contract.
 *
 * Provenance discipline: scanner re-runs must
 *   1. insert new ids,
 *   2. refresh detection fields on existing scanner-origin entries
 *      WITHOUT erasing enrichment work,
 *   3. NEVER touch manual / sdk / user_guidance entries.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setDataDirOverride } from "../../src/utils/paths.js";
import { invalidateCache, setDataDirResolver } from "../../src/utils/cache.js";
import { applyScannerUiElements } from "../../src/tools/ui-registry.js";
import type { SemanticElement } from "../../src/types/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "dg-ui-merge-"));
  setDataDirOverride(tmpDir);
  setDataDirResolver(() => tmpDir);
  invalidateCache();
});

afterEach(() => {
  invalidateCache();
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

async function writeRegistry(elements: Partial<SemanticElement>[]): Promise<void> {
  await writeFile(
    join(tmpDir, "ui_registry.json"),
    JSON.stringify(
      {
        metadata: {
          total_elements: elements.length,
          total_categories: 0,
          last_updated: "2024-01-01",
          schema_version: "1.2.0",
        },
        elements,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

async function readRegistryElements(): Promise<SemanticElement[]> {
  const raw = await readFile(join(tmpDir, "ui_registry.json"), "utf-8");
  return JSON.parse(raw).elements as SemanticElement[];
}

function scannerElement(over: Partial<SemanticElement> = {}): SemanticElement {
  return {
    id: "demo.src.Foo.Foo",
    name: "Foo",
    purpose: "react component 'Foo' detected by scanner in src/Foo.tsx. Enrich for narrative description.",
    category: "composite",
    data_contract: { inputs: [], outputs: [] },
    interactions: [],
    implementations: [{ platform: "react", component: "Foo", source_file: "src/Foo.tsx" }],
    used_by: [],
    tags: ["scanner", "react"],
    source_kind: "scanner",
    source_repo: "demo",
    source_file: "src/Foo.tsx",
    ...over,
  } as SemanticElement;
}

describe("applyScannerUiElements", () => {
  it("inserts new scanner elements into an empty registry", async () => {
    await writeRegistry([]);
    const res = await applyScannerUiElements("demo", [scannerElement()]);
    expect(res).toEqual({
      inserted: 1,
      updated: 0,
      skipped_protected: 0,
      total_for_repo: 1,
    });
    const els = await readRegistryElements();
    expect(els).toHaveLength(1);
    expect(els[0].source_kind).toBe("scanner");
  });

  it("refreshes a scanner-origin element and preserves enrichment fields", async () => {
    const existing = scannerElement({
      name: "OldName",
      purpose: "outdated stub",
      tags: ["scanner", "react", "user-tag"],
      intent: "Curated intent prose",
      description_raw: "raw human notes",
      enrichment: { enriched: true, enricher: "enrich_parser_nodes/1.1" },
      links: [{ target: "feature_x", type: "implements" } as never],
    });
    await writeRegistry([existing]);

    const refreshed = scannerElement({
      name: "Foo",
      purpose: "react component 'Foo' detected by scanner in src/Foo.tsx. Enrich for narrative description.",
      tags: ["scanner", "react"],
    });
    const res = await applyScannerUiElements("demo", [refreshed]);
    expect(res.updated).toBe(1);
    expect(res.inserted).toBe(0);
    expect(res.skipped_protected).toBe(0);

    const [el] = await readRegistryElements();
    // Detection-time fields refreshed.
    expect(el.name).toBe("Foo");
    expect(el.purpose).toContain("detected by scanner");
    // Tags merged additively.
    expect(el.tags).toEqual(expect.arrayContaining(["scanner", "react", "user-tag"]));
    // Enrichment work preserved.
    expect((el as any).intent).toBe("Curated intent prose");
    expect((el as any).description_raw).toBe("raw human notes");
    expect((el as any).enrichment).toMatchObject({ enriched: true });
    expect((el as any).links).toHaveLength(1);
  });

  it("skips manual-origin entries and counts them as skipped_protected", async () => {
    const manual = scannerElement({ source_kind: "manual", purpose: "hand-curated" });
    await writeRegistry([manual]);
    const res = await applyScannerUiElements("demo", [scannerElement()]);
    expect(res).toMatchObject({ inserted: 0, updated: 0, skipped_protected: 1 });

    const [el] = await readRegistryElements();
    expect(el.source_kind).toBe("manual");
    expect(el.purpose).toBe("hand-curated");
  });

  it("skips sdk-origin (plugin) entries", async () => {
    const sdk = scannerElement({ source_kind: "sdk" });
    await writeRegistry([sdk]);
    const res = await applyScannerUiElements("demo", [scannerElement()]);
    expect(res.skipped_protected).toBe(1);
    expect(res.updated).toBe(0);
  });

  it("treats legacy entries with absent source_kind as scanner-owned and refreshes them", async () => {
    const legacy = scannerElement({ source_kind: undefined as never, name: "Legacy" });
    await writeRegistry([legacy]);
    const res = await applyScannerUiElements("demo", [scannerElement()]);
    expect(res.updated).toBe(1);
    const [el] = await readRegistryElements();
    expect(el.source_kind).toBe("scanner");
    expect(el.name).toBe("Foo");
  });

  it("reports total_for_repo scoped to repoName", async () => {
    await writeRegistry([
      scannerElement({ id: "demo.A", source_repo: "demo" }),
      scannerElement({ id: "other.B", source_repo: "other" }),
    ]);
    const res = await applyScannerUiElements("demo", [
      scannerElement({ id: "demo.A" }),
      scannerElement({ id: "demo.C" }),
    ]);
    expect(res.total_for_repo).toBe(2); // demo.A + demo.C; other.B excluded
  });

  it("returns counters even when called with an empty element list", async () => {
    await writeRegistry([scannerElement()]);
    const res = await applyScannerUiElements("demo", []);
    expect(res).toEqual({
      inserted: 0,
      updated: 0,
      skipped_protected: 0,
      total_for_repo: 1,
    });
  });
});
