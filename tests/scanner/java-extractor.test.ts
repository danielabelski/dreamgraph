import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

import { javaExtractor } from "../../src/scanner/extractors/java.js";
import { linkProject } from "../../src/scanner/orchestrator.js";
import type {
  ExtractedEdge,
  ExtractedEntity,
  ExtractorOutput,
} from "../../src/scanner/types.js";

const here = dirname(fileURLToPath(import.meta.url));

async function runOn(relFixturePath: string): Promise<ExtractorOutput> {
  const absPath = join(here, "fixtures", ...relFixturePath.split("/"));
  const source = await readFile(absPath, "utf8");
  const relPath = relative(join(here, "fixtures"), absPath).split(sep).join("/");
  const name = relPath.split("/").pop() ?? relPath;
  const ext = `.${name.split(".").pop()}`;
  const dirParts = relPath.split("/").slice(0, -1);
  return javaExtractor.extract({
    absPath, relPath, source, language: "java", name, ext, dirParts,
  });
}

function find(
  es: readonly ExtractedEntity[],
  kind: string,
  qn: string,
): ExtractedEntity | undefined {
  return es.find((e) => e.kind === kind && e.qualifiedName === qn);
}

function edgesFrom(out: ExtractorOutput, fromId: string): ExtractedEdge[] {
  return out.edges.filter((e) => e.from === fromId);
}

describe("Java extractor — JV-1 entities and imports", () => {
  it("emits Package, Class, Interface, Record, Enum, Annotation with canonical kinds", async () => {
    const out = await runOn("java/01-core/Registry.java");
    expect(find(out.entities, "Package", "com.example.engine")).toBeDefined();
    expect(find(out.entities, "Class", "com.example.engine.Registry")).toBeDefined();
    expect(find(out.entities, "Class", "com.example.engine.BaseRegistry")).toBeDefined();
    expect(find(out.entities, "Interface", "com.example.engine.Visitor")).toBeDefined();
    expect(find(out.entities, "Interface", "com.example.engine.Lifecycle")).toBeDefined();
    expect(find(out.entities, "Enum", "com.example.engine.Phase")).toBeDefined();
    expect(find(out.entities, "Record", "com.example.engine.Node")).toBeDefined();
    expect(find(out.entities, "Annotation", "com.example.engine.Component")).toBeDefined();
  });

  it("emits IMPORTS edges for single-type and wildcard imports", async () => {
    const out = await runOn("java/01-core/Registry.java");
    const imports = out.edges.filter((e) => e.relationship === "IMPORTS");
    const single = imports.find((e) => e.to === "java:type:Logger");
    const wildcard = imports.find((e) => e.to === "java:use:com.example.util.*");
    expect(single).toBeDefined();
    expect(wildcard).toBeDefined();
    expect(wildcard!.meta?.wildcard).toBe(true);
  });

  it("emits EnumMember entities for each enum constant", async () => {
    const out = await runOn("java/01-core/Registry.java");
    expect(find(out.entities, "EnumMember", "com.example.engine.Phase.INIT")).toBeDefined();
    expect(find(out.entities, "EnumMember", "com.example.engine.Phase.RUNNING")).toBeDefined();
    expect(find(out.entities, "EnumMember", "com.example.engine.Phase.STOPPED")).toBeDefined();
  });
});

describe("Java extractor — JV-2 members and shapes", () => {
  it("emits CONTAINS_MANY via=list for List<Node>", async () => {
    const out = await runOn("java/01-core/Registry.java");
    const f = find(out.entities, "Field", "com.example.engine.Registry.children")!;
    const e = edgesFrom(out, f.id).find((x) => x.relationship === "CONTAINS_MANY");
    expect(e?.meta?.via).toBe("list");
    expect(e?.to).toBe("java:type:Node");
  });

  it("emits MAPS_K_TO_V via=map for Map<String,Node> with key_type and value target", async () => {
    const out = await runOn("java/01-core/Registry.java");
    const f = find(out.entities, "Field", "com.example.engine.Registry.byName")!;
    const e = edgesFrom(out, f.id).find((x) => x.relationship === "MAPS_K_TO_V");
    expect(e?.meta?.via).toBe("map");
    expect(e?.meta?.key_type).toBe("String");
    expect(e?.to).toBe("java:type:Node");
  });

  it("emits MAY_CONTAIN via=optional for Optional<Node>", async () => {
    const out = await runOn("java/01-core/Registry.java");
    const f = find(out.entities, "Field", "com.example.engine.Registry.observer")!;
    const e = edgesFrom(out, f.id).find((x) => x.relationship === "MAY_CONTAIN");
    expect(e?.meta?.via).toBe("optional");
    expect(e?.to).toBe("java:type:Node");
  });

  it("emits CONTAINS_MANY via=array for Node[]", async () => {
    const out = await runOn("java/01-core/Registry.java");
    const f = find(out.entities, "Field", "com.example.engine.Registry.backing")!;
    const e = edgesFrom(out, f.id).find((x) => x.relationship === "CONTAINS_MANY");
    expect(e?.meta?.via).toBe("array");
    expect(e?.to).toBe("java:type:Node");
  });

  it("surfaces `static final` field as a Constant entity (alongside the Field)", async () => {
    const out = await runOn("java/01-core/Registry.java");
    expect(find(out.entities, "Constant", "com.example.engine.Registry.MAX_DEPTH")).toBeDefined();
    expect(find(out.entities, "Field", "com.example.engine.Registry.MAX_DEPTH")).toBeDefined();
  });

  it("emits Method entities with is_definition reflecting whether a body is present", async () => {
    const out = await runOn("java/01-core/Registry.java");
    const visit = out.entities.find(
      (e) => e.kind === "Method" && e.qualifiedName === "com.example.engine.Registry.visit",
    );
    expect(visit).toBeDefined();
    expect(visit!.attrs?.is_definition).toBe(true);

    const ifaceVisit = out.entities.find(
      (e) => e.kind === "Method" && e.qualifiedName === "com.example.engine.Visitor.visit",
    );
    expect(ifaceVisit).toBeDefined();
    expect(ifaceVisit!.attrs?.is_definition).toBe(false);
  });

  it("emits a Constructor entity for the no-arg `new`", async () => {
    const out = await runOn("java/01-core/Registry.java");
    const ctor = out.entities.find(
      (e) => e.kind === "Constructor" && e.qualifiedName === "com.example.engine.Registry.Registry",
    );
    expect(ctor).toBeDefined();
  });
});

describe("Java extractor — JV-3 inheritance and annotations", () => {
  it("emits EXTENDS to the superclass and IMPLEMENTS to every declared interface", async () => {
    const out = await runOn("java/01-core/Registry.java");
    const reg = find(out.entities, "Class", "com.example.engine.Registry")!;
    const ex = edgesFrom(out, reg.id).find((e) => e.relationship === "EXTENDS");
    expect(ex?.to).toBe("java:type:BaseRegistry");

    const impls = edgesFrom(out, reg.id).filter((e) => e.relationship === "IMPLEMENTS");
    const targets = impls.map((e) => e.to).sort();
    expect(targets).toEqual(["java:type:Lifecycle", "java:type:Visitor"]);
  });

  it("models `interface X extends Y` as EXTENDS (not IMPLEMENTS)", async () => {
    const out = await runOn("java/01-core/Registry.java");
    const lc = find(out.entities, "Interface", "com.example.engine.Lifecycle")!;
    const ex = edgesFrom(out, lc.id).find((e) => e.relationship === "EXTENDS");
    expect(ex?.to).toBe("java:type:AutoCloseable");
    expect(edgesFrom(out, lc.id).some((e) => e.relationship === "IMPLEMENTS")).toBe(false);
  });

  it("emits HAS_ANNOTATION edges for class- and field-level annotations", async () => {
    const out = await runOn("java/01-core/Registry.java");
    const reg = find(out.entities, "Class", "com.example.engine.Registry")!;
    const clsAnn = edgesFrom(out, reg.id).find((e) => e.relationship === "HAS_ANNOTATION");
    expect(clsAnn?.to).toBe("java:type:Component");

    const logger = find(out.entities, "Field", "com.example.engine.Registry.logger")!;
    const fieldAnn = edgesFrom(out, logger.id).find((e) => e.relationship === "HAS_ANNOTATION");
    expect(fieldAnn?.to).toBe("java:type:Inject");

    const visit = out.entities.find(
      (e) => e.kind === "Method" && e.qualifiedName === "com.example.engine.Registry.visit",
    )!;
    const methodAnn = edgesFrom(out, visit.id).find((e) => e.relationship === "HAS_ANNOTATION");
    expect(methodAnn?.to).toBe("java:type:Override");
  });
});

describe("Java ↔ orchestrator — language-agnostic semantic binding", () => {
  it("resolves java:type:Node placeholders through the same code path used by C/C++/Rust", async () => {
    const out = await runOn("java/01-core/Registry.java");
    const linked = linkProject([out]);
    const node = linked.entities.find(
      (e) => e.kind === "Record" && e.qualifiedName === "com.example.engine.Node",
    )!;
    const f = linked.entities.find(
      (e) => e.kind === "Field" && e.qualifiedName === "com.example.engine.Registry.children",
    )!;
    const owns = linked.edges.find(
      (e) => e.from === f.id && e.relationship === "CONTAINS_MANY",
    )!;
    expect(owns.to).toBe(node.id);
    expect(owns.meta?.resolved).toBe(true);
  });

  it("resolves IMPLEMENTS placeholder to the Interface entity", async () => {
    const out = await runOn("java/01-core/Registry.java");
    const linked = linkProject([out]);
    const visitor = linked.entities.find(
      (e) => e.kind === "Interface" && e.qualifiedName === "com.example.engine.Visitor",
    )!;
    const impls = linked.edges.find(
      (e) => e.relationship === "IMPLEMENTS" && e.to === visitor.id,
    );
    expect(impls).toBeDefined();
    expect(impls!.meta?.resolved).toBe(true);
  });
});
