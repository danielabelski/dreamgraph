/**
 * Phase 5 #9 — auxiliary entity classifier + generator regression tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyAuxiliaryFile } from "../src/tools/auxiliary-classifier.js";
import { generateAuxiliaryEntities } from "../src/tools/auxiliary-generators.js";
import type { ProjectScan, ScannedFile } from "../src/tools/scan-types.js";

function file(rel: string, abs?: string, size = 100): ScannedFile {
  const name = rel.split("/").pop()!;
  const ext = name.includes(".") ? "." + name.split(".").pop()! : "";
  return {
    abs: abs ?? `/repo/${rel}`,
    rel,
    name,
    ext,
    dirParts: rel.split("/").slice(0, -1),
    size,
  };
}

describe("classifyAuxiliaryFile", () => {
  it("classifies *.test.ts and *.spec.* as test_suite", () => {
    expect(classifyAuxiliaryFile("tests/foo.test.ts", "foo.test.ts")).toBe("test_suite");
    expect(classifyAuxiliaryFile("src/bar.spec.ts", "bar.spec.ts")).toBe("test_suite");
    expect(classifyAuxiliaryFile("tests/sub/baz.test.tsx", "baz.test.tsx")).toBe("test_suite");
  });

  it("classifies code files under tests/ as test_suite even without .test suffix", () => {
    expect(classifyAuxiliaryFile("tests/helpers.ts", "helpers.ts")).toBe("test_suite");
    expect(classifyAuxiliaryFile("__tests__/util.js", "util.js")).toBe("test_suite");
  });

  it("classifies src/tools/*.ts as mcp_tool", () => {
    expect(classifyAuxiliaryFile("src/tools/scan-project.ts", "scan-project.ts")).toBe("mcp_tool");
    expect(classifyAuxiliaryFile("src/tools/foo.ts", "foo.ts")).toBe("mcp_tool");
  });

  it("does NOT classify src/tools/*.test.ts as mcp_tool — tests win", () => {
    expect(classifyAuxiliaryFile("src/tools/foo.test.ts", "foo.test.ts")).toBe("test_suite");
  });

  it("classifies build/test config files as configuration", () => {
    expect(classifyAuxiliaryFile("vite.config.ts", "vite.config.ts")).toBe("configuration");
    expect(classifyAuxiliaryFile("vitest.config.ts", "vitest.config.ts")).toBe("configuration");
    expect(classifyAuxiliaryFile("tsconfig.json", "tsconfig.json")).toBe("configuration");
    expect(classifyAuxiliaryFile("package.json", "package.json")).toBe("configuration");
    expect(classifyAuxiliaryFile(".env", ".env")).toBe("configuration");
    expect(classifyAuxiliaryFile(".env.local", ".env.local")).toBe("configuration");
    expect(classifyAuxiliaryFile("pyproject.toml", "pyproject.toml")).toBe("configuration");
  });

  it("classifies scripts and CI as automation_script", () => {
    expect(classifyAuxiliaryFile("Makefile", "Makefile")).toBe("automation_script");
    expect(classifyAuxiliaryFile("scripts/install.ps1", "install.ps1")).toBe("automation_script");
    expect(classifyAuxiliaryFile("scripts/build.sh", "build.sh")).toBe("automation_script");
    expect(classifyAuxiliaryFile(".github/workflows/ci.yml", "ci.yml")).toBe("automation_script");
    expect(classifyAuxiliaryFile("Dockerfile", "Dockerfile")).toBe("automation_script");
    expect(classifyAuxiliaryFile("docker-compose.yml", "docker-compose.yml")).toBe("automation_script");
  });

  it("returns null for ordinary source files", () => {
    expect(classifyAuxiliaryFile("src/feature.ts", "feature.ts")).toBeNull();
    expect(classifyAuxiliaryFile("src/components/Button.tsx", "Button.tsx")).toBeNull();
    expect(classifyAuxiliaryFile("README.md", "README.md")).toBeNull();
  });
});

describe("generateAuxiliaryEntities", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "dg-aux-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function makeScan(overrides: Partial<ProjectScan["auxiliaryFiles"]> = {}): ProjectScan {
    return {
      repoName: "demo",
      repoRoot: "/repo",
      technology: "TypeScript",
      files: [],
      manifestContent: {},
      uiFiles: [],
      topLevelDirs: [],
      auxiliaryFiles: {
        test_suite: [],
        configuration: [],
        automation_script: [],
        mcp_tool: [],
        ...overrides,
      },
    };
  }

  it("emits one entity per test/config/script file with stable IDs and URIs", async () => {
    const scan = makeScan({
      test_suite: [file("tests/foo.test.ts")],
      configuration: [file("vite.config.ts")],
      automation_script: [file("scripts/install.ps1")],
    });

    const entities = await generateAuxiliaryEntities(scan);
    const byKind = Object.fromEntries(entities.map(e => [e.kind, e]));

    expect(byKind.test_suite.id).toMatch(/^test_suite_/);
    expect(byKind.test_suite.uri).toBe(`test_suite://${byKind.test_suite.id}`);
    expect(byKind.test_suite.tags).toContain("vitest_or_jest");

    expect(byKind.configuration.id).toMatch(/^configuration_/);
    expect(byKind.configuration.tags).toContain("build_tool");

    expect(byKind.automation_script.id).toMatch(/^automation_script_/);
    expect(byKind.automation_script.tags).toContain("powershell");
  });

  it("extracts MCP tool registrations from src/tools/*.ts content", async () => {
    const toolFile = join(tempDir, "scan-project.ts");
    await writeFile(
      toolFile,
      `import { McpServer } from "...";
       export function registerScanProjectTool(server: McpServer): void {
         server.tool("scan_project", { /* ... */ }, async () => ({}));
       }
      `,
      "utf-8",
    );

    const scan = makeScan({
      mcp_tool: [{ ...file("src/tools/scan-project.ts"), abs: toolFile }],
    });

    const entities = await generateAuxiliaryEntities(scan);
    const ids = entities.map(e => e.id);
    expect(ids).toContain("mcp_tool_scan_project");
    const tool = entities.find(e => e.id === "mcp_tool_scan_project")!;
    expect(tool.uri).toBe("tool://scan_project");
    expect(tool.meta?.registered_tools).toEqual(["scan_project"]);
  });

  it("emits a structural placeholder when no MCP registrations are detectable", async () => {
    const toolFile = join(tempDir, "helpers.ts");
    await writeFile(toolFile, "export const noop = () => {};\n", "utf-8");

    const scan = makeScan({
      mcp_tool: [{ ...file("src/tools/helpers.ts"), abs: toolFile }],
    });

    const entities = await generateAuxiliaryEntities(scan);
    expect(entities).toHaveLength(1);
    expect(entities[0].kind).toBe("mcp_tool");
    expect(entities[0].meta?.registered_tools).toEqual([]);
  });

  it("merges duplicate IDs into a single entity with combined source_files", async () => {
    // Two configs that sanitize to the same id (e.g. both 'tsconfig.json').
    const a = file("tsconfig.json");
    const b = { ...file("packages/x/tsconfig.json"), name: "tsconfig.json" };
    const scan = makeScan({ configuration: [a, b] });

    const entities = await generateAuxiliaryEntities(scan);
    expect(entities).toHaveLength(1);
    expect(entities[0].source_files.sort()).toEqual([
      "packages/x/tsconfig.json",
      "tsconfig.json",
    ]);
  });

  it("handles an empty scan gracefully", async () => {
    const entities = await generateAuxiliaryEntities(makeScan());
    expect(entities).toEqual([]);
  });
});

describe("auxiliary store integration", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "dg-aux-store-"));
    const { setDataDirOverride } = await import("../src/utils/paths.js");
    setDataDirOverride(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("merges incoming entities into a fresh store and round-trips", async () => {
    const { mergeAuxiliaryEntities, loadAuxiliaryEntities } = await import("../src/tools/auxiliary-store.js");

    const result = await mergeAuxiliaryEntities([
      {
        id: "test_suite_foo",
        name: "foo.test.ts",
        description: "test",
        source_repo: "demo",
        source_files: ["tests/foo.test.ts"],
        kind: "test_suite",
        uri: "test_suite://test_suite_foo",
      },
    ]);

    expect(result.inserted).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.total).toBe(1);

    const loaded = await loadAuxiliaryEntities();
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.metadata.last_scanned).not.toBeNull();
  });

  it("preserves existing entries on merge and counts updates separately", async () => {
    const { mergeAuxiliaryEntities, loadAuxiliaryEntities } = await import("../src/tools/auxiliary-store.js");

    await mergeAuxiliaryEntities([
      { id: "a", name: "a", description: "first", source_repo: "demo", source_files: ["a"], kind: "configuration", uri: "configuration://a" },
    ]);

    const r2 = await mergeAuxiliaryEntities([
      // update
      { id: "a", name: "a", description: "updated", source_repo: "demo", source_files: ["a", "a2"], kind: "configuration", uri: "configuration://a" },
      // insert
      { id: "b", name: "b", description: "new", source_repo: "demo", source_files: ["b"], kind: "configuration", uri: "configuration://b" },
    ]);

    expect(r2.inserted).toBe(1);
    expect(r2.updated).toBe(1);
    expect(r2.total).toBe(2);

    const loaded = await loadAuxiliaryEntities();
    const a = loaded.entries.find(e => e.id === "a")!;
    expect(a.description).toBe("updated");
    expect(a.source_files).toEqual(["a", "a2"]);
  });

  it("returns empty canonical shape when the file does not yet exist (ADR-095)", async () => {
    const { loadAuxiliaryEntities } = await import("../src/tools/auxiliary-store.js");
    const loaded = await loadAuxiliaryEntities();
    expect(loaded.entries).toEqual([]);
    expect(loaded.metadata.total).toBe(0);
    expect(loaded.metadata.last_scanned).toBeNull();
  });
});

// Acknowledge unused import for future helpers.
void mkdir;
