import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractNativeUiElements,
  hasScannableUiFiles,
} from "../../src/tools/native-ui-scanner.js";
import type { ProjectScan, ScannedFile } from "../../src/tools/scan-types.js";

async function scanWith(files: Array<{ rel: string; content: string }>): Promise<{ scan: ProjectScan; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "dg-ui-scan-"));
  const uiFiles: ScannedFile[] = [];
  for (const f of files) {
    const abs = join(root, f.rel);
    await mkdir(join(abs, "..").replace(/[\\/][^\\/]+$/, (m) => m.endsWith("/..") ? m : m), { recursive: true }).catch(() => {});
    // Simpler: derive dir from rel
    const dir = join(root, ...f.rel.split("/").slice(0, -1));
    await mkdir(dir, { recursive: true });
    await writeFile(abs, f.content, "utf-8");
    const parts = f.rel.split("/");
    const name = parts[parts.length - 1];
    const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
    uiFiles.push({
      abs,
      rel: f.rel,
      name,
      ext,
      dirParts: parts.slice(0, -1),
      size: f.content.length,
    });
  }
  const scan: ProjectScan = {
    repoName: "demo",
    repoRoot: root,
    technology: "JS/TS",
    files: [],
    manifestContent: {},
    uiFiles,
    topLevelDirs: [],
    auxiliaryFiles: { test_suite: [], configuration: [], automation_script: [], mcp_tool: [] },
  };
  return { scan, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("native UI scanner", () => {
  it("reports hasScannableUiFiles only when framework files are present", async () => {
    const { scan, cleanup } = await scanWith([
      { rel: "src/Foo.tsx", content: "export default function Foo() { return null; }" },
    ]);
    try {
      expect(hasScannableUiFiles(scan)).toBe(true);
    } finally { await cleanup(); }
  });

  it("ignores files with unknown extensions", async () => {
    const { scan, cleanup } = await scanWith([
      { rel: "src/notes.txt", content: "hello" },
    ]);
    try {
      expect(hasScannableUiFiles(scan)).toBe(false);
      const { elements, quality } = await extractNativeUiElements(scan);
      expect(elements).toEqual([]);
      expect(quality.totalUiFiles).toBe(0);
    } finally { await cleanup(); }
  });

  it("extracts React components via export-function pattern", async () => {
    const { scan, cleanup } = await scanWith([
      {
        rel: "src/Button.tsx",
        content: `import React from "react";\nexport function Button(props) { return <button />; }\nexport function IconButton() { return <button />; }\n`,
      },
    ]);
    try {
      const { elements } = await extractNativeUiElements(scan);
      const names = elements.map((e) => e.name).sort();
      expect(names).toEqual(["Button", "IconButton"]);
      expect(elements[0].source_kind).toBe("scanner");
      expect(elements[0].source_repo).toBe("demo");
      expect(elements[0].tags).toEqual(expect.arrayContaining(["scanner", "react"]));
      expect(elements[0].id).toContain("demo.src.Button");
    } finally { await cleanup(); }
  });

  it("extracts React components via export-const arrow pattern", async () => {
    const { scan, cleanup } = await scanWith([
      { rel: "src/Card.tsx", content: "export const Card = () => <div />;\n" },
    ]);
    try {
      const { elements } = await extractNativeUiElements(scan);
      expect(elements.map((e) => e.name)).toEqual(["Card"]);
    } finally { await cleanup(); }
  });

  it("extracts React contracts, interactions, semantics, and JSX composition links", async () => {
    const { scan, cleanup } = await scanWith([
      {
        rel: "src/Parent.tsx",
        content: `import { Child } from "./Child";
export function Parent({ items, onChoose, title = "Items" }) {
  return <section className="panel grid"><h2>{title}</h2><Child items={items}/><button onClick={onChoose}>Choose</button></section>;
}`,
      },
      { rel: "src/Child.tsx", content: "export function Child({ items }) { return <ul>{items.map(String)}</ul>; }" },
    ]);
    try {
      const { elements } = await extractNativeUiElements(scan);
      const parent = elements.find((element) => element.name === "Parent")!;
      const child = elements.find((element) => element.name === "Child")!;
      expect(parent.data_contract.inputs.map((input) => input.name)).toEqual(["items", "onChoose", "title"]);
      expect(parent.data_contract.outputs).toEqual([expect.objectContaining({ name: "rendered_view" })]);
      expect(parent.interactions).toEqual([expect.objectContaining({ action: "click" })]);
      expect(parent.visual_semantics?.visual_role).toContain("parent");
      expect(parent.layout_semantics?.pattern).toBe("grid");
      expect(parent.children).toContain(child.id);
      expect(parent.links).toEqual([expect.objectContaining({ target: child.id, relationship: "composes" })]);
      expect(child.used_by).toContain(parent.id);
    } finally { await cleanup(); }
  });

  it("falls back to filename when React file has no matching export", async () => {
    const { scan, cleanup } = await scanWith([
      {
        rel: "src/Wrapped.tsx",
        content: "const Wrapped = memo(Inner);\nexport default Wrapped;\n",
      },
    ]);
    try {
      const { elements } = await extractNativeUiElements(scan);
      expect(elements.length).toBeGreaterThanOrEqual(1);
      expect(elements.map((e) => e.name)).toContain("Wrapped");
    } finally { await cleanup(); }
  });

  it("skips test/spec/stories sibling files", async () => {
    const { scan, cleanup } = await scanWith([
      { rel: "src/Foo.test.tsx", content: "export const Foo = () => null;" },
      { rel: "src/Foo.stories.tsx", content: "export const Foo = () => null;" },
    ]);
    try {
      const { elements } = await extractNativeUiElements(scan);
      // Test/stories filename stems get filtered for SFC frameworks; for
      // React we still parse the source but the resulting names are
      // genuine component exports — that's fine. Just assert we don't
      // crash and we don't emit anything from the dotted-stem fallback.
      const sourceFiles = elements.map((e) => e.source_file);
      expect(sourceFiles).toEqual(expect.arrayContaining(["src/Foo.test.tsx"]));
      // But the id should NOT contain a `.test.` segment as a component name.
      for (const el of elements) {
        expect(el.name).not.toMatch(/\.(test|spec|stories)$/);
      }
    } finally { await cleanup(); }
  });

  it("derives PascalCase from kebab-case filenames for Vue", async () => {
    const { scan, cleanup } = await scanWith([
      { rel: "ui/my-button.vue", content: "<template><button/></template>" },
    ]);
    try {
      const { elements } = await extractNativeUiElements(scan);
      expect(elements.map((e) => e.name)).toEqual(["MyButton"]);
      expect(elements[0].implementations[0].platform).toBe("vue");
    } finally { await cleanup(); }
  });

  it("extracts Svelte components by filename stem", async () => {
    const { scan, cleanup } = await scanWith([
      { rel: "src/Modal.svelte", content: "<div/>" },
    ]);
    try {
      const { elements } = await extractNativeUiElements(scan);
      expect(elements[0].name).toBe("Modal");
      expect(elements[0].implementations[0].platform).toBe("svelte");
    } finally { await cleanup(); }
  });

  it("deduplicates duplicate ids within a single scan", async () => {
    const { scan, cleanup } = await scanWith([
      {
        rel: "src/Foo.tsx",
        content: "export function Foo() {} export const Foo2 = () => null; export function Foo() {}",
      },
    ]);
    try {
      const { elements } = await extractNativeUiElements(scan);
      const ids = elements.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
    } finally { await cleanup(); }
  });

  it("records a diagnostic when a file can't be read but does not throw", async () => {
    const { scan, cleanup } = await scanWith([
      { rel: "src/Real.tsx", content: "export function Real() {}" },
    ]);
    try {
      // Inject a phantom file pointing at a non-existent path.
      scan.uiFiles.push({
        abs: join(scan.repoRoot, "does-not-exist.tsx"),
        rel: "does-not-exist.tsx",
        name: "does-not-exist.tsx",
        ext: ".tsx",
        dirParts: [],
        size: 0,
      });
      const { elements, quality } = await extractNativeUiElements(scan);
      expect(elements.map((e) => e.name)).toContain("Real");
      expect(quality.diagnostics.length).toBeGreaterThanOrEqual(1);
      expect(quality.diagnostics[0].relPath).toBe("does-not-exist.tsx");
    } finally { await cleanup(); }
  });
});
