import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

import { swiftExtractor } from "../../src/scanner/extractors/swift.js";
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
  return swiftExtractor.extract({
    absPath, relPath, source, language: "swift", name, ext, dirParts,
  });
}

function find(es: readonly ExtractedEntity[], kind: string, qn: string): ExtractedEntity | undefined {
  return es.find((e) => e.kind === kind && e.qualifiedName === qn);
}

function edgesFrom(edges: readonly ExtractedEdge[], fromId: string): ExtractedEdge[] {
  return edges.filter((e) => e.from === fromId);
}

describe("Swift extractor — SW-1 file structure + top-level declarations", () => {
  it("emits a SourceFile entity for the file", async () => {
    const out = await runOn("swift/01-basic/people.swift");
    const sf = out.entities.find((e) => e.kind === "SourceFile");
    expect(sf).toBeDefined();
    expect(sf?.attrs?.base_name).toBe("people");
  });

  it("emits IMPORTS edges for each import", async () => {
    const out = await runOn("swift/01-basic/people.swift");
    const imports = out.edges.filter((e) => e.relationship === "IMPORTS");
    expect(imports.find((e) => e.to === "swift:use:Foundation")).toBeDefined();
    expect(imports.find((e) => e.to === "swift:use:UIKit")).toBeDefined();
    expect(imports.find((e) => e.to === "swift:use:os.log")).toBeDefined();
  });

  it("emits Class / Struct / Enum / Interface / TypeAlias entities", async () => {
    const out = await runOn("swift/01-basic/people.swift");
    expect(find(out.entities, "Class", "Person")).toBeDefined();
    expect(find(out.entities, "Class", "Animal")).toBeDefined();
    expect(find(out.entities, "Struct", "Point")).toBeDefined();
    expect(find(out.entities, "Enum", "Direction")).toBeDefined();
    expect(find(out.entities, "Interface", "Greetable")).toBeDefined();
    expect(find(out.entities, "Interface", "Identifiable")).toBeDefined();
    const ta = find(out.entities, "TypeAlias", "UserID")!;
    expect(ta.attrs?.is_alias).toBe(true);
    expect(ta.attrs?.underlying_type).toBe("Int");
  });

  it("emits top-level Function and Field entities", async () => {
    const out = await runOn("swift/01-basic/people.swift");
    const fn = find(out.entities, "Function", "freeFunc")!;
    expect(fn).toBeDefined();
    expect(fn.attrs?.is_top_level).toBe(true);
    expect(Array.isArray(fn.attrs?.parameter_types)).toBe(true);
    const g = find(out.entities, "Field", "GLOBAL")!;
    expect(g.attrs?.is_top_level).toBe(true);
    expect(g.attrs?.is_let).toBe(true);
    expect(g.attrs?.type_text).toBe("String");
    const c = find(out.entities, "Field", "counter")!;
    expect(c.attrs?.is_let).toBe(false);
  });

  it("records visibility modifiers", async () => {
    const out = await runOn("swift/01-basic/people.swift");
    const person = find(out.entities, "Class", "Person")!;
    expect(person.attrs?.visibility).toBe("public");
    const fn = find(out.entities, "Function", "freeFunc")!;
    expect(fn.attrs?.visibility).toBe("public");
  });
});

describe("Swift extractor — SW-2 type bodies + members", () => {
  it("emits Field entities for properties with owner_qualified_name", async () => {
    const out = await runOn("swift/01-basic/people.swift");
    const name = find(out.entities, "Field", "Person.name")!;
    expect(name.attrs?.owner_qualified_name).toBe("Person");
    expect(name.attrs?.is_let).toBe(false);
    expect(name.attrs?.type_text).toBe("String");
    const id = find(out.entities, "Field", "Person.id")!;
    expect(id.attrs?.is_let).toBe(true);
    const nicks = find(out.entities, "Field", "Person.nicknames")!;
    expect(nicks.attrs?.visibility).toBe("private");
    expect(nicks.attrs?.type_shape).toBe("array");
    const ctr = find(out.entities, "Field", "Person.counter")!;
    expect(ctr.attrs?.is_static).toBe(true);
  });

  it("flags optional properties and dictionary properties", async () => {
    const out = await runOn("swift/01-basic/people.swift");
    const pet = find(out.entities, "Field", "Person.pet")!;
    expect(pet.attrs?.optional).toBe(true);
    expect(pet.attrs?.type_shape).toBe("optional");
    const refs = edgesFrom(out.edges, pet.id).filter((e) => e.relationship === "REFERENCES_TYPE");
    expect(refs[0]!.to).toBe("swift:type:Animal");
    expect(refs[0]!.meta?.optional).toBe(true);
    expect(refs[0]!.meta?.resolved).toBe(false);

    const lookup = find(out.entities, "Field", "Person.lookup")!;
    expect(lookup.attrs?.type_shape).toBe("dictionary");
    expect(lookup.attrs?.key_type).toBe("String");
    const maps = edgesFrom(out.edges, lookup.id).filter((e) => e.relationship === "MAPS_K_TO_V");
    expect(maps[0]!.to).toBe("swift:type:Person");
    expect(maps[0]!.meta?.key_type).toBe("String");
  });

  it("emits CONTAINS_MANY for array-typed property", async () => {
    const out = await runOn("swift/01-basic/people.swift");
    const nicks = find(out.entities, "Field", "Person.nicknames")!;
    const cm = edgesFrom(out.edges, nicks.id).filter((e) => e.relationship === "CONTAINS_MANY");
    expect(cm[0]!.to).toBe("swift:type:String");
    expect(cm[0]!.meta?.via).toBe("array");
  });

  it("emits Method entities with parameter_types and return_types", async () => {
    const out = await runOn("swift/01-basic/people.swift");
    const greet = find(out.entities, "Method", "Person.greet")!;
    expect(greet.attrs?.owner_qualified_name).toBe("Person");
    expect(greet.attrs?.return_types).toEqual(["String"]);
    const fw = find(out.entities, "Method", "Person.farewell")!;
    expect(fw.attrs?.is_async).toBe(true);
    expect(fw.attrs?.throws).toBe(true);
    const desc = find(out.entities, "Method", "Person.description")!;
    expect(desc.attrs?.is_override).toBe(true);
  });

  it("emits Constructor entity for init", async () => {
    const out = await runOn("swift/01-basic/people.swift");
    const ctor = find(out.entities, "Constructor", "Person.init")!;
    expect(ctor).toBeDefined();
    expect(ctor.attrs?.is_initializer).toBe(true);
    expect(ctor.attrs?.parameter_types).toEqual(["String", "Int"]);
  });

  it("emits EnumMember entities with associated_values", async () => {
    const out = await runOn("swift/01-basic/people.swift");
    expect(find(out.entities, "EnumMember", "Direction.north")).toBeDefined();
    expect(find(out.entities, "EnumMember", "Direction.south")).toBeDefined();
    const east = find(out.entities, "EnumMember", "Direction.east")!;
    expect(east.attrs?.is_enum_case).toBe(true);
    expect(east.attrs?.associated_values).toEqual([{ label: "speed", type: "Int" }]);
    const west = find(out.entities, "EnumMember", "Direction.west")!;
    expect(west.attrs?.associated_values).toEqual([
      { label: "speed", type: "Int" },
      { label: "weight", type: "Double" },
    ]);
  });

  it("binds extension members to the extended type with from_extension flag", async () => {
    const out = await runOn("swift/01-basic/people.swift");
    const shout = find(out.entities, "Method", "Person.shout")!;
    expect(shout).toBeDefined();
    expect(shout.attrs?.from_extension).toBe(true);
    expect(shout.attrs?.owner_qualified_name).toBe("Person");
  });
});

describe("Swift extractor — SW-3 inheritance + protocol members + type shapes", () => {
  it("emits EXTENDS for the first inheritance entry of a class", async () => {
    // Person has no concrete superclass — both entries are protocols, so no EXTENDS.
    const out = await runOn("swift/01-basic/people.swift");
    const person = find(out.entities, "Class", "Person")!;
    const ext = edgesFrom(out.edges, person.id).filter((e) => e.relationship === "EXTENDS");
    // First inheritance entry is treated as superclass-or-protocol per Swift
    // ordering. We emit EXTENDS for it regardless.
    expect(ext.length).toBe(1);
    expect(ext[0]!.to).toBe("swift:type:Greetable");
    expect(ext[0]!.meta?.via).toBe("superclass");

    const impls = edgesFrom(out.edges, person.id).filter((e) => e.relationship === "IMPLEMENTS");
    expect(impls.map((e) => e.to)).toEqual(["swift:type:Identifiable"]);
  });

  it("emits EXTENDS for protocol inheritance", async () => {
    const out = await runOn("swift/01-basic/people.swift");
    const ident = find(out.entities, "Interface", "Identifiable")!;
    const ext = edgesFrom(out.edges, ident.id).filter((e) => e.relationship === "EXTENDS");
    expect(ext.map((e) => e.to)).toEqual(["swift:type:AnyObject"]);
    expect(ext[0]!.meta?.via).toBe("protocol_inheritance");
  });

  it("emits IMPLEMENTS edge for extension conformance", async () => {
    const out = await runOn("swift/01-basic/people.swift");
    const impl = out.edges.find(
      (e) =>
        e.relationship === "IMPLEMENTS" &&
        e.from === "swift:type:Person" &&
        e.to === "swift:type:Equatable",
    );
    expect(impl).toBeDefined();
    expect(impl?.meta?.via).toBe("extension_conformance");
  });

  it("emits abstract Method entities for protocol method specs", async () => {
    const out = await runOn("swift/01-basic/people.swift");
    const m = find(out.entities, "Method", "Greetable.greet")!;
    expect(m.attrs?.is_abstract).toBe(true);
    expect(m.attrs?.is_definition).toBe(false);
    expect(m.attrs?.return_types).toEqual(["String"]);
    const fw = find(out.entities, "Method", "Greetable.farewell")!;
    expect(fw.attrs?.is_async).toBe(true);
    expect(fw.attrs?.throws).toBe(true);
  });

  it("emits abstract Field entities for protocol property requirements", async () => {
    const out = await runOn("swift/01-basic/people.swift");
    const name = find(out.entities, "Field", "Greetable.name")!;
    expect(name.attrs?.is_abstract).toBe(true);
    expect(name.attrs?.has_get).toBe(true);
    expect(name.attrs?.has_set).toBe(false);
    const nick = find(out.entities, "Field", "Greetable.nickname")!;
    expect(nick.attrs?.has_get).toBe(true);
    expect(nick.attrs?.has_set).toBe(true);
    expect(nick.attrs?.type_shape).toBe("optional");
  });

  it("emits no HAS_ANNOTATION edges (Swift annotations are out of scope)", async () => {
    const out = await runOn("swift/01-basic/people.swift");
    const ann = out.edges.filter((e) => e.relationship === "HAS_ANNOTATION");
    expect(ann.length).toBe(0);
  });
});
