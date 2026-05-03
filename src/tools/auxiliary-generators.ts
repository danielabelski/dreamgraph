/**
 * DreamGraph — auxiliary entity generator (Phase 5 #9).
 *
 * Converts the auxiliaryFiles buckets produced by scanProject() into
 * AuxiliaryEntity records. Purely structural — no LLM required.
 *
 * Identity convention (ADR-010 spirit, prefixed by kind):
 *   - test_suite_<sanitized basename>
 *   - configuration_<sanitized basename>
 *   - automation_script_<sanitized basename>
 *   - mcp_tool_<registered name>  (when discoverable)
 *     mcp_tool_<sanitized basename> otherwise
 *
 * URIs:
 *   - test_suite://<id>
 *   - configuration://<id>
 *   - automation_script://<id>
 *   - tool://<registered name | basename>   (mcp tools)
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectScan, ScannedFile } from "./scan-types.js";
import type { AuxiliaryEntity } from "../types/index.js";

const MAX_TOOL_FILE_BYTES = 8192;

const NAME_SANITIZE_RE = /[^a-z0-9]+/g;

function sanitizeId(raw: string): string {
  return raw
    .toLowerCase()
    .replace(NAME_SANITIZE_RE, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function basenameNoExt(rel: string): string {
  const base = path.basename(rel);
  const dot = base.indexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function uniquePush(map: Map<string, AuxiliaryEntity>, entity: AuxiliaryEntity): void {
  // If a collision occurs (two files map to the same id), merge source_files
  // rather than dropping data.
  const existing = map.get(entity.id);
  if (existing) {
    const merged = new Set([...existing.source_files, ...entity.source_files]);
    existing.source_files = Array.from(merged);
    return;
  }
  map.set(entity.id, entity);
}

function detectTestFramework(rel: string): string | undefined {
  const lower = rel.toLowerCase();
  if (lower.endsWith(".test.ts") || lower.endsWith(".test.tsx") || lower.endsWith(".test.js")) {
    return "vitest_or_jest";
  }
  if (lower.endsWith(".spec.ts") || lower.endsWith(".spec.js")) return "vitest_or_jest";
  if (lower.endsWith(".test.py") || lower.includes("/tests/test_")) return "pytest";
  if (lower.endsWith("_test.go")) return "go_test";
  return undefined;
}

function configFlavor(name: string): string | undefined {
  const lname = name.toLowerCase();
  if (lname === "package.json") return "node_manifest";
  if (lname.startsWith("tsconfig")) return "typescript";
  if (lname.startsWith(".env")) return "environment";
  if (lname.endsWith(".toml")) return "toml";
  if (lname.endsWith(".yml") || lname.endsWith(".yaml")) return "yaml";
  if (lname.endsWith(".ini")) return "ini";
  if (/\.config\./.test(lname)) return "build_tool";
  return undefined;
}

function scriptFlavor(name: string, rel: string): string | undefined {
  const lname = name.toLowerCase();
  if (lname === "makefile") return "make";
  if (lname === "justfile") return "just";
  if (lname === "dockerfile") return "docker";
  if (/^docker-compose/i.test(name)) return "docker_compose";
  if (lname.endsWith(".ps1")) return "powershell";
  if (lname.endsWith(".sh")) return "shell";
  if (rel.toLowerCase().includes("/.github/workflows/")) return "github_actions";
  return undefined;
}

/**
 * Best-effort extraction of MCP tool names from a registration file.
 * Recognizes `server.tool("name"`, `.tool("name"`, and `register*Tool` patterns.
 */
async function extractMcpToolNames(absPath: string): Promise<string[]> {
  let text: string;
  try {
    const handle = await fs.open(absPath, "r");
    try {
      const buf = Buffer.alloc(MAX_TOOL_FILE_BYTES);
      const { bytesRead } = await handle.read(buf, 0, MAX_TOOL_FILE_BYTES, 0);
      text = buf.subarray(0, bytesRead).toString("utf-8");
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }

  const names = new Set<string>();
  // server.tool("name", ...) or .tool("name", ...) or registerTool("name"
  const re = /\.tool\(\s*["']([a-z0-9_]+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    names.add(m[1]);
  }
  // registerXxxTool — the convention used in src/tools/*.ts. Capture the Xxx.
  const reReg = /export\s+function\s+register([A-Z][A-Za-z0-9]*)Tool\s*\(/g;
  while ((m = reReg.exec(text)) !== null) {
    // Convert "ScanProject" → "scan_project".
    const snake = m[1]
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
      .toLowerCase();
    names.add(snake);
  }
  return Array.from(names);
}

function makeTestEntity(file: ScannedFile, repoName: string): AuxiliaryEntity {
  const id = `test_suite_${sanitizeId(basenameNoExt(file.rel))}`;
  const framework = detectTestFramework(file.rel);
  return {
    id,
    name: path.basename(file.rel),
    description: `Test file ${file.rel}${framework ? ` (${framework})` : ""}.`,
    source_repo: repoName,
    source_files: [file.rel],
    kind: "test_suite",
    uri: `test_suite://${id}`,
    tags: framework ? [framework] : [],
    meta: framework ? { framework } : {},
  };
}

function makeConfigEntity(file: ScannedFile, repoName: string): AuxiliaryEntity {
  const id = `configuration_${sanitizeId(file.name)}`;
  const flavor = configFlavor(file.name);
  return {
    id,
    name: file.name,
    description: `Configuration file ${file.rel}${flavor ? ` (${flavor})` : ""}.`,
    source_repo: repoName,
    source_files: [file.rel],
    kind: "configuration",
    uri: `configuration://${id}`,
    tags: flavor ? [flavor] : [],
    meta: flavor ? { flavor } : {},
  };
}

function makeScriptEntity(file: ScannedFile, repoName: string): AuxiliaryEntity {
  const id = `automation_script_${sanitizeId(file.name)}`;
  const flavor = scriptFlavor(file.name, file.rel);
  return {
    id,
    name: file.name,
    description: `Automation script ${file.rel}${flavor ? ` (${flavor})` : ""}.`,
    source_repo: repoName,
    source_files: [file.rel],
    kind: "automation_script",
    uri: `automation_script://${id}`,
    tags: flavor ? [flavor] : [],
    meta: flavor ? { flavor } : {},
  };
}

async function makeMcpToolEntities(file: ScannedFile, repoName: string): Promise<AuxiliaryEntity[]> {
  const toolNames = await extractMcpToolNames(file.abs);
  if (toolNames.length === 0) {
    // Still emit one structural entry so the file appears in the graph.
    const id = `mcp_tool_${sanitizeId(basenameNoExt(file.rel))}`;
    return [{
      id,
      name: path.basename(file.rel),
      description: `MCP tool source file ${file.rel} (no tool registration detected).`,
      source_repo: repoName,
      source_files: [file.rel],
      kind: "mcp_tool",
      uri: `tool://${sanitizeId(basenameNoExt(file.rel))}`,
      tags: [],
      meta: { registered_tools: [] },
    }];
  }
  return toolNames.map(name => ({
    id: `mcp_tool_${sanitizeId(name)}`,
    name,
    description: `MCP tool '${name}' registered in ${file.rel}.`,
    source_repo: repoName,
    source_files: [file.rel],
    kind: "mcp_tool" as const,
    uri: `tool://${sanitizeId(name)}`,
    tags: ["mcp", "tool"],
    meta: { registered_tools: [name] },
  }));
}

/**
 * Convert one repo scan's auxiliary buckets into entity records.
 */
export async function generateAuxiliaryEntities(scan: ProjectScan): Promise<AuxiliaryEntity[]> {
  const out = new Map<string, AuxiliaryEntity>();

  for (const f of scan.auxiliaryFiles.test_suite) {
    uniquePush(out, makeTestEntity(f, scan.repoName));
  }
  for (const f of scan.auxiliaryFiles.configuration) {
    uniquePush(out, makeConfigEntity(f, scan.repoName));
  }
  for (const f of scan.auxiliaryFiles.automation_script) {
    uniquePush(out, makeScriptEntity(f, scan.repoName));
  }
  for (const f of scan.auxiliaryFiles.mcp_tool) {
    const entities = await makeMcpToolEntities(f, scan.repoName);
    for (const e of entities) uniquePush(out, e);
  }

  return Array.from(out.values());
}
