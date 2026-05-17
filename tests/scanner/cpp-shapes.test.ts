import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

import { cppExtractor } from "../../src/scanner/extractors/cpp.js";
import { linkProject } from "../../src/scanner/orchestrator.js";
import type { ExtractedEdge, ExtractorOutput } from "../../src/scanner/types.js";

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

function edgesFromField(
  out: ExtractorOutput,
  fieldQn: string,
): ExtractedEdge[] {
  const field = out.entities.find(
    (e) => e.kind === "Field" && e.qualifiedName === fieldQn,
  );
  if (!field) return [];
  return out.edges.filter((e) => e.from === field.id);
}

describe("C++ extractor — CPP-3 smart pointers and STL containers", () => {
  it("emits OWNS for unique_ptr<T> fields", async () => {
    const out = await runOn("cpp/03-shapes/shapes.cpp");
    const edges = edgesFromField(out, "engine::Registry::root_");
    const owns = edges.find((e) => e.relationship === "OWNS");
    expect(owns).toBeDefined();
    expect(owns!.to).toBe("cpp:type:Node");
    expect(owns!.meta?.smart_pointer).toBe("unique");
  });

  it("emits OWNS for bare-name unique_ptr<T> (no std:: prefix)", async () => {
    const out = await runOn("cpp/03-shapes/shapes.cpp");
    const edges = edgesFromField(out, "engine::Registry::alt_root_");
    const owns = edges.find((e) => e.relationship === "OWNS");
    expect(owns).toBeDefined();
    expect(owns!.to).toBe("cpp:type:Node");
  });

  it("emits OWNS_SHARED for shared_ptr<T>", async () => {
    const out = await runOn("cpp/03-shapes/shapes.cpp");
    const edges = edgesFromField(out, "engine::Registry::shared_item_");
    const e = edges.find((x) => x.relationship === "OWNS_SHARED");
    expect(e).toBeDefined();
    expect(e!.to).toBe("cpp:type:Item");
    expect(e!.meta?.smart_pointer).toBe("shared");
  });

  it("emits BORROWS_WEAK for weak_ptr<T>", async () => {
    const out = await runOn("cpp/03-shapes/shapes.cpp");
    const edges = edgesFromField(out, "engine::Registry::weak_item_");
    const e = edges.find((x) => x.relationship === "BORROWS_WEAK");
    expect(e).toBeDefined();
    expect(e!.to).toBe("cpp:type:Item");
    expect(e!.meta?.smart_pointer).toBe("weak");
  });

  it("emits CONTAINS_MANY for vector/list/set", async () => {
    const out = await runOn("cpp/03-shapes/shapes.cpp");
    for (const [fld, elem, tpl] of [
      ["engine::Registry::items_", "Item", "vector"],
      ["engine::Registry::nodes_", "Node", "list"],
      ["engine::Registry::ids_", "int", "set"],
    ] as const) {
      const edges = edgesFromField(out, fld);
      const e = edges.find((x) => x.relationship === "CONTAINS_MANY");
      expect(e, `expected CONTAINS_MANY on ${fld}`).toBeDefined();
      expect(e!.to).toBe(`cpp:type:${elem}`);
      expect(e!.meta?.container_template).toBe(tpl);
    }
  });

  it("emits MAPS_K_TO_V for unordered_map<K, V>", async () => {
    const out = await runOn("cpp/03-shapes/shapes.cpp");
    const edges = edgesFromField(out, "engine::Registry::by_id_");
    const e = edges.find((x) => x.relationship === "MAPS_K_TO_V");
    expect(e).toBeDefined();
    expect(e!.to).toBe("cpp:type:Item");
    expect(e!.meta?.container_template).toBe("unordered_map");
    expect(e!.meta?.key_type).toBe("int");
  });

  it("tags Field attrs with shape metadata", async () => {
    const out = await runOn("cpp/03-shapes/shapes.cpp");
    const root = out.entities.find(
      (e) => e.qualifiedName === "engine::Registry::root_",
    );
    expect(root?.attrs?.smart_pointer).toBe("unique");
    expect(root?.attrs?.element_type).toBe("Node");

    const items = out.entities.find(
      (e) => e.qualifiedName === "engine::Registry::items_",
    );
    expect(items?.attrs?.container_template).toBe("vector");
    expect(items?.attrs?.element_type).toBe("Item");

    const by_id = out.entities.find(
      (e) => e.qualifiedName === "engine::Registry::by_id_",
    );
    expect(by_id?.attrs?.container_template).toBe("unordered_map");
    expect(by_id?.attrs?.key_type).toBe("int");
    expect(by_id?.attrs?.value_type).toBe("Item");
  });

  it("leaves raw pointer fields on the POINTS_TO path", async () => {
    const out = await runOn("cpp/03-shapes/shapes.cpp");
    const edges = edgesFromField(out, "engine::Registry::raw_");
    const pt = edges.find((e) => e.relationship === "POINTS_TO");
    expect(pt).toBeDefined();
    expect(pt!.to).toBe("cpp:type:Node");
    // No smart-pointer / container edge for raw pointers.
    expect(edges.find((e) => e.relationship === "OWNS")).toBeUndefined();
    expect(edges.find((e) => e.relationship === "CONTAINS_MANY")).toBeUndefined();
  });

  it("orchestrator resolves shape edges to in-project type entities", async () => {
    const out = await runOn("cpp/03-shapes/shapes.cpp");
    const project = linkProject([out]);
    const nodeEntity = out.entities.find(
      (e) => e.kind === "Struct" && e.qualifiedName === "engine::Node",
    );
    const itemEntity = out.entities.find(
      (e) => e.kind === "Struct" && e.qualifiedName === "engine::Item",
    );
    expect(nodeEntity).toBeDefined();
    expect(itemEntity).toBeDefined();

    const owns = project.edges.find(
      (e) => e.relationship === "OWNS" && e.to === nodeEntity!.id,
    );
    expect(owns).toBeDefined();
    expect(owns!.meta?.resolved).toBe(true);

    const mapsEdge = project.edges.find(
      (e) => e.relationship === "MAPS_K_TO_V" && e.to === itemEntity!.id,
    );
    expect(mapsEdge).toBeDefined();
    expect(mapsEdge!.meta?.resolved).toBe(true);
  });
});
