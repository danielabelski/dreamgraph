import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildScanState,
  previewIncrementalScan,
  SCAN_STATE_SCHEMA,
} from "../../src/tools/scan-state.js";

const roots: string[] = [];

async function fixture(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "dg-scan-state-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "stable.ts"), "export const stable = 1;\n", "utf-8");
  await writeFile(join(root, "src", "change.ts"), "export const value = 1;\n", "utf-8");
  await writeFile(join(root, ".gitignore"), "ignored/\n", "utf-8");
  await mkdir(join(root, "ignored"), { recursive: true });
  await writeFile(join(root, "ignored", "hidden.ts"), "ignored", "utf-8");
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

describe("scan-state v1 read-only delta oracle", () => {
  it("classifies an unchanged repository without parser invocations or graph writes", async () => {
    const root = await fixture();
    const baseline = await buildScanState({
      repos: { fixture: root },
      depth: "deep",
      targets: ["features", "workflows", "data_model", "ui"],
      operation: "full",
    });
    const preview = await previewIncrementalScan({
      repos: { fixture: root },
      depth: "deep",
      targets: ["features"],
      baseline,
    });

    expect(baseline.schema).toBe(SCAN_STATE_SCHEMA);
    expect(preview.baseline_status).toBe("compatible");
    expect(preview.full_scan_required).toBe(false);
    expect(preview.metrics.files_added).toBe(0);
    expect(preview.metrics.files_modified).toBe(0);
    expect(preview.metrics.files_deleted).toBe(0);
    expect(preview.metrics.files_renamed).toBe(0);
    expect(preview.metrics.parser_invocations).toBe(0);
    expect(preview.metrics.graph_writes).toBe(0);
    expect(preview.repositories[0].unchanged).toContain("src/stable.ts");
    expect(preview.repositories[0].unchanged).not.toContain("ignored/hidden.ts");
  });

  it("detects material changes and only reports an unambiguous content-preserving rename", async () => {
    const root = await fixture();
    const baseline = await buildScanState({
      repos: { fixture: root },
      depth: "deep",
      targets: ["features"],
      operation: "full",
    });

    await writeFile(join(root, "src", "change.ts"), "export const value = 2;\n", "utf-8");
    await writeFile(join(root, "src", "added.ts"), "export const added = true;\n", "utf-8");
    await rename(join(root, "src", "stable.ts"), join(root, "src", "moved.ts"));

    const preview = await previewIncrementalScan({
      repos: { fixture: root },
      depth: "deep",
      targets: ["features"],
      baseline,
    });

    expect(preview.repositories[0].modified).toEqual(["src/change.ts"]);
    expect(preview.repositories[0].added).toEqual(["src/added.ts"]);
    expect(preview.repositories[0].deleted).toEqual([]);
    expect(preview.repositories[0].renamed).toEqual([
      expect.objectContaining({ from: "src/stable.ts", to: "src/moved.ts" }),
    ]);
  });

  it("keeps ambiguous duplicate-content moves as explicit additions and deletions", async () => {
    const root = await fixture();
    await writeFile(join(root, "src", "duplicate.ts"), "export const stable = 1;\n", "utf-8");
    const baseline = await buildScanState({
      repos: { fixture: root }, depth: "deep", targets: ["features"], operation: "full",
    });

    await rm(join(root, "src", "stable.ts"));
    await rm(join(root, "src", "duplicate.ts"));
    await writeFile(join(root, "src", "possible-move.ts"), "export const stable = 1;\n", "utf-8");

    const preview = await previewIncrementalScan({
      repos: { fixture: root }, depth: "deep", targets: ["features"], baseline,
    });

    expect(preview.repositories[0].renamed).toEqual([]);
    expect(preview.repositories[0].added).toEqual(["src/possible-move.ts"]);
    expect(preview.repositories[0].deleted).toEqual(["src/duplicate.ts", "src/stable.ts"]);
  });

  it("classifies five material changes in a 300-file repository without parsing unchanged files", async () => {
    const root = mkdtempSync(join(tmpdir(), "dg-scan-benchmark-"));
    roots.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    await Promise.all(Array.from({ length: 300 }, (_, index) =>
      writeFile(join(root, "src", `file-${index}.ts`), `export const value${index} = ${index};\n`, "utf-8"),
    ));
    const baseline = await buildScanState({
      repos: { fixture: root }, depth: "deep", targets: ["features"], operation: "full",
    });
    await Promise.all(Array.from({ length: 5 }, (_, index) =>
      writeFile(join(root, "src", `file-${index}.ts`), `export const value${index} = ${index + 1};\n`, "utf-8"),
    ));
    const preview = await previewIncrementalScan({
      repos: { fixture: root }, depth: "deep", targets: ["features"], baseline,
    });
    expect(preview.metrics).toMatchObject({
      files_modified: 5, files_unchanged: 295, parser_invocations: 0, graph_writes: 0,
    });
    expect(preview.repositories[0].modified).toHaveLength(5);
  });

  it("reports incompatible depth without parsing or mutation", async () => {
    const root = await fixture();
    const baseline = await buildScanState({
      repos: { fixture: root },
      depth: "deep",
      targets: ["features"],
      operation: "full",
    });
    const preview = await previewIncrementalScan({
      repos: { fixture: root },
      depth: "shallow",
      targets: ["features"],
      baseline,
    });

    expect(preview.baseline_status).toBe("incompatible");
    expect(preview.full_scan_required).toBe(true);
    expect(preview.metrics.parser_invocations).toBe(0);
    expect(preview.metrics.graph_writes).toBe(0);
  });
});
