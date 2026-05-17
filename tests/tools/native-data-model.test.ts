import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractNativeDataModel,
  hasNativeCodeFiles,
} from "../../src/tools/native-data-model.js";
import type { ProjectScan, ScannedFile } from "../../src/tools/scan-types.js";

async function makeScratchScan(): Promise<{ scan: ProjectScan; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "dg-native-bridge-"));
  await mkdir(join(root, "src"), { recursive: true });

  const cppPath = join(root, "src", "engine.cpp");
  await writeFile(cppPath,
    `#include <memory>
namespace engine {
struct Node { int value; Node* next; };
class Registry {
public:
    std::unique_ptr<Node> root;
};
} // namespace engine
`, "utf-8");

  const cPath = join(root, "src", "queue.c");
  await writeFile(cPath,
    `struct Item { int value; struct Item* next; };
typedef struct Item Item;
`, "utf-8");

  const cppFile: ScannedFile = {
    abs: cppPath,
    rel: "src/engine.cpp",
    name: "engine.cpp",
    ext: ".cpp",
    dirParts: ["src"],
    size: 0,
  };
  const cFile: ScannedFile = {
    abs: cPath,
    rel: "src/queue.c",
    name: "queue.c",
    ext: ".c",
    dirParts: ["src"],
    size: 0,
  };

  const scan: ProjectScan = {
    repoName: "demo",
    repoRoot: root,
    technology: "C/C++",
    files: [cppFile, cFile],
    manifestContent: {},
    uiFiles: [],
    topLevelDirs: ["src"],
    auxiliaryFiles: {
      test_suite: [],
      configuration: [],
      automation_script: [],
      mcp_tool: [],
    },
  };

  return { scan, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("native data-model bridge", () => {
  it("detects native files in the scan", async () => {
    const { scan, cleanup } = await makeScratchScan();
    try {
      expect(hasNativeCodeFiles(scan)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("emits a data-model entry for every C/C++ type and tracks parser coverage", async () => {
    const { scan, cleanup } = await makeScratchScan();
    try {
      const { entries, quality } = await extractNativeDataModel(scan);
      expect(quality.totalNativeFiles).toBe(2);
      expect(quality.parserBackedFiles).toBe(2);

      const names = entries.map((e) => e.name).sort();
      // Node + Registry (cpp) + Item struct + Item typedef (c)
      expect(names).toEqual(expect.arrayContaining(["Node", "Registry", "Item"]));

      const registry = entries.find((e) => e.name === "Registry") as Record<string, unknown>;
      expect(registry).toBeDefined();
      expect(registry.model_kind).toBe("cpp:class");
      expect(registry.source_files).toEqual(["src/engine.cpp"]);

      const keyFields = registry.key_fields as Array<{ name: string; type: string }>;
      expect(keyFields.some((f) => f.name === "root")).toBe(true);

      // unique_ptr<Node> on Registry should yield an OWNS relationship
      // resolved to the Node entry id.
      const node = entries.find((e) => e.name === "Node") as Record<string, unknown>;
      const rels = registry.relationships as Array<{ type: string; target: string; via: string }>;
      const owns = rels.find((r) => r.type === "OWNS");
      expect(owns).toBeDefined();
      expect(owns!.target).toBe(node.id);
      expect(owns!.via).toBe("unique_ptr");

      // Provenance hint must be present so downstream auditing can
      // separate native-extracted entries from heuristic ones.
      expect(registry.provenance).toMatchObject({ scanner: "native", language: "cpp" });
    } finally {
      await cleanup();
    }
  });

  it("returns zero quality when no native files are present", async () => {
    const scan: ProjectScan = {
      repoName: "ts-only",
      repoRoot: "/tmp/dg-noop",
      technology: "TypeScript",
      files: [{ abs: "/tmp/dg-noop/index.ts", rel: "index.ts", name: "index.ts", ext: ".ts", dirParts: [], size: 0 }],
      manifestContent: {},
      uiFiles: [],
      topLevelDirs: [],
      auxiliaryFiles: { test_suite: [], configuration: [], automation_script: [], mcp_tool: [] },
    };
    const { entries, quality } = await extractNativeDataModel(scan);
    expect(entries).toEqual([]);
    expect(quality.totalNativeFiles).toBe(0);
    expect(quality.parserBackedFiles).toBe(0);
  });

  // Coherence regression: every supported language must reach the bridge
  // through the same code path. Owner-qn separator drift (Java `.`,
  // Rust `.`, C++ `::`) and the Annotation kind must all resolve.
  it("aggregates Java fields onto their owning Class entry (owner-qn `.` separator)", async () => {
    const root = await mkdtemp(join(tmpdir(), "dg-native-bridge-java-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      const javaPath = join(root, "src", "Pkg.java");
      await writeFile(javaPath,
        `package com.example;
import java.util.List;
@Component
public class Holder {
  private List<Node> children;
  private Node primary;
}
class Node {}
@interface Component {}
`, "utf-8");
      const scan: ProjectScan = {
        repoName: "demo",
        repoRoot: root,
        technology: "Java",
        files: [{ abs: javaPath, rel: "src/Pkg.java", name: "Pkg.java", ext: ".java", dirParts: ["src"], size: 0 }],
        manifestContent: {},
        uiFiles: [],
        topLevelDirs: ["src"],
        auxiliaryFiles: { test_suite: [], configuration: [], automation_script: [], mcp_tool: [] },
      };
      const { entries } = await extractNativeDataModel(scan);
      const holder = entries.find((e) => e.name === "Holder") as Record<string, unknown>;
      expect(holder).toBeDefined();
      expect(holder.model_kind).toBe("java:class");
      const keyFields = holder.key_fields as Array<{ name: string }>;
      const fieldNames = keyFields.map((f) => f.name).sort();
      expect(fieldNames).toEqual(["children", "primary"]);

      // Annotation kind must surface as its own data-model entry so
      // HAS_ANNOTATION edges can resolve to it.
      const component = entries.find((e) => e.name === "Component") as Record<string, unknown>;
      expect(component).toBeDefined();
      expect(component.model_kind).toBe("java:annotation");

      // HAS_ANNOTATION on the Class must resolve to the Annotation entry id.
      const rels = holder.relationships as Array<{ type: string; target: string; via: string }>;
      const annRel = rels.find((r) => r.type === "HAS_ANNOTATION");
      expect(annRel).toBeDefined();
      expect(annRel!.target).toBe(component.id);
      expect(annRel!.via).toBe("annotation");

      // CONTAINS_MANY on a field must resolve to the Node entry id.
      const node = entries.find((e) => e.name === "Node") as Record<string, unknown>;
      const cm = rels.find((r) => r.type === "CONTAINS_MANY");
      expect(cm).toBeDefined();
      expect(cm!.target).toBe(node.id);
      expect(cm!.via).toBe("list");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("aggregates Rust struct fields onto their owning entry (mixed `::` + `.` qn)", async () => {
    const root = await mkdtemp(join(tmpdir(), "dg-native-bridge-rust-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      const rustPath = join(root, "src", "lib.rs");
      await writeFile(rustPath,
        `pub struct Node { pub value: i32 }
pub struct Holder { pub primary: Node }
`, "utf-8");
      const scan: ProjectScan = {
        repoName: "demo",
        repoRoot: root,
        technology: "Rust",
        files: [{ abs: rustPath, rel: "src/lib.rs", name: "lib.rs", ext: ".rs", dirParts: ["src"], size: 0 }],
        manifestContent: {},
        uiFiles: [],
        topLevelDirs: ["src"],
        auxiliaryFiles: { test_suite: [], configuration: [], automation_script: [], mcp_tool: [] },
      };
      const { entries } = await extractNativeDataModel(scan);
      const holder = entries.find((e) => e.name === "Holder") as Record<string, unknown>;
      expect(holder).toBeDefined();
      const keyFields = holder.key_fields as Array<{ name: string }>;
      expect(keyFields.map((f) => f.name)).toEqual(["primary"]);

      const node = entries.find((e) => e.name === "Node") as Record<string, unknown>;
      const rels = holder.relationships as Array<{ type: string; target: string }>;
      const embeds = rels.find((r) => r.type === "EMBEDS");
      expect(embeds).toBeDefined();
      expect(embeds!.target).toBe(node.id);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
