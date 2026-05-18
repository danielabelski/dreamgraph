/**
 * DreamGraph — Native UI scanner (slice 2).
 *
 * Extracts UI components from a project scan and produces
 * scanner-origin SemanticElement records ready for merge into
 * `ui_registry.json`. Each emitted element carries:
 *
 *   - `source_kind: "scanner"` — provenance for the enricher and the
 *     index admission gate.
 *   - `source_repo`             — the repo name; required for index.json
 *     admission per the slice-1 provenance gate.
 *   - `source_file`             — repo-relative path of the source file.
 *
 * Heuristics are intentionally conservative: we only extract identifiers
 * that the framework clearly treats as a component (PascalCase exports
 * from React/JSX/TSX files, or the filename stem for single-file-component
 * frameworks like Vue/Svelte/Razor/XAML). Anything ambiguous is skipped
 * so the registry stays high-signal.
 *
 * The scanner does NOT touch `ui_registry.json` directly. It returns
 * elements that are merged via `applyScannerUiElements` in
 * `ui-registry.ts`, which preserves manual/sdk entries and only updates
 * existing scanner-origin entries.
 */

import fs from "node:fs/promises";
import { logger } from "../utils/logger.js";
import type { SemanticElement } from "../types/index.js";
import type { ProjectScan, ScannedFile } from "./scan-types.js";

// ---------------------------------------------------------------------------
// Framework dispatch
// ---------------------------------------------------------------------------

type Framework = "react" | "vue" | "svelte" | "blazor" | "wpf";

const FRAMEWORK_BY_EXT: Record<string, Framework> = {
  ".tsx": "react",
  ".jsx": "react",
  ".vue": "vue",
  ".svelte": "svelte",
  ".razor": "blazor",
  ".xaml": "wpf",
};

function frameworkFor(file: ScannedFile): Framework | undefined {
  return FRAMEWORK_BY_EXT[file.ext.toLowerCase()];
}

export function hasScannableUiFiles(scan: ProjectScan): boolean {
  return scan.uiFiles.some((f) => frameworkFor(f) !== undefined);
}

// ---------------------------------------------------------------------------
// React / JSX / TSX component name extraction
// ---------------------------------------------------------------------------

/**
 * Match `export default function Foo`, `export function Foo`,
 * `export async function Foo`, `export const Foo =`, `export default Foo`.
 * Only PascalCase identifiers are considered — React's de-facto component
 * naming convention and the same heuristic linters use.
 */
const REACT_PATTERNS: readonly RegExp[] = [
  /\bexport\s+(?:default\s+)?(?:async\s+)?function\s+([A-Z][A-Za-z0-9_]*)\s*\(/g,
  /\bexport\s+(?:default\s+)?const\s+([A-Z][A-Za-z0-9_]*)\s*[:=]/g,
  /\bexport\s+default\s+([A-Z][A-Za-z0-9_]*)\s*;?\s*$/gm,
];

function extractReactComponentNames(source: string): string[] {
  const names = new Set<string>();
  for (const pattern of REACT_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(source)) !== null) {
      const name = m[1];
      if (name && name.length >= 2) names.add(name);
    }
  }
  return Array.from(names);
}

// ---------------------------------------------------------------------------
// Single-file-component frameworks (Vue / Svelte / Razor / XAML)
// ---------------------------------------------------------------------------

/**
 * Filename stem → component identifier. Returns the stem unchanged when
 * it already looks like a component name (starts with an uppercase
 * letter), otherwise applies a minimal PascalCase conversion. Skips
 * dotted partial names like `Foo.test` or `Foo.story`.
 */
function componentNameFromFile(file: ScannedFile): string | undefined {
  const stem = file.name.slice(0, file.name.length - file.ext.length);
  if (!stem) return undefined;
  // Skip test/story/spec siblings — they aren't deliverable components.
  if (/\.(test|spec|stories|story|d)$/i.test(stem)) return undefined;
  if (/^[A-Z]/.test(stem) && /^[A-Za-z0-9_]+$/.test(stem)) return stem;
  // Fall back to PascalCase from kebab/snake (e.g. `my-button` → `MyButton`).
  const parts = stem.split(/[-_]+/).filter(Boolean);
  if (parts.length === 0) return undefined;
  const pascal = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
  if (!/^[A-Z]/.test(pascal)) return undefined;
  return pascal;
}

// ---------------------------------------------------------------------------
// Element id construction
// ---------------------------------------------------------------------------

/**
 * Build a stable, deterministic id for a scanner-emitted element. We
 * use `<repo>.<dotted-path>.<ComponentName>` so the id is human-readable
 * and survives re-scans without churn.
 */
function buildElementId(repoName: string, file: ScannedFile, componentName: string): string {
  const stem = file.rel.slice(0, file.rel.length - file.ext.length);
  const dottedPath = stem.replace(/[\\/]+/g, ".").replace(/\.+/g, ".");
  return `${repoName}.${dottedPath}.${componentName}`;
}

// ---------------------------------------------------------------------------
// Per-file extraction
// ---------------------------------------------------------------------------

export interface UiScanDiagnostic {
  severity: "warning" | "error";
  relPath: string;
  message: string;
}

export interface UiScanQuality {
  /** Files matched by a UI framework that produced at least one element. */
  parsedFiles: number;
  /** All files matched by a UI framework (whether or not extraction yielded elements). */
  totalUiFiles: number;
  /** Non-fatal diagnostics aggregated across the scan. */
  diagnostics: UiScanDiagnostic[];
}

export interface NativeUiScanResult {
  elements: SemanticElement[];
  quality: UiScanQuality;
}

function buildElement(args: {
  repoName: string;
  file: ScannedFile;
  framework: Framework;
  componentName: string;
}): SemanticElement {
  const { repoName, file, framework, componentName } = args;
  const id = buildElementId(repoName, file, componentName);
  return {
    id,
    name: componentName,
    purpose: `${framework} component '${componentName}' detected by scanner in ${file.rel}. Enrich for narrative description.`,
    category: "composite",
    data_contract: { inputs: [], outputs: [] },
    interactions: [],
    implementations: [
      {
        platform: framework,
        component: componentName,
        source_file: file.rel,
      },
    ],
    used_by: [],
    tags: ["scanner", framework],
    source_kind: "scanner",
    source_repo: repoName,
    source_file: file.rel,
  };
}

async function extractFromFile(
  repoName: string,
  file: ScannedFile,
  framework: Framework,
  diagnostics: UiScanDiagnostic[],
): Promise<SemanticElement[]> {
  if (framework === "react") {
    let source: string;
    try {
      source = await fs.readFile(file.abs, "utf-8");
    } catch (err) {
      diagnostics.push({
        severity: "warning",
        relPath: file.rel,
        message: `ui scan: failed to read file: ${err instanceof Error ? err.message : String(err)}`,
      });
      return [];
    }
    const names = extractReactComponentNames(source);
    if (names.length === 0) {
      // Fall back to filename if it looks like a component; many React
      // files use `export default Foo` patterns the regexes miss
      // (HOCs, memo wrappers, etc.). Filename-based fallback keeps
      // coverage high without hallucinating arbitrary identifiers.
      const stemName = componentNameFromFile(file);
      if (!stemName) return [];
      return [buildElement({ repoName, file, framework, componentName: stemName })];
    }
    return names.map((name) => buildElement({ repoName, file, framework, componentName: name }));
  }

  // Single-file-component frameworks: filename is the component.
  const stemName = componentNameFromFile(file);
  if (!stemName) return [];
  return [buildElement({ repoName, file, framework, componentName: stemName })];
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Scan every UI file in `scan` and produce scanner-origin SemanticElement
 * records. Non-fatal: per-file failures degrade quality counters but
 * never throw. Returns an empty result with `totalUiFiles: 0` for
 * projects with no UI files.
 */
export async function extractNativeUiElements(scan: ProjectScan): Promise<NativeUiScanResult> {
  const candidates = scan.uiFiles.filter((f) => frameworkFor(f) !== undefined);
  const quality: UiScanQuality = {
    parsedFiles: 0,
    totalUiFiles: candidates.length,
    diagnostics: [],
  };
  if (candidates.length === 0) {
    return { elements: [], quality };
  }

  const seenIds = new Set<string>();
  const elements: SemanticElement[] = [];
  for (const file of candidates) {
    const framework = frameworkFor(file)!;
    let perFile: SemanticElement[];
    try {
      perFile = await extractFromFile(scan.repoName, file, framework, quality.diagnostics);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`ui scan: ${framework} extractor failed on ${file.rel}: ${msg}`);
      quality.diagnostics.push({
        severity: "error",
        relPath: file.rel,
        message: `${framework} extractor threw: ${msg}`,
      });
      continue;
    }
    if (perFile.length > 0) {
      quality.parsedFiles += 1;
      for (const el of perFile) {
        if (seenIds.has(el.id)) continue;
        seenIds.add(el.id);
        elements.push(el);
      }
    }
  }

  return { elements, quality };
}
