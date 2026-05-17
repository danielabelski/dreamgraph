import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

import { cppExtractor } from "../../src/scanner/extractors/cpp.js";
import type { ExtractorOutput } from "../../src/scanner/types.js";

const here = dirname(fileURLToPath(import.meta.url));

function normalise(out: ExtractorOutput): ExtractorOutput {
  const entities = [...out.entities].sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...out.edges].sort((a, b) => {
    if (a.from !== b.from) return a.from.localeCompare(b.from);
    if (a.to !== b.to) return a.to.localeCompare(b.to);
    return a.relationship.localeCompare(b.relationship);
  });
  return {
    entities,
    edges,
    shapes: [...out.shapes],
    diagnostics: [...out.diagnostics],
  };
}

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

describe("C++ extractor — CPP-1 namespaces, classes, inheritance", () => {
  it("matches the snapshot for the basic fixture", async () => {
    const out = await runOn("cpp/01-basic/basic.cpp");
    expect(normalise(out)).toMatchSnapshot();
  });

  it("emits a Namespace entity for `engine` and `engine::inner`", async () => {
    const out = await runOn("cpp/01-basic/basic.cpp");
    const namespaces = out.entities.filter((e) => e.kind === "Namespace");
    const names = namespaces.map((n) => n.qualifiedName).sort();
    expect(names).toEqual(["engine", "engine::inner"]);
  });

  it("qualifies nested entities with `::` separators", async () => {
    const out = await runOn("cpp/01-basic/basic.cpp");
    const classes = out.entities
      .filter((e) => e.kind === "Class")
      .map((e) => e.qualifiedName)
      .sort();
    expect(classes).toEqual([
      "engine::Circle",
      "engine::Shape",
      "engine::inner::Widget",
    ]);
  });

  it("emits a Struct for `Vec3` with default_access=public", async () => {
    const out = await runOn("cpp/01-basic/basic.cpp");
    const vec = out.entities.find(
      (e) => e.kind === "Struct" && e.qualifiedName === "engine::Vec3",
    );
    expect(vec).toBeDefined();
    expect(vec?.attrs).toMatchObject({ default_access: "public" });
  });

  it("emits EXTENDS edges from each derived class to its bases", async () => {
    const out = await runOn("cpp/01-basic/basic.cpp");
    const extends_ = out.edges.filter((e) => e.relationship === "EXTENDS");
    // Circle : public Shape
    const circleToShape = extends_.find(
      (e) => e.from.endsWith("Class:engine::Circle") &&
             e.to === "cpp:type:Shape",
    );
    expect(circleToShape?.meta).toMatchObject({
      base_type: "Shape",
      access: "public",
      is_virtual: false,
    });
    // Widget : protected Shape, public Circle
    const widgetBases = extends_
      .filter((e) => e.from.endsWith("Class:engine::inner::Widget"))
      .map((e) => ({ to: e.to, access: (e.meta as any)?.access }));
    expect(widgetBases).toEqual(
      expect.arrayContaining([
        { to: "cpp:type:Shape", access: "protected" },
        { to: "cpp:type:Circle", access: "public" },
      ]),
    );
  });

  it("tracks access modifiers on fields per declaration block", async () => {
    const out = await runOn("cpp/01-basic/basic.cpp");
    const fields = out.entities.filter((e) => e.kind === "Field");
    const byQn = new Map(fields.map((f) => [f.qualifiedName, f]));
    expect(byQn.get("engine::Shape::origin")?.attrs).toMatchObject({
      access: "protected",
    });
    expect(byQn.get("engine::Shape::id_")?.attrs).toMatchObject({
      access: "private",
    });
    expect(byQn.get("engine::Circle::radius_")?.attrs).toMatchObject({
      access: "private",
    });
  });

  it("captures pointer depth and references on member fields", async () => {
    const out = await runOn("cpp/01-basic/basic.cpp");
    const fields = out.entities.filter((e) => e.kind === "Field");
    const byQn = new Map(fields.map((f) => [f.qualifiedName, f]));
    expect(byQn.get("engine::Circle::next_")?.attrs).toMatchObject({
      pointer_depth: 1,
      base_type: "Shape",
      is_reference: false,
    });
    expect(byQn.get("engine::Circle::parent_ref_")?.attrs).toMatchObject({
      base_type: "Shape",
      is_reference: true,
    });
    expect(byQn.get("engine::inner::Widget::double_ptr_")?.attrs).toMatchObject({
      pointer_depth: 2,
      base_type: "int",
    });
  });

  it("emits POINTS_TO / POINTS_TO_POINTER for pointer fields", async () => {
    const out = await runOn("cpp/01-basic/basic.cpp");
    const fromCircleNext = out.edges.find(
      (e) =>
        e.from.endsWith("Field:engine::Circle::next_") &&
        e.relationship === "POINTS_TO",
    );
    expect(fromCircleNext?.to).toBe("cpp:type:Shape");
    expect(fromCircleNext?.meta).toMatchObject({ depth: 1, base_type: "Shape" });

    const fromDoublePtr = out.edges.find(
      (e) =>
        e.from.endsWith("Field:engine::inner::Widget::double_ptr_") &&
        e.relationship === "POINTS_TO_POINTER",
    );
    expect(fromDoublePtr?.to).toBe("cpp:type:int");
    expect(fromDoublePtr?.meta).toMatchObject({ depth: 2 });
  });

  it("emits a scoped enum with is_scoped=true and qualified members", async () => {
    const out = await runOn("cpp/01-basic/basic.cpp");
    const severity = out.entities.find(
      (e) => e.kind === "Enum" && e.qualifiedName === "engine::Severity",
    );
    expect(severity?.attrs).toMatchObject({ is_scoped: true });
    const members = out.entities
      .filter((e) => e.kind === "EnumMember")
      .map((e) => e.qualifiedName)
      .sort();
    expect(members).toEqual([
      "engine::Severity::High",
      "engine::Severity::Low",
      "engine::Severity::Medium",
    ]);
  });

  it("emits include edges with system vs quoted distinction", async () => {
    const out = await runOn("cpp/01-basic/basic.cpp");
    const includes = out.edges.filter((e) => e.relationship === "INCLUDES");
    const system = includes.find((e) => e.to.endsWith(":cstdint"));
    const local = includes.find((e) => e.to.endsWith(":engine.hpp"));
    expect(system?.meta).toMatchObject({ path: "cstdint", system: true });
    expect(local?.meta).toMatchObject({ path: "engine.hpp", system: false });
  });

  it("emits a MAX_NODES macro entity", async () => {
    const out = await runOn("cpp/01-basic/basic.cpp");
    const macro = out.entities.find(
      (e) => e.kind === "Macro" && e.name === "MAX_NODES",
    );
    expect(macro).toBeDefined();
  });

  it("does not emit error diagnostics for a clean fixture", async () => {
    const out = await runOn("cpp/01-basic/basic.cpp");
    const errors = out.diagnostics.filter((d) => d.severity === "error");
    expect(errors).toEqual([]);
  });
});
