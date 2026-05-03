/**
 * DreamGraph — auxiliary entity classifier (Phase 5 #9).
 *
 * Identifies files that are NOT primary application source but are
 * still significant entities in the project graph:
 *
 *   - test_suite        — *.test.*, *.spec.*, files under tests/ or __tests__/
 *   - configuration     — *.config.*, .env*, tsconfig.json, *.toml, *.yml/.yaml,
 *                         .eslintrc*, .prettierrc*, package.json
 *   - automation_script — Makefile, justfile, *.sh, *.ps1, scripts/*,
 *                         .github/workflows/*, Dockerfile, docker-compose.*
 *   - mcp_tool          — TypeScript files under src/tools/ that register
 *                         MCP tools (excluding *.test.ts and helper files).
 *
 * Classification is mutually exclusive — the first matching rule wins.
 * Test classification takes priority over configuration/script so that
 * `tests/foo.config.test.ts` is reported as a test_suite, not a config.
 */

import path from "node:path";

export type AuxiliaryKind =
  | "test_suite"
  | "configuration"
  | "automation_script"
  | "mcp_tool";

const TEST_DIR_SEGMENTS = ["tests", "test", "__tests__", "spec", "specs", "e2e"];
const TEST_NAME_PATTERNS = [
  /\.test\.[a-z0-9]+$/i,
  /\.spec\.[a-z0-9]+$/i,
];

const SCRIPT_DIR_SEGMENTS = ["scripts", "bin"];
const SCRIPT_FILE_NAMES = new Set([
  "makefile",
  "justfile",
  "dockerfile",
  "containerfile",
]);
const SCRIPT_FILE_PATTERNS = [
  /\.sh$/i,
  /\.ps1$/i,
  /\.bat$/i,
  /\.cmd$/i,
  /^docker-compose(\.[^.]+)?\.ya?ml$/i,
];

const CONFIG_FILE_NAMES = new Set([
  "package.json",
  "tsconfig.json",
  "tsconfig.base.json",
  "tsconfig.build.json",
  "jsconfig.json",
  "pyproject.toml",
  "setup.cfg",
  "setup.py",
  "requirements.txt",
  "cargo.toml",
  "go.mod",
  "go.sum",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "gemfile",
]);
const CONFIG_FILE_PATTERNS = [
  /\.config\.[a-z0-9]+$/i,        // vite.config.ts, vitest.config.ts
  /^\.env(\..+)?$/i,              // .env, .env.local
  /^\.eslintrc(\..+)?$/i,
  /^\.prettierrc(\..+)?$/i,
  /^\.editorconfig$/i,
  /^\.npmrc$/i,
  /^\.nvmrc$/i,
  /^\.gitattributes$/i,
  /\.toml$/i,
  /\.ya?ml$/i,                    // generic — overridden by script/test rules above
  /\.ini$/i,
];

const MCP_TOOL_DIR_SEGMENTS = ["src", "tools"];

function dirParts(rel: string): string[] {
  return path.dirname(rel).split(/[\\/]/).filter(Boolean);
}

function lowerName(name: string): string {
  return name.toLowerCase();
}

function isUnderDir(rel: string, segments: string[]): boolean {
  const parts = dirParts(rel).map(p => p.toLowerCase());
  return segments.some(seg => parts.includes(seg));
}

function isUnderToolsDir(rel: string): boolean {
  const parts = dirParts(rel).map(p => p.toLowerCase());
  if (parts.length < 2) return false;
  // Match `src/tools` (or any `*/tools` whose parent is `src`).
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === MCP_TOOL_DIR_SEGMENTS[0] && parts[i + 1] === MCP_TOOL_DIR_SEGMENTS[1]) {
      return true;
    }
  }
  return false;
}

function isUnderGithubWorkflows(rel: string): boolean {
  const parts = dirParts(rel).map(p => p.toLowerCase());
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === ".github" && parts[i + 1] === "workflows") return true;
  }
  return false;
}

/**
 * Classify a single scanned file path.
 *
 * @param rel  Path relative to the repo root (forward slashes preferred,
 *             backslashes tolerated).
 * @param name File basename (case-sensitive on disk; matched case-insensitively).
 * @returns The auxiliary kind, or `null` if the file is not an auxiliary entity.
 */
export function classifyAuxiliaryFile(rel: string, name: string): AuxiliaryKind | null {
  const lname = lowerName(name);

  // 1) Tests win over everything (a test file in tests/ is a test, even if
  //    it contains "config" in the name).
  if (TEST_NAME_PATTERNS.some(re => re.test(name))) return "test_suite";
  if (isUnderDir(rel, TEST_DIR_SEGMENTS)) {
    // Only count actual code-like files inside test dirs as test_suite.
    const ext = path.extname(name).toLowerCase();
    if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs"].includes(ext)) {
      return "test_suite";
    }
  }

  // 2) MCP tool files: under src/tools/, .ts/.js, not a test, not the
  //    shared sanitize/structural helpers (which live there but aren't tools).
  if (isUnderToolsDir(rel)) {
    const ext = path.extname(name).toLowerCase();
    if ((ext === ".ts" || ext === ".js" || ext === ".mts" || ext === ".cts")
        && !lname.endsWith(".d.ts")) {
      return "mcp_tool";
    }
  }

  // 3) Automation scripts.
  if (SCRIPT_FILE_NAMES.has(lname)) return "automation_script";
  if (SCRIPT_FILE_PATTERNS.some(re => re.test(name))) return "automation_script";
  if (isUnderDir(rel, SCRIPT_DIR_SEGMENTS)) {
    const ext = path.extname(name).toLowerCase();
    if ([".sh", ".ps1", ".bat", ".cmd", ".js", ".cjs", ".mjs", ".ts", ".py", ".rb"].includes(ext)) {
      return "automation_script";
    }
  }
  if (isUnderGithubWorkflows(rel)) return "automation_script";

  // 4) Configuration.
  if (CONFIG_FILE_NAMES.has(lname)) return "configuration";
  if (CONFIG_FILE_PATTERNS.some(re => re.test(name))) return "configuration";

  return null;
}
