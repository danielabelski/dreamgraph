import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

import { rustExtractor } from "../../src/scanner/extractors/rust.js";
import { linkProject } from "../../src/scanner/orchestrator.js";
import type { ExtractedEdge, ExtractedEntity, ExtractorOutput } from "../../src/scanner/types.js";

const here = dirname(fileURLToPath(import.meta.url));

async function runOn(relFixturePath: string): Promise<ExtractorOutput> {
  const absPath = join(here, "fixtures", ...relFixturePath.split("/"));
  const source = await readFile(absPath, "utf8");
  const relPath = relative(join(here, "fixtures"), absPath).split(sep).join("/");
  const name = relPath.split("/").pop() ?? relPath;
  const ext = `.${name.split(".").pop()}`;
  const dirParts = relPath.split("/").slice(0, -1);
  return rustExtractor.extract({
    absPath, relPath, source, language: "rust", name, ext, dirParts,
  });
}

function find(es: readonly ExtractedEntity[], kind: string, qn: string): ExtractedEntity | undefined {
  return es.find((e) => e.kind === kind && e.qualifiedName === qn);
}

function edgesFrom(out: ExtractorOutput, fromId: string): ExtractedEdge[] {
  return out.edges.filter((e) => e.from === fromId);
}

describe("Rust extractor — RS-1 entities", () => {
  it("emits Module / Struct / Enum / Trait / TypeAlias / Constant / Function with canonical kinds", async () => {
    const out = await runOn("rust/01-core/core.rs");
    expect(find(out.entities, "Module", "engine")).toBeDefined();
    expect(find(out.entities, "Struct", "engine::Node")).toBeDefined();
    expect(find(out.entities, "Struct", "engine::Registry")).toBeDefined();
    expect(find(out.entities, "Enum", "engine::Event")).toBeDefined();
    expect(find(out.entities, "Trait", "engine::Visitor")).toBeDefined();
    expect(find(out.entities, "TypeAlias", "engine::NodeRef")).toBeDefined();
    expect(find(out.entities, "Constant", "engine::MAX_DEPTH")).toBeDefined();
    expect(find(out.entities, "Function", "launch")).toBeDefined();
  });

  it("emits EnumMember entities for unit, tuple, and struct variants", async () => {
    const out = await runOn("rust/01-core/core.rs");
    const pushed = find(out.entities, "EnumMember", "engine::Event.Pushed");
    const popped = find(out.entities, "EnumMember", "engine::Event.Popped");
    const updated = find(out.entities, "EnumMember", "engine::Event.Updated");
    expect(pushed?.attrs?.variant_shape).toBe("unit");
    expect(popped?.attrs?.variant_shape).toBe("tuple");
    expect(updated?.attrs?.variant_shape).toBe("struct");
  });

  it("emits Field entities with type_text for every named field", async () => {
    const out = await runOn("rust/01-core/core.rs");
    const root = find(out.entities, "Field", "engine::Registry.root");
    expect(root).toBeDefined();
    expect(typeof root!.attrs?.type_text).toBe("string");
    expect((root!.attrs!.type_text as string)).toMatch(/Box\s*<\s*Node\s*>/);
  });
});

describe("Rust extractor — RS-2 ownership and borrowing shapes", () => {
  it("emits OWNS via=box for Box<T>", async () => {
    const out = await runOn("rust/01-core/core.rs");
    const root = find(out.entities, "Field", "engine::Registry.root")!;
    const owns = edgesFrom(out, root.id).find((e) => e.relationship === "OWNS");
    expect(owns).toBeDefined();
    expect(owns!.to).toBe("rust:type:Node");
    expect(owns!.meta?.via).toBe("box");
  });

  it("emits OWNS_SHARED via=rc and via=arc", async () => {
    const out = await runOn("rust/01-core/core.rs");
    const sr = find(out.entities, "Field", "engine::Registry.shared_root")!;
    const ar = find(out.entities, "Field", "engine::Registry.arc_root")!;
    const rcEdge = edgesFrom(out, sr.id).find((e) => e.relationship === "OWNS_SHARED");
    const arcEdge = edgesFrom(out, ar.id).find((e) => e.relationship === "OWNS_SHARED");
    expect(rcEdge?.meta?.via).toBe("rc");
    expect(arcEdge?.meta?.via).toBe("arc");
  });

  it("emits BORROWS_WEAK via=weak for Weak<T>", async () => {
    const out = await runOn("rust/01-core/core.rs");
    const w = find(out.entities, "Field", "engine::Registry.weak_root")!;
    const edge = edgesFrom(out, w.id).find((e) => e.relationship === "BORROWS_WEAK");
    expect(edge).toBeDefined();
    expect(edge!.meta?.via).toBe("weak");
  });

  it("emits CONTAINS_MANY via=vec and MAPS_K_TO_V via=hashmap", async () => {
    const out = await runOn("rust/01-core/core.rs");
    const ch = find(out.entities, "Field", "engine::Registry.children")!;
    const bn = find(out.entities, "Field", "engine::Registry.by_name")!;
    const vec = edgesFrom(out, ch.id).find((e) => e.relationship === "CONTAINS_MANY");
    const map = edgesFrom(out, bn.id).find((e) => e.relationship === "MAPS_K_TO_V");
    expect(vec?.meta?.via).toBe("vec");
    expect(map?.meta?.via).toBe("hashmap");
    expect(map?.meta?.key_type).toBe("String");
    expect(map?.to).toBe("rust:type:Node");
  });

  it("emits MAY_CONTAIN via=option for Option<T>", async () => {
    const out = await runOn("rust/01-core/core.rs");
    const obs = find(out.entities, "Field", "engine::Registry.observer")!;
    const edge = edgesFrom(out, obs.id).find((e) => e.relationship === "MAY_CONTAIN");
    expect(edge?.meta?.via).toBe("option");
  });

  it("emits POINTS_TO via=raw_ptr / raw_mut_ptr for *const / *mut", async () => {
    const out = await runOn("rust/01-core/core.rs");
    const b = find(out.entities, "Field", "engine::Registry.borrowed")!;
    const bm = find(out.entities, "Field", "engine::Registry.borrowed_mut")!;
    const ptr = edgesFrom(out, b.id).find((e) => e.relationship === "POINTS_TO");
    const ptrMut = edgesFrom(out, bm.id).find((e) => e.relationship === "POINTS_TO");
    expect(ptr?.meta?.via).toBe("raw_ptr");
    expect(ptrMut?.meta?.via).toBe("raw_mut_ptr");
  });
});

describe("Rust extractor — RS-3 impl blocks", () => {
  it("emits Method entities qualified by the Self type", async () => {
    const out = await runOn("rust/01-core/core.rs");
    const newFn = out.entities.find(
      (e) => e.kind === "Method" && e.qualifiedName === "engine::Registry::new",
    );
    expect(newFn).toBeDefined();
    expect(newFn!.attrs?.is_definition).toBe(true);
  });

  it("emits IMPLEMENTS_TRAIT for `impl Trait for Type`", async () => {
    const out = await runOn("rust/01-core/core.rs");
    const impls = out.edges.filter((e) => e.relationship === "IMPLEMENTS_TRAIT");
    expect(impls.length).toBe(1);
    expect(impls[0]!.to).toBe("rust:type:Visitor");
    expect(impls[0]!.meta?.self_type).toBe("Registry");
  });
});

describe("Rust ↔ orchestrator — language-agnostic semantic binding", () => {
  it("resolves rust:type:Node placeholders to the Struct entity (same code path as C/C++)", async () => {
    const out = await runOn("rust/01-core/core.rs");
    const linked = linkProject([out]);
    const root = linked.entities.find(
      (e) => e.kind === "Field" && e.qualifiedName === "engine::Registry.root",
    )!;
    const owns = linked.edges.find(
      (e) => e.from === root.id && e.relationship === "OWNS",
    )!;
    const node = linked.entities.find(
      (e) => e.kind === "Struct" && e.qualifiedName === "engine::Node",
    )!;
    expect(owns.to).toBe(node.id);
    expect(owns.meta?.resolved).toBe(true);
  });

  it("resolves IMPLEMENTS_TRAIT placeholder to the Trait entity", async () => {
    const out = await runOn("rust/01-core/core.rs");
    const linked = linkProject([out]);
    const trait = linked.entities.find(
      (e) => e.kind === "Trait" && e.qualifiedName === "engine::Visitor",
    )!;
    const impls = linked.edges.find((e) => e.relationship === "IMPLEMENTS_TRAIT")!;
    expect(impls.to).toBe(trait.id);
    expect(impls.meta?.resolved).toBe(true);
  });
});
