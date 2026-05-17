import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

import { kotlinExtractor } from "../../src/scanner/extractors/kotlin.js";
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
  return kotlinExtractor.extract({
    absPath, relPath, source, language: "kotlin", name, ext, dirParts,
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

describe("Kotlin extractor — KT-1 top-level declarations", () => {
  it("emits Package + Class/Interface/Enum/Annotation entities with canonical kinds", async () => {
    const out = await runOn("kotlin/01-basic/basic.kt");
    expect(find(out.entities, "Package", "com.example.app")).toBeDefined();
    expect(find(out.entities, "Class", "com.example.app.User")).toBeDefined();
    expect(find(out.entities, "Interface", "com.example.app.Event")).toBeDefined();
    expect(find(out.entities, "Interface", "com.example.app.Repository")).toBeDefined();
    expect(find(out.entities, "Class", "com.example.app.UserRepository")).toBeDefined();
    expect(find(out.entities, "Enum", "com.example.app.Status")).toBeDefined();
    expect(find(out.entities, "Annotation", "com.example.app.Audit")).toBeDefined();
  });

  it("emits Class with is_data_class for `data class` and is_sealed for `sealed interface`", async () => {
    const out = await runOn("kotlin/01-basic/basic.kt");
    const user = find(out.entities, "Class", "com.example.app.User")!;
    expect(user.attrs?.is_data_class).toBe(true);
    const event = find(out.entities, "Interface", "com.example.app.Event")!;
    expect(event.attrs?.is_sealed).toBe(true);
  });

  it("emits IMPORTS edges for single-type and wildcard imports", async () => {
    const out = await runOn("kotlin/01-basic/basic.kt");
    const imports = out.edges.filter((e) => e.relationship === "IMPORTS");
    expect(imports.find((e) => e.to === "kotlin:type:List")).toBeDefined();
    expect(imports.find((e) => e.to === "kotlin:type:Flow")).toBeDefined();
    const wildcard = imports.find((e) => e.to === "kotlin:use:com.example.legacy.*");
    expect(wildcard).toBeDefined();
    expect(wildcard!.meta?.wildcard).toBe(true);
  });

  it("emits a top-level object as Class with is_object attr and a nested object inside sealed interface", async () => {
    const out = await runOn("kotlin/01-basic/basic.kt");
    const cfg = find(out.entities, "Class", "com.example.app.AppConfig")!;
    expect(cfg.attrs?.is_object).toBe(true);
    const closed = find(out.entities, "Class", "com.example.app.Event.Closed")!;
    expect(closed.attrs?.is_object).toBe(true);
  });

  it("emits a companion object as Class with is_companion and is_object", async () => {
    const out = await runOn("kotlin/01-basic/basic.kt");
    const comp = find(out.entities, "Class", "com.example.app.User.Companion")!;
    expect(comp.attrs?.is_companion).toBe(true);
    expect(comp.attrs?.is_object).toBe(true);
  });

  it("emits EnumMember entities for each enum constant", async () => {
    const out = await runOn("kotlin/01-basic/basic.kt");
    expect(find(out.entities, "EnumMember", "com.example.app.Status.ACTIVE")).toBeDefined();
    expect(find(out.entities, "EnumMember", "com.example.app.Status.INACTIVE")).toBeDefined();
  });
});

describe("Kotlin extractor — KT-2 fields, properties, shapes", () => {
  it("emits a Field entity for each primary-constructor property with owner_qualified_name", async () => {
    const out = await runOn("kotlin/01-basic/basic.kt");
    const id = find(out.entities, "Field", "com.example.app.User.id")!;
    expect(id.attrs?.is_primary_constructor_property).toBe(true);
    expect(id.attrs?.owner_qualified_name).toBe("com.example.app.User");
    const email = find(out.entities, "Field", "com.example.app.User.email")!;
    expect(email.attrs?.is_nullable).toBe(true);
  });

  it("emits CONTAINS_MANY via=mutable_list for MutableList<User> primary-constructor property", async () => {
    const out = await runOn("kotlin/01-basic/basic.kt");
    const f = find(out.entities, "Field", "com.example.app.UserRepository.users")!;
    const e = edgesFrom(out, f.id).find((x) => x.relationship === "CONTAINS_MANY");
    expect(e?.meta?.via).toBe("mutable_list");
    expect(e?.to).toBe("kotlin:type:User");
  });

  it("emits MAPS_K_TO_V via=map with key_type for Map<Long, User>", async () => {
    const out = await runOn("kotlin/01-basic/basic.kt");
    const f = find(out.entities, "Field", "com.example.app.UserRepository.cache")!;
    const e = edgesFrom(out, f.id).find((x) => x.relationship === "MAPS_K_TO_V");
    expect(e?.meta?.via).toBe("map");
    expect(e?.meta?.key_type).toBe("Long");
    expect(e?.to).toBe("kotlin:type:User");
  });

  it("emits CONTAINS_MANY via=state_flow for nullable StateFlow<User>?", async () => {
    const out = await runOn("kotlin/01-basic/basic.kt");
    const f = find(out.entities, "Field", "com.example.app.UserRepository.state")!;
    expect(f.attrs?.is_nullable).toBe(true);
    const e = edgesFrom(out, f.id).find((x) => x.relationship === "CONTAINS_MANY");
    expect(e?.meta?.via).toBe("state_flow");
    expect(e?.meta?.is_nullable).toBe(true);
    expect(e?.to).toBe("kotlin:type:User");
  });

  it("emits MAY_CONTAIN via=optional for Optional<User>", async () => {
    const out = await runOn("kotlin/01-basic/basic.kt");
    const f = find(out.entities, "Field", "com.example.app.UserRepository.maybe")!;
    const e = edgesFrom(out, f.id).find((x) => x.relationship === "MAY_CONTAIN");
    expect(e?.meta?.via).toBe("optional");
    expect(e?.to).toBe("kotlin:type:User");
  });

  it("emits a Constant entity for `const val MAX_NAME = 100` and `const val VERSION`", async () => {
    const out = await runOn("kotlin/01-basic/basic.kt");
    expect(find(out.entities, "Constant", "com.example.app.User.Companion.MAX_NAME")).toBeDefined();
    expect(find(out.entities, "Constant", "com.example.app.AppConfig.VERSION")).toBeDefined();
  });

  it("emits a Primary Constructor entity with owner_qualified_name", async () => {
    const out = await runOn("kotlin/01-basic/basic.kt");
    const ctor = out.entities.find((e) =>
      e.kind === "Constructor" &&
      e.qualifiedName === "com.example.app.User.<init>",
    );
    expect(ctor).toBeDefined();
    expect(ctor!.attrs?.is_primary).toBe(true);
    expect(ctor!.attrs?.owner_qualified_name).toBe("com.example.app.User");
  });

  it("emits a top-level Function entity for `fun topLevelHelper` (no owning class)", async () => {
    const out = await runOn("kotlin/01-basic/basic.kt");
    const fn = out.entities.find((e) =>
      e.kind === "Function" &&
      e.qualifiedName === "com.example.app.topLevelHelper",
    );
    expect(fn).toBeDefined();
    expect(fn!.attrs?.is_top_level).toBe(true);
    expect(fn!.attrs?.is_extension).toBe(false);
  });

  it("emits a Function with is_extension + receiver_type + REFERENCES_TYPE edge for extension fun", async () => {
    const out = await runOn("kotlin/01-basic/basic.kt");
    const fn = out.entities.find((e) =>
      e.kind === "Function" &&
      e.qualifiedName === "com.example.app.titleCase",
    )!;
    expect(fn.attrs?.is_extension).toBe(true);
    expect(fn.attrs?.receiver_type).toBe("String");
    const e = edgesFrom(out, fn.id).find((x) => x.relationship === "REFERENCES_TYPE" && x.meta?.via === "extension_receiver");
    expect(e?.to).toBe("kotlin:type:String");
  });

  it("emits a Method with is_suspend + is_override for `override suspend fun findAll`", async () => {
    const out = await runOn("kotlin/01-basic/basic.kt");
    const m = out.entities.find((e) =>
      e.kind === "Method" &&
      e.qualifiedName === "com.example.app.UserRepository.findAll",
    )!;
    expect(m.attrs?.is_suspend).toBe(true);
    expect(m.attrs?.is_override).toBe(true);
  });
});

describe("Kotlin extractor — KT-3 inheritance and annotations", () => {
  it("emits IMPLEMENTS edge for `class UserRepository(...) : Repository<User>`", async () => {
    const out = await runOn("kotlin/01-basic/basic.kt");
    const cls = find(out.entities, "Class", "com.example.app.UserRepository")!;
    const e = edgesFrom(out, cls.id).find((x) => x.relationship === "IMPLEMENTS");
    expect(e?.to).toBe("kotlin:type:Repository");
  });

  it("emits IMPLEMENTS edge for nested `data class Click(...) : Event`", async () => {
    const out = await runOn("kotlin/01-basic/basic.kt");
    const click = find(out.entities, "Class", "com.example.app.Event.Click")!;
    const e = edgesFrom(out, click.id).find((x) => x.relationship === "IMPLEMENTS");
    expect(e?.to).toBe("kotlin:type:Event");
  });

  it("emits HAS_ANNOTATION edge for @Serializable on data class and @Component on class", async () => {
    const out = await runOn("kotlin/01-basic/basic.kt");
    const user = find(out.entities, "Class", "com.example.app.User")!;
    const ser = edgesFrom(out, user.id).find((x) => x.relationship === "HAS_ANNOTATION");
    expect(ser?.to).toBe("kotlin:type:Serializable");
    const repo = find(out.entities, "Class", "com.example.app.UserRepository")!;
    const comp = edgesFrom(out, repo.id).find((x) => x.relationship === "HAS_ANNOTATION");
    expect(comp?.to).toBe("kotlin:type:Component");
  });
});

describe("Kotlin extractor — orchestrator link resolution (intermediate-layer coherence)", () => {
  it("resolves IMPLEMENTS placeholder Repository → Interface entity id via linkProject", async () => {
    const out = await runOn("kotlin/01-basic/basic.kt");
    const linked = linkProject([out]);
    const repoIface = linked.entities.find(
      (e) => e.kind === "Interface" && e.qualifiedName === "com.example.app.Repository",
    )!;
    const resolved = linked.edges.find(
      (e) => e.relationship === "IMPLEMENTS" && e.meta?.resolved === true && e.to === repoIface.id,
    );
    expect(resolved).toBeDefined();
  });

  it("emits Annotation entity for `annotation class Audit` (locally defined)", async () => {
    const out = await runOn("kotlin/01-basic/basic.kt");
    const linked = linkProject([out]);
    const audit = linked.entities.find(
      (e) => e.kind === "Annotation" && e.qualifiedName === "com.example.app.Audit",
    );
    expect(audit).toBeDefined();
  });
});

// Bridge integration: prove that Kotlin entities flow through the
// data-model bridge with the same shape as Java/C++ entries.
describe("Kotlin extractor — bridge integration", () => {
  it("Class data-model entries carry correct model_kind and key_fields buckets via owner_qualified_name", async () => {
    const { mkdtemp, mkdir, writeFile, rm, readFile: readFileFn } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { extractNativeDataModel } = await import("../../src/tools/native-data-model.js");
    const root = await mkdtemp(join((await import("node:os")).tmpdir(), "dg-kt-bridge-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      const ktPath = join(root, "src", "demo.kt");
      const fixture = await readFileFn(
        join(here, "fixtures", "kotlin", "01-basic", "basic.kt"),
        "utf8",
      );
      await writeFile(ktPath, fixture, "utf-8");
      const scan = {
        repoName: "demo",
        repoRoot: root,
        technology: "Kotlin",
        files: [{ abs: ktPath, rel: "src/demo.kt", name: "demo.kt", ext: ".kt", dirParts: ["src"], size: 0 }],
        manifestContent: {},
        uiFiles: [],
        topLevelDirs: ["src"],
        auxiliaryFiles: { test_suite: [], configuration: [], automation_script: [], mcp_tool: [] },
      };
      const { entries } = await extractNativeDataModel(scan as Parameters<typeof extractNativeDataModel>[0]);
      const repo = entries.find((e) => e.name === "UserRepository") as Record<string, unknown>;
      expect(repo).toBeDefined();
      expect(repo.model_kind).toBe("kotlin:class");
      const keyFields = repo.key_fields as Array<{ name: string }>;
      const names = keyFields.map((f) => f.name).sort();
      expect(names).toContain("users");
      expect(names).toContain("cache");
      expect(names).toContain("state");
      void tmpdir; void mkdtemp; void rm;
    } finally {
      await (await import("node:fs/promises")).rm(root, { recursive: true, force: true });
    }
  });
});
