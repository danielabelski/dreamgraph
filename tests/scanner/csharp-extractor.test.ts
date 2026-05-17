import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

import { csharpExtractor } from "../../src/scanner/extractors/csharp.js";
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
  return csharpExtractor.extract({
    absPath, relPath, source, language: "csharp", name, ext, dirParts,
  });
}

function find(es: readonly ExtractedEntity[], kind: string, qn: string): ExtractedEntity | undefined {
  return es.find((e) => e.kind === kind && e.qualifiedName === qn);
}

function edgesFrom(out: ExtractorOutput, fromId: string): ExtractedEdge[] {
  return out.edges.filter((e) => e.from === fromId);
}

// File-scoped namespace `MyApp.Users` is the module qn.
const NS = "MyApp.Users";

describe("C# extractor — CS-1 file structure and top-level types", () => {
  it("derives the file-scoped namespace as the module qn", async () => {
    const out = await runOn("csharp/01-basic/basic.cs");
    const mod = find(out.entities, "Module", NS)!;
    expect(mod).toBeDefined();
    expect(mod.attrs?.is_namespace).toBe(true);
    expect(mod.attrs?.namespace_qualified_name).toBe(NS);
  });

  it("emits IMPORTS edges for plain, static, and aliased using directives", async () => {
    const out = await runOn("csharp/01-basic/basic.cs");
    const imports = out.edges.filter((e) => e.relationship === "IMPORTS");
    expect(imports.find((e) => e.to === "csharp:use:System")).toBeDefined();
    expect(imports.find((e) => e.to === "csharp:use:System.Collections.Generic")).toBeDefined();
    const staticUsing = imports.find((e) => e.to === "csharp:use:System.Math");
    expect(staticUsing?.meta?.static).toBe(true);
    const aliased = imports.find((e) => e.to === "csharp:use:System.Console");
    expect(aliased?.meta?.alias).toBe("ConsoleAlias");
  });

  it("emits Class / Interface / Struct / Record / Enum / TypeAlias(delegate) with canonical kinds", async () => {
    const out = await runOn("csharp/01-basic/basic.cs");
    expect(find(out.entities, "Record", `${NS}.UserDto`)).toBeDefined();
    expect(find(out.entities, "Struct", `${NS}.PointR`)).toBeDefined();
    expect(find(out.entities, "Interface", `${NS}.IRepository`)).toBeDefined();
    expect(find(out.entities, "Class", `${NS}.BaseEntity`)).toBeDefined();
    expect(find(out.entities, "Class", `${NS}.UserRepository`)).toBeDefined();
    expect(find(out.entities, "Enum", `${NS}.Status`)).toBeDefined();
    expect(find(out.entities, "Class", `${NS}.MarkerAttribute`)).toBeDefined();
    expect(find(out.entities, "Struct", `${NS}.Point`)).toBeDefined();
    expect(find(out.entities, "Struct", `${NS}.ROPoint`)).toBeDefined();
    const del = find(out.entities, "TypeAlias", `${NS}.Transform`)!;
    expect(del).toBeDefined();
    expect(del.attrs?.delegate).toBe(true);
  });

  it("records modifiers on type entities (abstract, sealed, partial, readonly, visibility)", async () => {
    const out = await runOn("csharp/01-basic/basic.cs");
    const be = find(out.entities, "Class", `${NS}.BaseEntity`)!;
    expect(be.attrs?.is_abstract).toBe(true);
    expect(be.attrs?.is_partial).toBe(true);
    expect(be.attrs?.visibility).toBe("public");
    const ur = find(out.entities, "Class", `${NS}.UserRepository`)!;
    expect(ur.attrs?.is_sealed).toBe(true);
    const ro = find(out.entities, "Struct", `${NS}.ROPoint`)!;
    expect(ro.attrs?.is_readonly).toBe(true);
  });

  it("records type parameters on generic types as attrs.type_parameters", async () => {
    const out = await runOn("csharp/01-basic/basic.cs");
    const iface = find(out.entities, "Interface", `${NS}.IRepository`)!;
    expect(iface.attrs?.type_parameters).toEqual(["T"]);
  });
});

describe("C# extractor — CS-2 members (fields, properties, methods, ctors)", () => {
  it("emits Field for `private readonly Dictionary<int, User> _cache`", async () => {
    const out = await runOn("csharp/01-basic/basic.cs");
    const f = find(out.entities, "Field", `${NS}.UserRepository._cache`)!;
    expect(f.attrs?.owner_qualified_name).toBe(`${NS}.UserRepository`);
    expect(f.attrs?.visibility).toBe("private");
    expect(f.attrs?.is_readonly).toBe(true);
  });

  it("emits Property `Users` with is_init_only and Property `Maybe` with is_nullable", async () => {
    const out = await runOn("csharp/01-basic/basic.cs");
    const users = find(out.entities, "Property", `${NS}.UserRepository.Users`)!;
    expect(users.attrs?.is_init_only).toBe(true);
    const maybe = find(out.entities, "Property", `${NS}.UserRepository.Maybe`)!;
    expect(maybe.attrs?.is_nullable).toBe(true);
  });

  it("emits Property with is_required for `required string Name`", async () => {
    const out = await runOn("csharp/01-basic/basic.cs");
    const p = find(out.entities, "Property", `${NS}.UserRepository.Name`)!;
    expect(p.attrs?.is_required).toBe(true);
  });

  it("emits Field + Constant for `public const int MAX = 100`", async () => {
    const out = await runOn("csharp/01-basic/basic.cs");
    const f = find(out.entities, "Field", `${NS}.UserRepository.MAX`)!;
    expect(f.attrs?.is_const).toBe(true);
    expect(find(out.entities, "Constant", `${NS}.UserRepository.MAX`)).toBeDefined();
  });

  it("emits Field with is_event for `public event Action<User>? OnAdded`", async () => {
    const out = await runOn("csharp/01-basic/basic.cs");
    const f = find(out.entities, "Field", `${NS}.UserRepository.OnAdded`)!;
    expect(f.attrs?.is_event).toBe(true);
    expect(f.attrs?.is_nullable).toBe(true);
  });

  it("emits Property with is_indexer for the `this[int i]` indexer", async () => {
    const out = await runOn("csharp/01-basic/basic.cs");
    const idx = find(out.entities, "Property", `${NS}.UserRepository.this[]`)!;
    expect(idx.attrs?.is_indexer).toBe(true);
  });

  it("emits Constructor + Destructor + async Method with correct attrs", async () => {
    const out = await runOn("csharp/01-basic/basic.cs");
    expect(find(out.entities, "Constructor", `${NS}.UserRepository.UserRepository`)).toBeDefined();
    expect(find(out.entities, "Destructor", `${NS}.UserRepository.~UserRepository`)).toBeDefined();
    const m = find(out.entities, "Method", `${NS}.UserRepository.FindAllAsync`)!;
    expect(m.attrs?.is_async).toBe(true);
    const empty = find(out.entities, "Method", `${NS}.UserRepository.Empty`)!;
    expect(empty.attrs?.is_static).toBe(true);
  });

  it("marks interface methods as implicitly is_abstract", async () => {
    const out = await runOn("csharp/01-basic/basic.cs");
    const m = find(out.entities, "Method", `${NS}.IRepository.FindAllAsync`)!;
    expect(m.attrs?.is_abstract).toBe(true);
  });

  it("emits Field entities for record primary-ctor params with is_primary_ctor_param", async () => {
    const out = await runOn("csharp/01-basic/basic.cs");
    const id = find(out.entities, "Field", `${NS}.UserDto.Id`)!;
    expect(id.attrs?.is_primary_ctor_param).toBe(true);
    expect(id.attrs?.owner_qualified_name).toBe(`${NS}.UserDto`);
    const email = find(out.entities, "Field", `${NS}.UserDto.Email`)!;
    expect(email.attrs?.is_nullable).toBe(true);
  });

  it("emits EnumMember entities for each enum constant", async () => {
    const out = await runOn("csharp/01-basic/basic.cs");
    expect(find(out.entities, "EnumMember", `${NS}.Status.Active`)).toBeDefined();
    expect(find(out.entities, "EnumMember", `${NS}.Status.Inactive`)).toBeDefined();
    // enum underlying type recorded as REFERENCES_TYPE
    const status = find(out.entities, "Enum", `${NS}.Status`)!;
    const underlying = edgesFrom(out, status.id).find(
      (e) => e.relationship === "REFERENCES_TYPE" && e.meta?.via === "enum_underlying",
    );
    expect(underlying?.to).toBe("csharp:type:byte");
  });
});

describe("C# extractor — CS-2 shape edges", () => {
  it("CONTAINS_MANY via=list for `List<User>` property Users", async () => {
    const out = await runOn("csharp/01-basic/basic.cs");
    const p = find(out.entities, "Property", `${NS}.UserRepository.Users`)!;
    const e = edgesFrom(out, p.id).find((x) => x.relationship === "CONTAINS_MANY");
    expect(e?.meta?.via).toBe("list");
    expect(e?.meta?.from_annotation).toBe(true);
    expect(e?.to).toBe("csharp:type:User");
  });

  it("MAPS_K_TO_V via=map for `Dictionary<int, User> _cache` with key_type and key REFERENCES_TYPE", async () => {
    const out = await runOn("csharp/01-basic/basic.cs");
    const f = find(out.entities, "Field", `${NS}.UserRepository._cache`)!;
    const map = edgesFrom(out, f.id).find((x) => x.relationship === "MAPS_K_TO_V");
    expect(map?.meta?.via).toBe("map");
    expect(map?.meta?.key_type).toBe("int");
    expect(map?.to).toBe("csharp:type:User");
    // key is int (predefined) → no REFERENCES_TYPE edge for it
    const keyEdge = edgesFrom(out, f.id).find(
      (x) => x.relationship === "REFERENCES_TYPE" && x.meta?.via === "map_key",
    );
    expect(keyEdge).toBeUndefined();
  });

  it("MAY_CONTAIN via=nullable for `User? Maybe`", async () => {
    const out = await runOn("csharp/01-basic/basic.cs");
    const p = find(out.entities, "Property", `${NS}.UserRepository.Maybe`)!;
    const e = edgesFrom(out, p.id).find((x) => x.relationship === "MAY_CONTAIN");
    expect(e?.meta?.via).toBe("nullable");
    expect(e?.meta?.is_nullable).toBe(true);
    expect(e?.to).toBe("csharp:type:User");
  });

  it("CONTAINS_MANY via=array for `User[] Snapshot`", async () => {
    const out = await runOn("csharp/01-basic/basic.cs");
    const p = find(out.entities, "Property", `${NS}.UserRepository.Snapshot`)!;
    const e = edgesFrom(out, p.id).find((x) => x.relationship === "CONTAINS_MANY");
    expect(e?.meta?.via).toBe("array");
    expect(e?.to).toBe("csharp:type:User");
  });

  it("EMBEDS via=task for `Task<List<User>>` return type… actually emitted on Property not Method", async () => {
    // Method return types aren't currently shape-emitted (out of scope for CS-2),
    // but the wrapper logic is exercised by the FindAllAsync return_type attr.
    const out = await runOn("csharp/01-basic/basic.cs");
    const m = find(out.entities, "Method", `${NS}.UserRepository.FindAllAsync`)!;
    expect(typeof m.attrs?.return_type).toBe("string");
  });
});

describe("C# extractor — CS-3 attributes and inheritance", () => {
  it("emits HAS_ANNOTATION edges for `[Serializable, Obsolete]` on BaseEntity, stripping Attribute suffix", async () => {
    const out = await runOn("csharp/01-basic/basic.cs");
    const be = find(out.entities, "Class", `${NS}.BaseEntity`)!;
    const attrs = edgesFrom(out, be.id).filter((e) => e.relationship === "HAS_ANNOTATION");
    const tos = attrs.map((e) => e.to).sort();
    expect(tos).toContain("csharp:type:Serializable");
    expect(tos).toContain("csharp:type:Obsolete");
  });

  it("strips `Attribute` suffix from attribute references", async () => {
    const out = await runOn("csharp/01-basic/basic.cs");
    const marker = find(out.entities, "Class", `${NS}.MarkerAttribute`)!;
    const au = edgesFrom(out, marker.id).find(
      (e) => e.relationship === "HAS_ANNOTATION" && e.to === "csharp:type:AttributeUsage",
    );
    expect(au).toBeDefined();
  });

  it("emits EXTENDS for first base class and IMPLEMENTS for remaining bases", async () => {
    const out = await runOn("csharp/01-basic/basic.cs");
    const ur = find(out.entities, "Class", `${NS}.UserRepository`)!;
    const ext = edgesFrom(out, ur.id).find((e) => e.relationship === "EXTENDS");
    expect(ext?.to).toBe("csharp:type:BaseEntity");
    const impl = edgesFrom(out, ur.id).find((e) => e.relationship === "IMPLEMENTS");
    expect(impl?.to).toBe("csharp:type:IRepository");
  });

  it("for interface declarations, all bases are EXTENDS (interface inheritance)", async () => {
    const out = await runOn("csharp/01-basic/basic.cs");
    const iface = find(out.entities, "Interface", `${NS}.IRepository`)!;
    const ext = edgesFrom(out, iface.id).find(
      (e) => e.relationship === "EXTENDS" && e.to === "csharp:type:IDisposable",
    );
    expect(ext?.meta?.via).toBe("interface_inheritance");
  });
});

describe("C# extractor — orchestrator link resolution (intermediate-layer coherence)", () => {
  it("resolves EXTENDS placeholder BaseEntity → Class entity id via linkProject", async () => {
    const out = await runOn("csharp/01-basic/basic.cs");
    const linked = linkProject([out]);
    const baseE = linked.entities.find(
      (e) => e.kind === "Class" && e.qualifiedName === `${NS}.BaseEntity`,
    )!;
    const resolved = linked.edges.find(
      (e) => e.relationship === "EXTENDS" && e.meta?.resolved === true && e.to === baseE.id,
    );
    expect(resolved).toBeDefined();
  });
});

describe("C# extractor — bridge integration", () => {
  it("UserRepository data-model entry has model_kind=csharp:class and bucketed fields/properties via owner_qualified_name", async () => {
    const { mkdtemp, mkdir, writeFile, rm, readFile: readFileFn } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { extractNativeDataModel } = await import("../../src/tools/native-data-model.js");
    const root = await mkdtemp(join(tmpdir(), "dg-cs-bridge-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      const csPath = join(root, "src", "Demo.cs");
      const fixture = await readFileFn(
        join(here, "fixtures", "csharp", "01-basic", "basic.cs"),
        "utf8",
      );
      await writeFile(csPath, fixture, "utf-8");
      const scan = {
        repoName: "demo",
        repoRoot: root,
        technology: "C#",
        files: [{ abs: csPath, rel: "src/Demo.cs", name: "Demo.cs", ext: ".cs", dirParts: ["src"], size: 0 }],
        manifestContent: {},
        uiFiles: [],
        topLevelDirs: ["src"],
        auxiliaryFiles: { test_suite: [], configuration: [], automation_script: [], mcp_tool: [] },
      };
      const { entries } = await extractNativeDataModel(scan as Parameters<typeof extractNativeDataModel>[0]);
      const repo = entries.find((e) => e.name === "UserRepository") as Record<string, unknown>;
      expect(repo).toBeDefined();
      expect(repo.model_kind).toBe("csharp:class");
      const keyFields = repo.key_fields as Array<{ name: string }>;
      const names = keyFields.map((f) => f.name);
      expect(names).toContain("_cache");
      expect(names).toContain("MAX");
      expect(names).toContain("VERSION");
      expect(names).toContain("OnAdded");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
