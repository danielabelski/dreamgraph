import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

import { pythonExtractor } from "../../src/scanner/extractors/python.js";
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
  return pythonExtractor.extract({
    absPath, relPath, source, language: "python", name, ext, dirParts,
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

// Fixture path = "python/01-basic/basic.py"; dirParts therefore =
// ["python", "01-basic"]. Module qn = "python.01-basic.basic".
const MOD = "python.01-basic.basic";

describe("Python extractor — PY-1 top-level declarations", () => {
  it("emits Module + Class/Interface/Enum entities with canonical kinds", async () => {
    const out = await runOn("python/01-basic/basic.py");
    expect(find(out.entities, "Module", MOD)).toBeDefined();
    expect(find(out.entities, "Class", `${MOD}.User`)).toBeDefined();
    expect(find(out.entities, "Interface", `${MOD}.Repository`)).toBeDefined();
    expect(find(out.entities, "Class", `${MOD}.UserRepository`)).toBeDefined();
    expect(find(out.entities, "Class", `${MOD}.AbstractGateway`)).toBeDefined();
    expect(find(out.entities, "Enum", `${MOD}.Status`)).toBeDefined();
  });

  it("emits Class with is_dataclass for `@dataclass class User`", async () => {
    const out = await runOn("python/01-basic/basic.py");
    const user = find(out.entities, "Class", `${MOD}.User`)!;
    expect(user.attrs?.is_dataclass).toBe(true);
  });

  it("emits Interface with is_protocol for `class Repository(Protocol)`", async () => {
    const out = await runOn("python/01-basic/basic.py");
    const repo = find(out.entities, "Interface", `${MOD}.Repository`)!;
    expect(repo.attrs?.is_protocol).toBe(true);
  });

  it("emits Class with is_abstract for `class AbstractGateway(ABC)`", async () => {
    const out = await runOn("python/01-basic/basic.py");
    const ag = find(out.entities, "Class", `${MOD}.AbstractGateway`)!;
    expect(ag.attrs?.is_abstract).toBe(true);
  });

  it("emits IMPORTS edges for `import`, `from x import y`, aliased, and wildcard forms", async () => {
    const out = await runOn("python/01-basic/basic.py");
    const imports = out.edges.filter((e) => e.relationship === "IMPORTS");
    expect(imports.find((e) => e.to === "python:use:os")).toBeDefined();
    const aliased = imports.find((e) => e.to === "python:use:json");
    expect(aliased).toBeDefined();
    expect(aliased!.meta?.alias).toBe("j");
    expect(imports.find((e) => e.to === "python:type:List")).toBeDefined();
    expect(imports.find((e) => e.to === "python:type:Protocol")).toBeDefined();
    expect(imports.find((e) => e.to === "python:type:dataclass")).toBeDefined();
    const wildcard = imports.find((e) => e.to === "python:use:.legacy.*");
    expect(wildcard).toBeDefined();
    expect(wildcard!.meta?.wildcard).toBe(true);
    const helper = imports.find((e) => e.to === "python:type:helper");
    expect(helper).toBeDefined();
    expect(helper!.meta?.alias).toBe("h");
  });

  it("emits IMPORTS edge with from_future for `from __future__ import annotations`", async () => {
    const out = await runOn("python/01-basic/basic.py");
    const futImport = out.edges.find(
      (e) => e.relationship === "IMPORTS" && e.meta?.from_future === true,
    );
    expect(futImport).toBeDefined();
    expect(futImport!.to).toBe("python:type:annotations");
  });

  it("emits EnumMember entities for each enum constant", async () => {
    const out = await runOn("python/01-basic/basic.py");
    expect(find(out.entities, "EnumMember", `${MOD}.Status.ACTIVE`)).toBeDefined();
    expect(find(out.entities, "EnumMember", `${MOD}.Status.INACTIVE`)).toBeDefined();
  });
});

describe("Python extractor — PY-2 fields, properties, shapes (helmet: from_annotation)", () => {
  it("emits a Field entity for each annotated class-body attribute with owner_qualified_name", async () => {
    const out = await runOn("python/01-basic/basic.py");
    const id = find(out.entities, "Field", `${MOD}.User.id`)!;
    expect(id.attrs?.owner_qualified_name).toBe(`${MOD}.User`);
    expect(id.attrs?.is_annotated).toBe(true);
    const email = find(out.entities, "Field", `${MOD}.User.email`)!;
    expect(email.attrs?.is_nullable).toBe(true);
  });

  it("emits CONTAINS_MANY via=list for List[User] with from_annotation flag", async () => {
    const out = await runOn("python/01-basic/basic.py");
    const f = find(out.entities, "Field", `${MOD}.UserRepository.users`)!;
    const e = edgesFrom(out, f.id).find((x) => x.relationship === "CONTAINS_MANY");
    expect(e?.meta?.via).toBe("list");
    expect(e?.meta?.from_annotation).toBe(true);
    expect(e?.to).toBe("python:type:User");
  });

  it("emits MAPS_K_TO_V via=map for Dict[int, User] with key_type and a REFERENCES_TYPE edge for the key", async () => {
    const out = await runOn("python/01-basic/basic.py");
    const f = find(out.entities, "Field", `${MOD}.UserRepository.cache`)!;
    const mapEdge = edgesFrom(out, f.id).find((x) => x.relationship === "MAPS_K_TO_V");
    expect(mapEdge?.meta?.via).toBe("map");
    expect(mapEdge?.meta?.key_type).toBe("int");
    expect(mapEdge?.meta?.from_annotation).toBe(true);
    expect(mapEdge?.to).toBe("python:type:User");
    const keyEdge = edgesFrom(out, f.id).find(
      (x) => x.relationship === "REFERENCES_TYPE" && x.meta?.via === "map_key",
    );
    expect(keyEdge?.to).toBe("python:type:int");
  });

  it("emits MAY_CONTAIN via=optional for Optional[User]", async () => {
    const out = await runOn("python/01-basic/basic.py");
    const f = find(out.entities, "Field", `${MOD}.UserRepository.maybe`)!;
    expect(f.attrs?.is_nullable).toBe(true);
    const e = edgesFrom(out, f.id).find((x) => x.relationship === "MAY_CONTAIN");
    expect(e?.meta?.via).toBe("optional");
    expect(e?.meta?.is_nullable).toBe(true);
    expect(e?.to).toBe("python:type:User");
  });

  it("emits MAY_CONTAIN for PEP 604 `str | None` (binary union)", async () => {
    const out = await runOn("python/01-basic/basic.py");
    const f = find(out.entities, "Field", `${MOD}.User.pipe_optional`)!;
    expect(f.attrs?.is_nullable).toBe(true);
  });

  it("emits a Constant entity for module-level `MAX_USERS: int = 100`", async () => {
    const out = await runOn("python/01-basic/basic.py");
    expect(find(out.entities, "Constant", `${MOD}.MAX_USERS`)).toBeDefined();
    // also emitted as Field (annotated module-level binding)
    const fld = find(out.entities, "Field", `${MOD}.MAX_USERS`)!;
    expect(fld.attrs?.owner_qualified_name).toBe(MOD);
  });

  it("emits a Constant entity for module-level bare `DEFAULT_NAME = \"anon\"` (ALL_CAPS heuristic)", async () => {
    const out = await runOn("python/01-basic/basic.py");
    expect(find(out.entities, "Constant", `${MOD}.DEFAULT_NAME`)).toBeDefined();
    const fld = find(out.entities, "Field", `${MOD}.DEFAULT_NAME`)!;
    expect(fld.attrs?.is_annotated).toBe(false);
  });

  it("emits a Constructor entity for `__init__` (not Method)", async () => {
    const out = await runOn("python/01-basic/basic.py");
    const ctor = out.entities.find((e) =>
      e.kind === "Constructor" &&
      e.qualifiedName === `${MOD}.UserRepository.__init__`,
    );
    expect(ctor).toBeDefined();
    expect(ctor!.attrs?.owner_qualified_name).toBe(`${MOD}.UserRepository`);
  });

  it("emits a Method with is_async for `async def fetch`", async () => {
    const out = await runOn("python/01-basic/basic.py");
    const m = out.entities.find((e) =>
      e.kind === "Method" &&
      e.qualifiedName === `${MOD}.UserRepository.fetch`,
    )!;
    expect(m.attrs?.is_async).toBe(true);
  });

  it("emits a Method with is_classmethod / is_staticmethod / is_property from decorators", async () => {
    const out = await runOn("python/01-basic/basic.py");
    const cm = out.entities.find((e) => e.kind === "Method" && e.qualifiedName === `${MOD}.UserRepository.empty`)!;
    expect(cm.attrs?.is_classmethod).toBe(true);
    const sm = out.entities.find((e) => e.kind === "Method" && e.qualifiedName === `${MOD}.UserRepository.version`)!;
    expect(sm.attrs?.is_staticmethod).toBe(true);
    const pm = out.entities.find((e) => e.kind === "Method" && e.qualifiedName === `${MOD}.UserRepository.size`)!;
    expect(pm.attrs?.is_property).toBe(true);
  });

  it("synthesises a Field for `self.private_counter = 0` declared only in __init__ (is_self_assigned)", async () => {
    const out = await runOn("python/01-basic/basic.py");
    const f = find(out.entities, "Field", `${MOD}.UserRepository.private_counter`)!;
    expect(f.attrs?.is_self_assigned).toBe(true);
    expect(f.attrs?.is_annotated).toBe(false);
  });

  it("emits a top-level Function entity for `top_level_helper` and `async_helper` with is_async", async () => {
    const out = await runOn("python/01-basic/basic.py");
    const fn = out.entities.find((e) =>
      e.kind === "Function" &&
      e.qualifiedName === `${MOD}.top_level_helper`,
    )!;
    expect(fn.attrs?.is_top_level).toBe(true);
    expect(fn.attrs?.is_async).toBe(false);
    const af = out.entities.find((e) =>
      e.kind === "Function" &&
      e.qualifiedName === `${MOD}.async_helper`,
    )!;
    expect(af.attrs?.is_async).toBe(true);
  });
});

describe("Python extractor — PY-3 decorators and inheritance", () => {
  it("emits HAS_ANNOTATION edge for @dataclass on User and @classmethod on empty()", async () => {
    const out = await runOn("python/01-basic/basic.py");
    const user = find(out.entities, "Class", `${MOD}.User`)!;
    const ds = edgesFrom(out, user.id).find((x) => x.relationship === "HAS_ANNOTATION");
    expect(ds?.to).toBe("python:type:dataclass");
    expect(ds?.meta?.via).toBe("decorator");
    const empty = out.entities.find((e) =>
      e.kind === "Method" && e.qualifiedName === `${MOD}.UserRepository.empty`,
    )!;
    const cm = edgesFrom(out, empty.id).find((x) => x.relationship === "HAS_ANNOTATION");
    expect(cm?.to).toBe("python:type:classmethod");
  });

  it("emits EXTENDS edge for `UserRepository(Repository)` (skipping Protocol/ABC bases)", async () => {
    const out = await runOn("python/01-basic/basic.py");
    const ur = find(out.entities, "Class", `${MOD}.UserRepository`)!;
    const ext = edgesFrom(out, ur.id).find((x) => x.relationship === "EXTENDS");
    expect(ext?.to).toBe("python:type:Repository");
  });

  it("does NOT emit EXTENDS for the Protocol/ABC/Enum meta-bases themselves", async () => {
    const out = await runOn("python/01-basic/basic.py");
    const repo = find(out.entities, "Interface", `${MOD}.Repository`)!;
    expect(edgesFrom(out, repo.id).find((x) => x.relationship === "EXTENDS" && x.to === "python:type:Protocol")).toBeUndefined();
    const ag = find(out.entities, "Class", `${MOD}.AbstractGateway`)!;
    expect(edgesFrom(out, ag.id).find((x) => x.relationship === "EXTENDS" && x.to === "python:type:ABC")).toBeUndefined();
    const status = find(out.entities, "Enum", `${MOD}.Status`)!;
    expect(edgesFrom(out, status.id).find((x) => x.relationship === "EXTENDS" && x.to === "python:type:Enum")).toBeUndefined();
  });

  it("Protocol-class methods are implicitly is_abstract", async () => {
    const out = await runOn("python/01-basic/basic.py");
    const m = out.entities.find((e) =>
      e.kind === "Method" && e.qualifiedName === `${MOD}.Repository.find_all`,
    )!;
    expect(m.attrs?.is_abstract).toBe(true);
  });
});

describe("Python extractor — orchestrator link resolution (intermediate-layer coherence)", () => {
  it("resolves EXTENDS placeholder Repository → Interface entity id via linkProject", async () => {
    const out = await runOn("python/01-basic/basic.py");
    const linked = linkProject([out]);
    const repoIface = linked.entities.find(
      (e) => e.kind === "Interface" && e.qualifiedName === `${MOD}.Repository`,
    )!;
    const resolved = linked.edges.find(
      (e) => e.relationship === "EXTENDS" && e.meta?.resolved === true && e.to === repoIface.id,
    );
    expect(resolved).toBeDefined();
  });
});

describe("Python extractor — bridge integration", () => {
  it("UserRepository data-model entry carries model_kind=python:class and bucketed fields via owner_qualified_name", async () => {
    const { mkdtemp, mkdir, writeFile, rm, readFile: readFileFn } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { extractNativeDataModel } = await import("../../src/tools/native-data-model.js");
    const root = await mkdtemp(join(tmpdir(), "dg-py-bridge-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      const pyPath = join(root, "src", "demo.py");
      const fixture = await readFileFn(
        join(here, "fixtures", "python", "01-basic", "basic.py"),
        "utf8",
      );
      await writeFile(pyPath, fixture, "utf-8");
      const scan = {
        repoName: "demo",
        repoRoot: root,
        technology: "Python",
        files: [{ abs: pyPath, rel: "src/demo.py", name: "demo.py", ext: ".py", dirParts: ["src"], size: 0 }],
        manifestContent: {},
        uiFiles: [],
        topLevelDirs: ["src"],
        auxiliaryFiles: { test_suite: [], configuration: [], automation_script: [], mcp_tool: [] },
      };
      const { entries } = await extractNativeDataModel(scan as Parameters<typeof extractNativeDataModel>[0]);
      const repo = entries.find((e) => e.name === "UserRepository") as Record<string, unknown>;
      expect(repo).toBeDefined();
      expect(repo.model_kind).toBe("python:class");
      const keyFields = repo.key_fields as Array<{ name: string }>;
      const names = keyFields.map((f) => f.name).sort();
      expect(names).toContain("users");
      expect(names).toContain("cache");
      expect(names).toContain("maybe");
    } finally {
      await (await import("node:fs/promises")).rm(root, { recursive: true, force: true });
    }
  });
});
