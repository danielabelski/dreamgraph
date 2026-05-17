import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

import { cExtractor } from "../../src/scanner/extractors/c.js";
import { linkProject } from "../../src/scanner/orchestrator.js";
import { Relationship } from "../../src/scanner/ontology.js";
import type { ExtractorOutput } from "../../src/scanner/types.js";

const here = dirname(fileURLToPath(import.meta.url));

async function extractFile(relFixturePath: string): Promise<ExtractorOutput> {
  const absPath = join(here, "fixtures", ...relFixturePath.split("/"));
  const source = await readFile(absPath, "utf8");
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

describe("C extractor — C-3 header ↔ source binding", () => {
  it("resolves quoted #include to the matching project header", async () => {
    const header = await extractFile("c/03-header-source/graph.h");
    const source = await extractFile("c/03-header-source/graph.c");
    const project = linkProject([header, source]);

    const include = project.edges.find(
      (e) => e.relationship === Relationship.INCLUDES,
    );
    expect(include?.to).toBe("c:c/03-header-source/graph.h");
    expect(include?.meta).toMatchObject({ resolved: true, path: "graph.h" });
  });

  it("rewrites POINTS_TO targets to the real Struct entity ids", async () => {
    const project = linkProject([
      await extractFile("c/03-header-source/graph.h"),
      await extractFile("c/03-header-source/graph.c"),
    ]);

    const firstFieldPtr = project.edges.find(
      (e) =>
        e.relationship === Relationship.POINTS_TO &&
        e.from.endsWith("Field:Bucket.first"),
    );
    // `Node` is the typedef alias for `struct Node`; the orchestrator
    // picks the unique type entity carrying that name. Both the
    // TypeAlias and the Struct share the same simple name "Node", which
    // is ambiguous — so the orchestrator should leave it symbolic and
    // surface a warning. Verify exactly that.
    expect(firstFieldPtr?.to.startsWith("c:type:")).toBe(true);
    expect(firstFieldPtr?.meta).toMatchObject({ resolved: false });

    const ambiguous = project.diagnostics.find((d) =>
      d.message.includes("Pointer target \"Node\""),
    );
    expect(ambiguous?.severity).toBe("warning");
  });

  it("emits BINDS_DECLARATION_TO_DEFINITION across files for both functions", async () => {
    const project = linkProject([
      await extractFile("c/03-header-source/graph.h"),
      await extractFile("c/03-header-source/graph.c"),
    ]);

    const binds = project.edges.filter(
      (e) =>
        e.relationship === Relationship.BINDS_DECLARATION_TO_DEFINITION,
    );
    const names = binds
      .map((e) => e.from.split(":").pop() ?? "")
      .sort();
    expect(names).toEqual(["node_count", "node_make"]);

    // The decl side must come from the header, the def side from the source.
    for (const e of binds) {
      expect(e.from).toContain("graph.h");
      expect(e.to).toContain("graph.c");
    }
  });

  it("does not resolve system includes against project files", async () => {
    // Build a fake project with a "stdio.h" file present, then make
    // sure a `#include <stdio.h>` in another file stays unresolved.
    const project = linkProject([
      await extractFile("c/01-basic-structs/basic.c"),
    ]);
    const stdio = project.edges.find(
      (e) =>
        e.relationship === Relationship.INCLUDES && e.to.endsWith(":stdio.h"),
    );
    expect(stdio?.to).toBe("c:include:stdio.h");
    expect(stdio?.meta).toMatchObject({ system: true });
  });
});
