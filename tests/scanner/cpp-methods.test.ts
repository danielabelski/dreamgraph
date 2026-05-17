import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

import { cppExtractor } from "../../src/scanner/extractors/cpp.js";
import { linkProject } from "../../src/scanner/orchestrator.js";
import type { ExtractedEntity, ExtractorOutput } from "../../src/scanner/types.js";

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

function findAll<T extends ExtractedEntity>(
  out: ExtractorOutput,
  pred: (e: ExtractedEntity) => boolean,
): T[] {
  return out.entities.filter(pred) as T[];
}

describe("C++ extractor — CPP-2 methods, ctors, dtors, out-of-line defs", () => {
  it("emits in-class method declarations as Method entities", async () => {
    const out = await runOn("cpp/02-methods/methods.cpp");
    const methods = findAll(out, (e) => e.kind === "Method");
    const qns = methods
      .filter((m) => m.attrs?.is_definition === false)
      .map((m) => m.qualifiedName)
      .sort();
    expect(qns).toEqual(
      expect.arrayContaining([
        "engine::Shape::area",
        "engine::Circle::area",
        "engine::Circle::scale",
      ]),
    );
  });

  it("emits inline in-class method definition with is_definition=true", async () => {
    const out = await runOn("cpp/02-methods/methods.cpp");
    const inlineId = findAll(
      out,
      (e) =>
        e.kind === "Method" &&
        e.qualifiedName === "engine::Shape::id" &&
        e.attrs?.is_definition === true,
    );
    expect(inlineId.length).toBe(1);
  });

  it("emits constructors as Constructor entities (with overload preserved)", async () => {
    const out = await runOn("cpp/02-methods/methods.cpp");
    const ctors = findAll(
      out,
      (e) =>
        e.kind === "Constructor" &&
        e.qualifiedName === "engine::Shape::Shape",
    );
    // 2 in-class overload declarations + 2 out-of-line definitions
    expect(ctors.length).toBe(4);
    const defs = ctors.filter((c) => c.attrs?.is_definition === true);
    const decls = ctors.filter((c) => c.attrs?.is_definition === false);
    expect(defs.length).toBe(2);
    expect(decls.length).toBe(2);
  });

  it("emits destructors as Destructor entities", async () => {
    const out = await runOn("cpp/02-methods/methods.cpp");
    const dtors = findAll(out, (e) => e.kind === "Destructor");
    const qns = dtors.map((d) => d.qualifiedName).sort();
    // Each class has 1 declaration + 1 out-of-line definition.
    expect(qns).toEqual([
      "engine::Circle::~Circle",
      "engine::Circle::~Circle",
      "engine::Shape::~Shape",
      "engine::Shape::~Shape",
    ]);
  });

  it("captures fully-qualified out-of-line definitions outside any namespace", async () => {
    const out = await runOn("cpp/02-methods/methods.cpp");
    // `engine::Circle::area` lives at line 51 in the fixture, outside
    // any namespace block.
    const areaDefs = findAll(
      out,
      (e) =>
        e.kind === "Method" &&
        e.qualifiedName === "engine::Circle::area" &&
        e.attrs?.is_definition === true,
    );
    expect(areaDefs.length).toBe(1);
    expect(areaDefs[0]!.line).toBe(51);
  });

  it("uses line-disambiguated entity ids so overloads don't collide", async () => {
    const out = await runOn("cpp/02-methods/methods.cpp");
    const ctors = findAll(
      out,
      (e) =>
        e.kind === "Constructor" &&
        e.qualifiedName === "engine::Shape::Shape",
    );
    const ids = new Set(ctors.map((c) => c.id));
    expect(ids.size).toBe(ctors.length);
    // Each id ends with `@<line>`
    for (const id of ids) {
      expect(id).toMatch(/@\d+$/);
    }
  });

  it("does not double-emit method declarations as Fields", async () => {
    const out = await runOn("cpp/02-methods/methods.cpp");
    const fields = findAll(out, (e) => e.kind === "Field");
    const names = fields.map((f) => f.name).sort();
    // Only true data members: `id_` on Shape, `radius_` on Circle.
    expect(names).toEqual(["id_", "radius_"]);
  });

  it("binds non-overloaded member declarations to their out-of-line definitions", async () => {
    const out = await runOn("cpp/02-methods/methods.cpp");
    const project = linkProject([out]);
    const binds = project.edges.filter(
      (e) => e.relationship === "BINDS_DECLARATION_TO_DEFINITION",
    );
    const qns = binds
      .map((e) => {
        const decl = out.entities.find((x) => x.id === e.from);
        return decl?.qualifiedName;
      })
      .filter((s): s is string => !!s);
    // Circle::area, Circle::scale, Circle::~Circle, Shape::~Shape,
    // Circle::Circle all have exactly 1 def + 1 decl → 5 binds.
    // Shape::Shape has 2 overloads so cannot bind (warning emitted).
    // utility_free_function shares the same id for decl+def within a
    // single file, so no cross-entity edge is synthesised (this is the
    // same behaviour as the C extractor for in-file decl+def pairs).
    expect(qns.sort()).toEqual([
      "engine::Circle::Circle",
      "engine::Circle::area",
      "engine::Circle::scale",
      "engine::Circle::~Circle",
      "engine::Shape::~Shape",
    ]);
  });

  it("emits a warning diagnostic for overloaded constructors that can't bind", async () => {
    const out = await runOn("cpp/02-methods/methods.cpp");
    const project = linkProject([out]);
    const warn = project.diagnostics.find(
      (d) =>
        d.severity === "warning" &&
        d.message.includes("engine::Shape::Shape"),
    );
    expect(warn).toBeDefined();
  });
});
