import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

import { cExtractor } from "../../src/scanner/extractors/c.js";
import type { ExtractorOutput } from "../../src/scanner/types.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Normalise the extractor output so snapshots stay stable across hosts:
 *  - sort entities and edges deterministically;
 *  - strip absolute-path leakage by relying solely on `relPath`.
 */
function normalise(out: ExtractorOutput): ExtractorOutput {
  const entities = [...out.entities].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
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
  // Pretend the fixture lives at a stable workspace-relative path so
  // snapshots don't bake the developer's working directory into them.
  const relPath = relative(join(here, "fixtures"), absPath)
    .split(sep)
    .join("/");
  const name = relPath.split("/").pop() ?? relPath;
  const ext = name.includes(".") ? `.${name.split(".").pop()}` : "";
  const dirParts = relPath.split("/").slice(0, -1);
  return cExtractor.extract({
    absPath,
    relPath,
    source,
    language: "c",
    name,
    ext,
    dirParts,
  });
}

describe("C extractor — C-1 basic entities", () => {
  it("emits the expected entities and edges for the basic fixture", async () => {
    const out = await runOn("c/01-basic-structs/basic.c");
    const snap = normalise(out);
    expect(snap).toMatchSnapshot();
  });

  it("flags the source file as a SourceFile (not a HeaderFile)", async () => {
    const out = await runOn("c/01-basic-structs/basic.c");
    const file = out.entities.find((e) => e.id === "c:c/01-basic-structs/basic.c");
    expect(file).toBeDefined();
    expect(file?.kind).toBe("SourceFile");
  });

  it("emits include edges with system vs quoted distinction", async () => {
    const out = await runOn("c/01-basic-structs/basic.c");
    const includes = out.edges.filter((e) => e.relationship === "INCLUDES");
    const stdio = includes.find((e) => e.to.endsWith(":stdio.h"));
    const internal = includes.find((e) => e.to.endsWith(":internal.h"));
    expect(stdio?.meta).toMatchObject({ path: "stdio.h", system: true });
    expect(internal?.meta).toMatchObject({ path: "internal.h", system: false });
  });

  it("captures both the function prototype and the function definition", async () => {
    const out = await runOn("c/01-basic-structs/basic.c");
    const fns = out.entities.filter((e) => e.kind === "Function");
    const byName = new Map(fns.map((f) => [f.name, f]));
    expect(byName.get("node_count")?.attrs).toMatchObject({ is_definition: false });
    expect(byName.get("node_make")?.attrs).toMatchObject({ is_definition: true });
  });

  it("emits all enum members under the typedef enum", async () => {
    const out = await runOn("c/01-basic-structs/basic.c");
    const members = out.entities
      .filter((e) => e.kind === "EnumMember")
      .map((e) => e.name)
      .sort();
    expect(members).toContain("NODE_KIND_LEAF");
    expect(members).toContain("NODE_KIND_BRANCH");
  });

  it("emits a Union entity for the union declaration", async () => {
    const out = await runOn("c/01-basic-structs/basic.c");
    const unions = out.entities.filter((e) => e.kind === "Union");
    expect(unions.map((u) => u.name)).toContain("Payload");
  });

  it("emits macros for #define directives", async () => {
    const out = await runOn("c/01-basic-structs/basic.c");
    const macros = out.entities
      .filter((e) => e.kind === "Macro")
      .map((e) => e.name)
      .sort();
    expect(macros).toEqual(["LIST_FOREACH", "MAX_NODES"]);
  });
});

describe("C extractor — C-2 pointer modeling", () => {
  it("emits the expected entities and edges for the pointer fixture", async () => {
    const out = await runOn("c/02-pointers/pointers.c");
    expect(normalise(out)).toMatchSnapshot();
  });

  it("emits POINTS_TO at depth 1 and POINTS_TO_POINTER at depth >=2", async () => {
    const out = await runOn("c/02-pointers/pointers.c");
    const ptr = out.edges.filter((e) =>
      e.relationship === "POINTS_TO" ||
      e.relationship === "POINTS_TO_POINTER",
    );
    const next = ptr.find((e) => e.from.endsWith("Field:Node.next"));
    const owner = ptr.find((e) => e.from.endsWith("Field:Node.owner_slot"));
    expect(next?.relationship).toBe("POINTS_TO");
    expect(next?.to).toBe("c:type:Node");
    expect(next?.meta).toMatchObject({ depth: 1, base_type: "Node", resolved: false });
    expect(owner?.relationship).toBe("POINTS_TO_POINTER");
    expect(owner?.meta).toMatchObject({ depth: 2, base_type: "Node" });
  });

  it("captures const and volatile qualifiers on the pointee", async () => {
    const out = await runOn("c/02-pointers/pointers.c");
    const name = out.edges.find((e) => e.from.endsWith("Field:Node.name"));
    const flag = out.edges.find((e) => e.from.endsWith("Field:Node.flag"));
    expect(name?.meta).toMatchObject({ is_const: true, is_volatile: false });
    expect(flag?.meta).toMatchObject({ is_const: false, is_volatile: true });
  });

  it("does NOT emit POINTS_TO for non-pointer fields", async () => {
    const out = await runOn("c/02-pointers/pointers.c");
    const count = out.edges.find(
      (e) =>
        e.from.endsWith("Field:Node.count") &&
        (e.relationship === "POINTS_TO" ||
          e.relationship === "POINTS_TO_POINTER"),
    );
    expect(count).toBeUndefined();
  });

  it("records pointer_depth and base_type on the Field entity itself", async () => {
    const out = await runOn("c/02-pointers/pointers.c");
    const next = out.entities.find((e) => e.id.endsWith("Field:Node.next"));
    const count = out.entities.find((e) => e.id.endsWith("Field:Node.count"));
    expect(next?.attrs).toMatchObject({ pointer_depth: 1, base_type: "Node" });
    expect(count?.attrs).toMatchObject({ pointer_depth: 0 });
  });
});
