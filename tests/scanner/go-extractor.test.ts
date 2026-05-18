import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

import { goExtractor } from "../../src/scanner/extractors/go.js";
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
  return goExtractor.extract({
    absPath, relPath, source, language: "go", name, ext, dirParts,
  });
}

function find(es: readonly ExtractedEntity[], kind: string, qn: string): ExtractedEntity | undefined {
  return es.find((e) => e.kind === kind && e.qualifiedName === qn);
}

function edgesFrom(out: ExtractorOutput, fromId: string): ExtractedEdge[] {
  return out.edges.filter((e) => e.from === fromId);
}

const PKG = "users";

describe("Go extractor — GO-1 file structure + top-level declarations", () => {
  it("emits a Module entity for the package", async () => {
    const out = await runOn("go/01-basic/users.go");
    const mod = find(out.entities, "Module", PKG);
    expect(mod).toBeDefined();
    expect(mod?.attrs?.is_package).toBe(true);
    expect(mod?.attrs?.package_name).toBe(PKG);
  });

  it("emits IMPORTS edges for plain, named, dot, and blank imports", async () => {
    const out = await runOn("go/01-basic/users.go");
    const imports = out.edges.filter((e) => e.relationship === "IMPORTS");
    expect(imports.find((e) => e.to === "go:use:fmt")).toBeDefined();
    expect(imports.find((e) => e.to === "go:use:io")).toBeDefined();
    const named = imports.find((e) => e.to === "go:use:io/ioutil");
    expect(named?.meta?.alias).toBe("myio");
    const dot = imports.find((e) => e.to === "go:use:errors");
    expect(dot?.meta?.dot).toBe(true);
    const blank = imports.find((e) => e.to === "go:use:github.com/lib/pq");
    expect(blank?.meta?.blank).toBe(true);
  });

  it("emits Struct / Interface / TypeAlias entities for type declarations", async () => {
    const out = await runOn("go/01-basic/users.go");
    expect(find(out.entities, "Struct", `${PKG}.User`)).toBeDefined();
    expect(find(out.entities, "Struct", `${PKG}.Group`)).toBeDefined();
    expect(find(out.entities, "Struct", `${PKG}.Embeddable`)).toBeDefined();
    expect(find(out.entities, "Struct", `${PKG}.GroupRef`)).toBeDefined();
    expect(find(out.entities, "Interface", `${PKG}.Repository`)).toBeDefined();
  });

  it("distinguishes alias vs defined-type vs function-typed alias", async () => {
    const out = await runOn("go/01-basic/users.go");
    const idAlias = find(out.entities, "TypeAlias", `${PKG}.ID`)!;
    expect(idAlias.attrs?.is_alias).toBe(true);
    const nameDef = find(out.entities, "TypeAlias", `${PKG}.Name`)!;
    expect(nameDef.attrs?.is_defined_type).toBe(true);
    expect(nameDef.attrs?.underlying_type).toBe("string");
    const xform = find(out.entities, "TypeAlias", `${PKG}.Transform`)!;
    expect(xform.attrs?.delegate).toBe(true);
  });

  it("emits Function entities at package scope", async () => {
    const out = await runOn("go/01-basic/users.go");
    const fn = find(out.entities, "Function", `${PKG}.NewUser`)!;
    expect(fn).toBeDefined();
    expect(fn.attrs?.owner_qualified_name).toBe(PKG);
    expect(fn.attrs?.is_definition).toBe(true);
  });

  it("emits Method entities with pointer / value receivers", async () => {
    const out = await runOn("go/01-basic/users.go");
    const walk = find(out.entities, "Method", `${PKG}.User.Walk`)!;
    expect(walk.attrs?.owner_qualified_name).toBe(`${PKG}.User`);
    expect(walk.attrs?.pointer_receiver).toBe(true);
    expect(walk.attrs?.receiver_name).toBe("u");
    const greet = find(out.entities, "Method", `${PKG}.User.Greet`)!;
    expect(greet.attrs?.pointer_receiver).toBe(false);
  });

  it("emits Constant + Field for plain and grouped const declarations", async () => {
    const out = await runOn("go/01-basic/users.go");
    expect(find(out.entities, "Constant", `${PKG}.MAX`)).toBeDefined();
    expect(find(out.entities, "Constant", `${PKG}.StatusActive`)).toBeDefined();
    expect(find(out.entities, "Constant", `${PKG}.StatusBlocked`)).toBeDefined();
    const f = find(out.entities, "Field", `${PKG}.MAX`)!;
    expect(f.attrs?.is_const).toBe(true);
  });

  it("emits Field with is_package_var for package-level vars", async () => {
    const out = await runOn("go/01-basic/users.go");
    const f = find(out.entities, "Field", `${PKG}.count`)!;
    expect(f.attrs?.is_package_var).toBe(true);
    expect(f.attrs?.type_text).toBe("int");
  });
});

describe("Go extractor — GO-2 struct fields and type shapes", () => {
  it("classifies pointer fields as REFERENCES_TYPE with meta.pointer", async () => {
    const out = await runOn("go/01-basic/users.go");
    const next = find(out.entities, "Field", `${PKG}.User.Next`)!;
    expect(next.attrs?.pointer).toBe(true);
    expect(next.attrs?.owner_qualified_name).toBe(`${PKG}.User`);
    const refs = edgesFrom(out, next.id).filter((e) => e.relationship === "REFERENCES_TYPE");
    expect(refs.length).toBe(1);
    expect(refs[0]!.to).toBe("go:type:User");
    expect(refs[0]!.meta?.pointer).toBe(true);
    expect(refs[0]!.meta?.resolved).toBe(false);
  });

  it("classifies slice and array fields as CONTAINS_MANY", async () => {
    const out = await runOn("go/01-basic/users.go");
    const friends = find(out.entities, "Field", `${PKG}.User.Friends`)!;
    expect(friends.attrs?.type_shape).toBe("slice");
    const cm = edgesFrom(out, friends.id).filter((e) => e.relationship === "CONTAINS_MANY");
    expect(cm[0]!.to).toBe("go:type:User");
    expect(cm[0]!.meta?.via).toBe("slice");
    const tags = find(out.entities, "Field", `${PKG}.User.Tags`)!;
    expect(tags.attrs?.type_shape).toBe("slice");
    const idx = find(out.entities, "Field", `${PKG}.User.Index`)!;
    expect(idx.attrs?.type_shape).toBe("array");
  });

  it("classifies map fields as MAPS_K_TO_V with key_type meta", async () => {
    const out = await runOn("go/01-basic/users.go");
    const lookup = find(out.entities, "Field", `${PKG}.User.Lookup`)!;
    expect(lookup.attrs?.type_shape).toBe("map");
    expect(lookup.attrs?.key_type).toBe("string");
    const mk = edgesFrom(out, lookup.id).filter((e) => e.relationship === "MAPS_K_TO_V");
    expect(mk[0]!.to).toBe("go:type:Group");
    expect(mk[0]!.meta?.key_type).toBe("string");
  });

  it("classifies channel fields with direction meta", async () => {
    const out = await runOn("go/01-basic/users.go");
    const events = find(out.entities, "Field", `${PKG}.User.Events`)!;
    expect(events.attrs?.type_shape).toBe("channel");
    expect(events.attrs?.channel_direction).toBe("both");
    const inbound = find(out.entities, "Field", `${PKG}.User.Inbound`)!;
    expect(inbound.attrs?.channel_direction).toBe("recv");
    const outbound = find(out.entities, "Field", `${PKG}.User.Outbound`)!;
    expect(outbound.attrs?.channel_direction).toBe("send");
  });

  it("classifies function-typed fields as EMBEDS via function_value", async () => {
    const out = await runOn("go/01-basic/users.go");
    const onLogin = find(out.entities, "Field", `${PKG}.User.OnLogin`)!;
    expect(onLogin.attrs?.type_shape).toBe("function");
    const emb = edgesFrom(out, onLogin.id).filter((e) => e.relationship === "EMBEDS");
    expect(emb[0]!.meta?.via).toBe("function_value");
  });

  it("classifies inline anonymous struct fields without resolvable target", async () => {
    const out = await runOn("go/01-basic/users.go");
    const profile = find(out.entities, "Field", `${PKG}.User.Profile`)!;
    expect(profile.attrs?.type_shape).toBe("struct_value");
    const emb = edgesFrom(out, profile.id).filter((e) => e.relationship === "EMBEDS");
    expect(emb.length).toBe(0);
  });

  it("emits embedded field + EMBEDS edge for value and pointer embedding", async () => {
    const out = await runOn("go/01-basic/users.go");
    const emb = find(out.entities, "Field", `${PKG}.User.Embeddable`)!;
    expect(emb.attrs?.is_embedded).toBe(true);
    expect(emb.attrs?.pointer).toBeUndefined();
    const embPtr = find(out.entities, "Field", `${PKG}.User.GroupRef`)!;
    expect(embPtr.attrs?.is_embedded).toBe(true);
    expect(embPtr.attrs?.pointer).toBe(true);

    const userStructId = find(out.entities, "Struct", `${PKG}.User`)!.id;
    const embedEdges = edgesFrom({ entities: [], edges: out.edges, shapes: [], diagnostics: [] }, userStructId)
      .filter((e) => e.relationship === "EMBEDS" && e.meta?.via === "embedded");
    const tos = embedEdges.map((e) => e.to);
    expect(tos).toContain("go:type:Embeddable");
    expect(tos).toContain("go:type:GroupRef");
    const ptrEdge = embedEdges.find((e) => e.to === "go:type:GroupRef")!;
    expect(ptrEdge.meta?.pointer).toBe(true);
  });

  it("parses struct field tags into attrs.tags", async () => {
    const out = await runOn("go/01-basic/users.go");
    const id = find(out.entities, "Field", `${PKG}.User.ID`)!;
    expect(id.attrs?.tags).toEqual({ json: "id", db: "id" });
    const next = find(out.entities, "Field", `${PKG}.User.Next`)!;
    expect(next.attrs?.tags).toEqual({ json: "-" });
  });
});

describe("Go extractor — GO-3 interface members + embedding", () => {
  it("emits Method entities for interface method specs", async () => {
    const out = await runOn("go/01-basic/users.go");
    const get = find(out.entities, "Method", `${PKG}.Repository.Get`)!;
    expect(get.attrs?.owner_qualified_name).toBe(`${PKG}.Repository`);
    expect(get.attrs?.is_abstract).toBe(true);
    expect(get.attrs?.is_definition).toBe(false);
    expect(Array.isArray(get.attrs?.parameter_types)).toBe(true);
    expect(Array.isArray(get.attrs?.return_types)).toBe(true);
  });

  it("emits EXTENDS edge for embedded interfaces", async () => {
    const out = await runOn("go/01-basic/users.go");
    const repo = find(out.entities, "Interface", `${PKG}.Repository`)!;
    const ext = edgesFrom(out, repo.id).filter((e) => e.relationship === "EXTENDS");
    expect(ext.length).toBe(1);
    expect(ext[0]!.to).toBe("go:type:Closer");
    expect(ext[0]!.meta?.via).toBe("interface_embedding");
  });

  it("Go extractor emits no HAS_ANNOTATION edges (Go has no annotations)", async () => {
    const out = await runOn("go/01-basic/users.go");
    const anns = out.edges.filter((e) => e.relationship === "HAS_ANNOTATION");
    expect(anns.length).toBe(0);
  });
});
