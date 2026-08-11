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
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "scoped1", name: "Scoped Element", purpose: "button",
      source_repo: "openrct2", used_by: [], children: [], flows: [],
    });
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
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "good", name: "Good", source_repo: "r", used_by: [], children: [], flows: [] });
  });

  it("preserves rich UI knowledge for Explorer node inspection", async () => {
    await writeRegistry({
      elements: [{
        id: "rich", name: "Rich Panel", purpose: "inspection", category: "composite",
        source_repo: "r", description: "A rich semantic description", intent: "Explain graph health",
        data_contract: { inputs: [{ name: "node", type: "Node", description: "Selected node", required: true }], outputs: [] },
        interactions: [{ action: "select", description: "Selects a node" }],
        implementations: [], used_by: ["feature.health"], children: ["ui.child"], tags: ["health"],
        visual_semantics: { visual_role: "inspector" },
        layout_semantics: { pattern: "inspector" },
        links: [{ target: "ui.child", type: "ui_element", relationship: "composes", description: "Renders child", strength: "strong" }],
      }],
    });

    const [result] = await loadIndexableUIElements();
    expect(result).toMatchObject({
      description: "A rich semantic description",
      intent: "Explain graph health",
      data_contract: { inputs: [expect.objectContaining({ name: "node" })] },
      interactions: [expect.objectContaining({ action: "select" })],
      visual_semantics: { visual_role: "inspector" },
      layout_semantics: { pattern: "inspector" },
      links: [expect.objectContaining({ target: "ui.child" })],
    });
  });
});
