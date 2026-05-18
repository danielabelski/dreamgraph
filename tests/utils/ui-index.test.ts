/**
 * Tests for `loadIndexableUIElements` — the source_repo provenance gate
 * for promoting UI registry elements into the canonical graph index.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setDataDirOverride } from "../../src/utils/paths.js";
import { loadIndexableUIElements } from "../../src/utils/ui-index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "dg-ui-index-"));
  setDataDirOverride(tmpDir);
});

afterEach(() => {
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

async function writeRegistry(payload: unknown): Promise<void> {
  await writeFile(join(tmpDir, "ui_registry.json"), JSON.stringify(payload), "utf-8");
}

describe("loadIndexableUIElements", () => {
  it("returns [] when ui_registry.json is missing", async () => {
    expect(await loadIndexableUIElements()).toEqual([]);
  });

  it("returns [] when ui_registry.json is malformed JSON", async () => {
    await writeFile(join(tmpDir, "ui_registry.json"), "{not json", "utf-8");
    expect(await loadIndexableUIElements()).toEqual([]);
  });

  it("returns [] when elements is not an array", async () => {
    await writeRegistry({ metadata: {}, elements: "oops" });
    expect(await loadIndexableUIElements()).toEqual([]);
  });

  it("excludes elements without source_repo (provenance gate)", async () => {
    await writeRegistry({
      metadata: {},
      elements: [
        { id: "manual1", name: "Manual Element", purpose: "button" },
        { id: "scoped1", name: "Scoped Element", purpose: "button", source_repo: "openrct2" },
        { id: "blank_repo", name: "Blank Repo", purpose: "button", source_repo: "   " },
      ],
    });
    const result = await loadIndexableUIElements();
    expect(result).toEqual([
      { id: "scoped1", name: "Scoped Element", source_repo: "openrct2", used_by: [], children: [], flows: [] },
    ]);
  });

  it("excludes entries missing id or name", async () => {
    await writeRegistry({
      metadata: {},
      elements: [
        { name: "No id", source_repo: "r" },
        { id: "no_name", source_repo: "r" },
        { id: "good", name: "Good", source_repo: "r" },
      ],
    });
    const result = await loadIndexableUIElements();
    expect(result).toEqual([{ id: "good", name: "Good", source_repo: "r", used_by: [], children: [], flows: [] }]);
  });
});
