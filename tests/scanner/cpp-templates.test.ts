import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

import { cppExtractor } from "../../src/scanner/extractors/cpp.js";
import { linkProject } from "../../src/scanner/orchestrator.js";
import type { ExtractorOutput } from "../../src/scanner/types.js";

const here = dirname(fileURLToPath(import.meta.url));

async function runOn(relFixturePath: string): Promise<ExtractorOutput> {
  const absPath = join(here, "fixtures", ...relFixturePath.split("/"));
  const source = await readFile(absPath, "utf8");
  const relPath = relative(join(here, "fixtures"), absPath)
    .split(sep)
    .join("/");
  const name = relPath.split("/").pop() ?? relPath;
  const ext = name.includes(".") ? `.${name.split(".").pop()}` : "";
  const dirParts = relPath.split("/").slice(0, -1);
  return cppExtractor.extract({
    absPath,
    relPath,
    source,
    language: "cpp",
    name,
    ext,
    dirParts,
  });
}

describe("C++ extractor — CPP-4 templates and specialisations", () => {
  it("flags primary class template with type parameter", async () => {
    const out = await runOn("cpp/04-templates/templates.cpp");
    const box = out.entities.find(
      (e) => e.kind === "Class" && e.qualifiedName === "engine::Box",
    );
    expect(box).toBeDefined();
    expect(box!.attrs?.is_template).toBe(true);
    const params = box!.attrs?.template_parameters as Array<Record<string, unknown>>;
    expect(params).toHaveLength(1);
    expect(params[0]).toMatchObject({ kind: "type", name: "T" });
  });

  it("captures multi-parameter templates including non-type defaults", async () => {
    const out = await runOn("cpp/04-templates/templates.cpp");
    const pair = out.entities.find(
      (e) => e.kind === "Struct" && e.qualifiedName === "engine::Pair",
    );
    expect(pair).toBeDefined();
    expect(pair!.attrs?.is_template).toBe(true);
    const params = pair!.attrs?.template_parameters as Array<Record<string, unknown>>;
    expect(params).toHaveLength(3);
    expect(params[0]).toMatchObject({ kind: "type", name: "K" });
    expect(params[1]).toMatchObject({ kind: "type", name: "V" });
    expect(params[2]).toMatchObject({
      kind: "non-type",
      name: "N",
      paramType: "int",
      defaultText: "16",
    });
  });

  it("flags function templates", async () => {
    const out = await runOn("cpp/04-templates/templates.cpp");
    const fn = out.entities.find(
      (e) => e.kind === "Function" && e.qualifiedName === "engine::identity",
    );
    expect(fn).toBeDefined();
    expect(fn!.attrs?.is_template).toBe(true);
    const params = fn!.attrs?.template_parameters as Array<Record<string, unknown>>;
    expect(params).toHaveLength(1);
    expect(params[0]).toMatchObject({ kind: "type", name: "T" });
  });

  it("emits explicit specialisation as its own entity with SPECIALIZES edge", async () => {
    const out = await runOn("cpp/04-templates/templates.cpp");
    const primary = out.entities.find(
      (e) => e.kind === "Class" && e.qualifiedName === "engine::Box",
    );
    const spec = out.entities.find(
      (e) => e.kind === "Class" && e.qualifiedName === "engine::Box<int>",
    );
    expect(primary).toBeDefined();
    expect(spec).toBeDefined();
    expect(spec!.id).not.toBe(primary!.id);
    expect(spec!.attrs?.is_specialization).toBe(true);
    expect(spec!.attrs?.specialization_args).toEqual(["int"]);

    const specEdge = out.edges.find(
      (e) => e.from === spec!.id && e.relationship === "SPECIALIZES",
    );
    expect(specEdge).toBeDefined();
    expect(specEdge!.to).toBe("cpp:type:Box");
  });

  it("orchestrator resolves SPECIALIZES placeholder to the primary template", async () => {
    const out = await runOn("cpp/04-templates/templates.cpp");
    const linked = linkProject([out]);
    const primary = linked.entities.find(
      (e) => e.kind === "Class" && e.qualifiedName === "engine::Box",
    );
    const spec = linked.entities.find(
      (e) => e.kind === "Class" && e.qualifiedName === "engine::Box<int>",
    );
    const specEdge = linked.edges.find(
      (e) => e.from === spec!.id && e.relationship === "SPECIALIZES",
    );
    expect(specEdge).toBeDefined();
    expect(specEdge!.to).toBe(primary!.id);
    expect(specEdge!.meta?.resolved).toBe(true);
  });
});
