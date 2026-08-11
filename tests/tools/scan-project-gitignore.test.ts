import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createRootGitignoreFilter } from "../../src/tools/scan-project.js";

let root = "";

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

describe("scan_project root .gitignore", () => {
  it("excludes ignored files and directories while honoring negation", async () => {
    root = mkdtempSync(join(tmpdir(), "dg-gitignore-"));
    await writeFile(join(root, ".gitignore"), "dist/\n*.log\n!important.log\n", "utf-8");
    const ignored = await createRootGitignoreFilter(root);

    expect(ignored("dist", true)).toBe(true);
    expect(ignored("dist/generated.js")).toBe(true);
    expect(ignored("debug.log")).toBe(true);
    expect(ignored("important.log")).toBe(false);
    expect(ignored("src/index.ts")).toBe(false);
  });
});
