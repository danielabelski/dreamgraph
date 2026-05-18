import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

import { gradleExtractor } from "../../src/scanner/extractors/gradle.js";
import { kotlinExtractor } from "../../src/scanner/extractors/kotlin.js";
import type {
  ExtractedEdge,
  ExtractedEntity,
  ExtractorOutput,
} from "../../src/scanner/types.js";

const here = dirname(fileURLToPath(import.meta.url));

async function runOn(relFixturePath: string): Promise<ExtractorOutput> {
  // Fixture paths are nested under tests/scanner/fixtures/gradle/<case>/...
  // For Gradle the module path is derived from `dirParts`, so we strip the
  // first three path segments to make the *project*-relative coordinates
  // (e.g. `app/build.gradle.kts` → dirParts=["app"], module qn=":app").
  const absPath = join(here, "fixtures", ...relFixturePath.split("/"));
  const source = await readFile(absPath, "utf8");
  const segs = relFixturePath.split("/").slice(2); // drop "gradle", "<case>"
  const relPath = segs.join("/");
  const name = segs[segs.length - 1]!;
  const ext = `.${name.split(".").pop()}`;
  const dirParts = segs.slice(0, -1);
  return gradleExtractor.extract({
    absPath, relPath, source, language: "gradle", name, ext, dirParts,
  });
}

function find(es: readonly ExtractedEntity[], kind: string, qn: string): ExtractedEntity | undefined {
  return es.find((e) => e.kind === kind && e.qualifiedName === qn);
}

function importsTo(edges: readonly ExtractedEdge[], to: string): ExtractedEdge | undefined {
  return edges.find((e) => e.relationship === "IMPORTS" && e.to === to);
}

// ---------------------------------------------------------------------------
// Dispatch: matches() predicate
// ---------------------------------------------------------------------------

describe("Gradle extractor — dispatch (G-1)", () => {
  it("matches() recognises every Gradle build/settings file regardless of extension", () => {
    const cases = [
      "build.gradle", "build.gradle.kts",
      "settings.gradle", "settings.gradle.kts",
    ];
    for (const name of cases) {
      expect(gradleExtractor.matches?.({
        name, ext: name.endsWith(".kts") ? ".kts" : ".gradle",
        rel: name, dirParts: [],
      })).toBe(true);
    }
  });

  it("matches() does NOT claim ordinary .kt or .kts source files", () => {
    expect(gradleExtractor.matches?.({
      name: "Main.kt", ext: ".kt", rel: "src/Main.kt", dirParts: ["src"],
    })).toBe(false);
    expect(gradleExtractor.matches?.({
      name: "script.kts", ext: ".kts", rel: "scripts/script.kts", dirParts: ["scripts"],
    })).toBe(false);
  });

  it("Kotlin extractor's matches() (if any) does not claim build.gradle.kts", () => {
    if (typeof kotlinExtractor.matches !== "function") return; // not present → fine
    expect(kotlinExtractor.matches({
      name: "build.gradle.kts", ext: ".kts",
      rel: "app/build.gradle.kts", dirParts: ["app"],
    })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Kotlin DSL fixtures
// ---------------------------------------------------------------------------

describe("Gradle extractor — Kotlin DSL (G-1)", () => {
  it("emits a BuildTarget with the derived module path qn (`:app`)", async () => {
    const out = await runOn("gradle/01-kotlin-dsl/app/build.gradle.kts");
    const bt = find(out.entities, "BuildTarget", ":app")!;
    expect(bt).toBeDefined();
    expect(bt.language).toBe("gradle");
    expect(bt.attrs?.module_path).toBe(":app");
    expect(bt.attrs?.dsl).toBe("kotlin");
    expect(bt.attrs?.is_gradle).toBe(true);
  });

  it("emits a Workspace with qn `:` from settings.gradle.kts (root)", async () => {
    const out = await runOn("gradle/01-kotlin-dsl/settings.gradle.kts");
    const ws = find(out.entities, "Workspace", ":")!;
    expect(ws).toBeDefined();
    expect(ws.attrs?.dsl).toBe("kotlin");
  });

  it("emits CONTAINS edges for every include(...) entry in settings.gradle.kts", async () => {
    const out = await runOn("gradle/01-kotlin-dsl/settings.gradle.kts");
    const includes = out.edges.filter((e) => e.relationship === "CONTAINS");
    const targets = includes.map((e) => e.to).sort();
    expect(targets).toEqual([
      "gradle:project::app",
      "gradle:project::core",
      "gradle:project::lib:util",
    ]);
    for (const e of includes) {
      expect(e.meta?.via).toBe("settings_include");
    }
  });

  it("emits IMPORTS edges for `id(...)` and `kotlin(...)` plugins with version metadata", async () => {
    const out = await runOn("gradle/01-kotlin-dsl/app/build.gradle.kts");
    const ktJvm = importsTo(out.edges, "gradle:plugin:org.jetbrains.kotlin.jvm")!;
    expect(ktJvm).toBeDefined();
    expect(ktJvm.meta?.via).toBe("plugin");
    expect(ktJvm.meta?.version).toBe("1.9.0");
    const boot = importsTo(out.edges, "gradle:plugin:org.springframework.boot")!;
    expect(boot.meta?.version).toBe("3.0.0");
    // backticked `java-library` carries no version
    const javaLib = importsTo(out.edges, "gradle:plugin:java-library")!;
    expect(javaLib).toBeDefined();
    expect(javaLib.meta?.version).toBeUndefined();
  });

  it("emits IMPORTS edges for Maven coordinate dependencies with scope + version", async () => {
    const out = await runOn("gradle/01-kotlin-dsl/app/build.gradle.kts");
    const coroutines = importsTo(
      out.edges,
      "gradle:dep:org.jetbrains.kotlinx:kotlinx-coroutines-core",
    )!;
    expect(coroutines.meta?.via).toBe("dependency");
    expect(coroutines.meta?.scope).toBe("implementation");
    expect(coroutines.meta?.version).toBe("1.7.0");
    const guava = importsTo(out.edges, "gradle:dep:com.google.guava:guava")!;
    expect(guava.meta?.scope).toBe("api");
    const junit = importsTo(out.edges, "gradle:dep:org.junit.jupiter:junit-jupiter")!;
    expect(junit.meta?.scope).toBe("testImplementation");
  });

  it("emits a project_dependency IMPORTS edge for `project(\":core\")`", async () => {
    const out = await runOn("gradle/01-kotlin-dsl/app/build.gradle.kts");
    const proj = importsTo(out.edges, "gradle:project::core")!;
    expect(proj).toBeDefined();
    expect(proj.meta?.via).toBe("project_dependency");
    expect(proj.meta?.scope).toBe("api");
    expect(proj.meta?.base_module).toBe(":core");
    expect(proj.meta?.resolved).toBe(false);
  });

  it("emits a version_catalog_ref edge for `libs.mockito.core`", async () => {
    const out = await runOn("gradle/01-kotlin-dsl/app/build.gradle.kts");
    const ref = importsTo(out.edges, "gradle:libref:libs.mockito.core")!;
    expect(ref).toBeDefined();
    expect(ref.meta?.via).toBe("version_catalog_ref");
    expect(ref.meta?.scope).toBe("testImplementation");
  });
});

// ---------------------------------------------------------------------------
// Groovy DSL fixtures
// ---------------------------------------------------------------------------

describe("Gradle extractor — Groovy DSL (G-1)", () => {
  it("emits BuildTarget for build.gradle in `app/` with qn `:app` and dsl=groovy", async () => {
    const out = await runOn("gradle/02-groovy-dsl/app/build.gradle");
    const bt = find(out.entities, "BuildTarget", ":app")!;
    expect(bt).toBeDefined();
    expect(bt.attrs?.dsl).toBe("groovy");
  });

  it("recognises `id 'x'` / `id 'x' version 'v'` and legacy `apply plugin:`", async () => {
    const out = await runOn("gradle/02-groovy-dsl/app/build.gradle");
    expect(importsTo(out.edges, "gradle:plugin:java-library")).toBeDefined();
    const boot = importsTo(out.edges, "gradle:plugin:org.springframework.boot")!;
    expect(boot.meta?.version).toBe("3.0.0");
    expect(importsTo(out.edges, "gradle:plugin:checkstyle")).toBeDefined();
  });

  it("recognises Groovy dependency coordinates + project() with scope", async () => {
    const out = await runOn("gradle/02-groovy-dsl/app/build.gradle");
    const commons = importsTo(out.edges, "gradle:dep:org.apache.commons:commons-lang3")!;
    expect(commons.meta?.scope).toBe("implementation");
    expect(commons.meta?.version).toBe("3.13.0");
    const guava = importsTo(out.edges, "gradle:dep:com.google.guava:guava")!;
    expect(guava.meta?.scope).toBe("api");
    const proj = importsTo(out.edges, "gradle:project::core")!;
    expect(proj.meta?.via).toBe("project_dependency");
    expect(proj.meta?.scope).toBe("implementation");
    const junit = importsTo(out.edges, "gradle:dep:junit:junit")!;
    expect(junit.meta?.scope).toBe("testImplementation");
  });

  it("emits CONTAINS edges for include() entries in Groovy settings.gradle", async () => {
    const out = await runOn("gradle/02-groovy-dsl/settings.gradle");
    const includes = out.edges.filter((e) => e.relationship === "CONTAINS").map((e) => e.to).sort();
    expect(includes).toEqual([
      "gradle:project::app",
      "gradle:project::core",
      "gradle:project::lib:util",
    ]);
    const ws = find(out.entities, "Workspace", ":")!;
    expect(ws.attrs?.dsl).toBe("groovy");
  });
});
