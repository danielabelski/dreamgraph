/**
 * DreamGraph — Heuristic structural-fallback generators.
 *
 * Used by `scan_project` when the LLM is unavailable (or as a baseline
 * before LLM enrichment). Each generator inspects a `ProjectScan` and
 * produces a list of plain entity records.
 *
 * No I/O — pure transformation of the scan result.
 */

import path from "node:path";
import type { ProjectScan, ScannedFile } from "./scan-types.js";

// ---------------------------------------------------------------------------
// String helpers
// ---------------------------------------------------------------------------

export function toSnakeCase(str: string): string {
  return str
    .replace(/[^a-zA-Z0-9]/g, "_")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
}

export function toTitleCase(str: string): string {
  return str.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function inferDomain(dirParts: string[]): string {
  /**
   * Domain labels must describe evidenced project vocabulary, not architecture,
   * framework, language, or persistence structure. Generic containers such as
   * api/routes/controllers/db/database/models/schema/middleware are intentionally
   * not mapped into semantic domains.
   */
  const hints: Record<string, string> = {
    auth: "authentication", login: "authentication", session: "authentication",
    user: "user_management", account: "user_management", profile: "user_management",
    admin: "administration", report: "reporting", analytics: "analytics",
    search: "search", notification: "notification", email: "notification",
    import: "import_export", export: "import_export",
  };

  for (const part of dirParts) {
    const key = part.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (hints[key]) return hints[key];
  }
  return "core";
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

export function generateStructuralFeatures(scan: ProjectScan): Record<string, unknown>[] {
  const groups = new Map<string, ScannedFile[]>();
  for (const f of scan.files) {
    const key = f.dirParts.slice(0, 2).join("/") || f.name;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(f);
  }

  const entries: Record<string, unknown>[] = [];
  for (const [groupPath, files] of groups) {
    const id = toSnakeCase(`${scan.repoName}_${groupPath}`);
    const name = toTitleCase(groupPath.split("/").pop() ?? groupPath);
    entries.push({
      id,
      name,
      description: `${name} — ${files.length} source file(s) in ${groupPath}/`,
      source_repo: scan.repoName,
      source_files: files.slice(0, 10).map((f) => f.rel),
      status: "active",
      category: inferDomain(files[0]?.dirParts ?? []),
      tags: [scan.technology.split(",")[0]?.trim().toLowerCase() ?? "unknown"],
      domain: inferDomain(files[0]?.dirParts ?? []),
      keywords: [
        ...new Set(
          files.slice(0, 5).map((f) => path.basename(f.name, f.ext).toLowerCase()),
        ),
      ],
      links: [],
    });
  }
  return entries;
}

export function generateStructuralWorkflows(scan: ProjectScan): Record<string, unknown>[] {
  // Structural fallback has no source-content access, so it must be conservative:
  // only promote files/directories that explicitly describe themselves as a flow,
  // workflow, or process. Broad framework-shaped names (route/controller/hook/etc.)
  // are intentionally not enough evidence because DreamGraph must be language,
  // framework, platform, and structure agnostic.
  const workflowPatterns = [
    /(^|[-_./\\])(workflow|workflows|flow|flows|process|processes)([-_./\\]|$)/i,
  ];
  const entries: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const f of scan.files) {
    const dir = f.dirParts.join("/");
    const evidence = `${dir}/${path.basename(f.name, f.ext)}`;
    if (seen.has(dir)) continue;
    if (workflowPatterns.some((p) => p.test(evidence))) {
      seen.add(dir);
      const id = toSnakeCase(`${scan.repoName}_${dir || path.basename(f.name, f.ext)}_flow`);
      const evidenceFiles = scan.files
        .filter((sf) => sf.dirParts.join("/") === dir)
        .slice(0, 10)
        .map((sf) => sf.rel);
      entries.push({
        id,
        name: `${toTitleCase(f.dirParts[f.dirParts.length - 1] ?? path.basename(f.name, f.ext))} Flow`,
        description: `Workflow explicitly indicated by source path evidence: ${f.rel}`,
        trigger: `unknown from discovered source; evidence: ${f.rel}`,
        source_repo: scan.repoName,
        source_files: evidenceFiles.length > 0 ? evidenceFiles : [f.rel],
        domain: inferDomain(f.dirParts),
        keywords: [path.basename(f.name, f.ext).toLowerCase(), ...f.dirParts.map((d) => d.toLowerCase())],
        status: "active",
        steps: [],
        links: [],
      });
    }
  }
  return entries;
}

export function generateStructuralDataModel(scan: ProjectScan): Record<string, unknown>[] {
  // Without reading source content, only explicit self-describing names are enough
  // evidence for a data-structure node. Do not infer datastore/table/storage facts.
  const modelPatterns = [
    /(^|[-_./\\])(model|models|schema|schemas|entity|entities|type|types|interface|interfaces|contract|contracts|dto|dtos)([-_./\\]|$)/i,
  ];
  const entries: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const f of scan.files) {
    const dir = f.dirParts.join("/");
    const nameNoExt = path.basename(f.name, f.ext);
    const evidence = `${dir}/${nameNoExt}`;
    if (seen.has(dir + nameNoExt)) continue;
    if (modelPatterns.some((p) => p.test(evidence))) {
      seen.add(dir + nameNoExt);
      const id = toSnakeCase(`${scan.repoName}_${dir}_${nameNoExt}`);
      entries.push({
        id,
        name: toTitleCase(nameNoExt),
        description: `Data structure explicitly indicated by source path evidence: ${f.rel}`,
        source_repo: scan.repoName,
        source_files: [f.rel],
        domain: inferDomain(f.dirParts),
        keywords: [nameNoExt.toLowerCase(), ...f.dirParts.map((d) => d.toLowerCase())],
        status: "active",
        key_fields: [],
        relationships: [],
        links: [],
      });
    }
  }
  return entries;
}
