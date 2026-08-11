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

function matchingDelimiter(source: string, start: number, open: string, close: string): number {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === open) depth++;
    else if (char === close && --depth === 0) return i;
  }
  return -1;
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let braces = 0;
  let brackets = 0;
  let parens = 0;
  let quote = "";
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") quote = char;
    else if (char === "{") braces++;
    else if (char === "}") braces--;
    else if (char === "[") brackets++;
    else if (char === "]") brackets--;
    else if (char === "(") parens++;
    else if (char === ")") parens--;
    else if (char === "," && braces === 0 && brackets === 0 && parens === 0) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function destructuredPropsFor(source: string, componentName: string): Array<{
  name: string;
  type: string;
  description: string;
  required: boolean;
}> {
  const escapedName = componentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declarations = [
    new RegExp(`\\bfunction\\s+${escapedName}\\s*\\(`),
    new RegExp(`\\b(?:const|let)\\s+${escapedName}(?:\\s*:[^=]+)?\\s*=\\s*(?:async\\s*)?\\(`),
  ];
  let params = "";
  for (const declaration of declarations) {
    const match = declaration.exec(source);
    if (!match) continue;
    const openParen = source.indexOf("(", match.index);
    const closeParen = matchingDelimiter(source, openParen, "(", ")");
    if (closeParen > openParen) params = source.slice(openParen + 1, closeParen).trim();
    if (params) break;
  }
  const openBrace = params.indexOf("{");
  if (openBrace < 0) return [];
  const closeBrace = matchingDelimiter(params, openBrace, "{", "}");
  if (closeBrace < 0) return [];

  const props = [];
  for (const raw of splitTopLevel(params.slice(openBrace + 1, closeBrace))) {
    const token = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/g, "").trim();
    if (!token || token.startsWith("...")) continue;
    const nameMatch = /^([A-Za-z_$][\w$]*)(\?)?/.exec(token);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    props.push({
      name,
      type: "source-inferred",
      description: `Source-defined ${componentName} input '${name}' used by the component's rendering or behavior.`,
      required: !nameMatch[2] && !token.includes("="),
    });
  }
  return props;
}

function humanizeIdentifier(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
}

function applyReactSourceFacts(element: SemanticElement, source: string): void {
  const inputs = destructuredPropsFor(source, element.name);
  const events = new Set<string>();
  for (const match of source.matchAll(/\bon([A-Z][A-Za-z0-9_]*)\s*=/g)) events.add(match[1].toLowerCase());
  const semanticText = `${element.name} ${source.match(/className\s*=\s*["'`]([^"'`]*)/)?.[1] ?? ""}`.toLowerCase();
  const pattern: NonNullable<SemanticElement["layout_semantics"]>["pattern"] =
    /dialog|modal/.test(semanticText) ? "dialog" :
      /toolbar|actions?/.test(semanticText) ? "toolbar" :
        /grid/.test(semanticText) ? "grid" :
          /table|list/.test(semanticText) ? "table" :
            /inspector|details?/.test(semanticText) ? "inspector" :
              /shell|workspace|app(?:lication)?/.test(semanticText) ? "shell" :
                /split|sidebar|resiz/.test(semanticText) ? "split_view" : "stack";
  const rootTag = source.match(/<([a-z][A-Za-z0-9-]*)\b/)?.[1] ?? "region";

  element.data_contract = {
    inputs,
    outputs: [{
      name: "rendered_view",
      type: "ui",
      description: `${element.name} renders a ${rootTag}-rooted interface from its source-defined inputs and local state.`,
      trigger: "render",
    }],
  };
  element.interactions = [...events].map((event) => ({
    action: event,
    description: `${element.name} handles the source-declared ${event} interaction.`,
  }));
  element.category = events.size > 0 ? "composite" : "data_display";
  element.visual_semantics = {
    visual_role: `${humanizeIdentifier(element.name)} interface`,
    emphasis: "secondary",
    density: "comfortable",
    chrome: pattern === "shell" ? "full_shell" : pattern === "dialog" ? "panel" : "embedded",
    state_styling: [],
  };
  element.layout_semantics = {
    pattern,
    alignment: /justify-content\s*:\s*(?:space-between|space-around)|justify-between/.test(source) ? "distributed" : "leading",
    sizing_behavior: /width\s*:\s*100%|flex\s*:\s*1|w-full|h-full/.test(source) ? "fill_parent" : "fluid",
    responsive_behavior: /overflow|scroll/.test(source) ? ["scroll"] : ["wrap"],
    hierarchy: [{ region: rootTag, role: "primary" }],
  };
  element.description = `${element.name} is a React UI component whose ${rootTag}-rooted view renders ${inputs.length > 0 ? `from ${inputs.length} source-defined input${inputs.length === 1 ? "" : "s"}` : "from local or contextual state"}. ` +
    `${events.size > 0 ? `It handles ${[...events].join(", ")} interactions` : "It is source-evidenced as a passive rendering surface"} and participates in a ${pattern.replace("_", " ")} layout. ` +
    "Its scanner-derived contract and composition links provide grounded structure for deeper LLM enrichment.";
  element.purpose = `${humanizeIdentifier(element.name)} UI surface`;
  element.intent = `Present and operate the ${humanizeIdentifier(element.name)} user-facing responsibility through the inputs, interactions, and composition evidenced in its React source.`;
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
    description: `${componentName} is a ${framework} UI component implemented in ${file.rel}; its source is the evidence boundary for semantic enrichment of behavior, data contract, appearance, and layout.`,
    purpose: `${framework} component '${componentName}' detected by scanner in ${file.rel}. Enrich for narrative description.`,
    category: "composite",
    data_contract: {
      inputs: [],
      outputs: [{
        name: "rendered_view",
        type: "ui",
        description: `${componentName} renders the ${framework} interface defined by ${file.rel}.`,
        trigger: "render",
      }],
    },
    interactions: [],
    implementations: [
      {
        platform: framework,
        component: componentName,
        source_file: file.rel,
      },
    ],
    used_by: [],
    children: [],
    tags: ["scanner", framework],
    source_kind: "scanner",
    source_repo: repoName,
    source_file: file.rel,
    evidence_refs: [file.rel],
    intent: `Represent the ${humanizeIdentifier(componentName)} user-facing responsibility defined by the ${framework} source component.`,
    visual_semantics: {
      visual_role: `${humanizeIdentifier(componentName)} interface`,
      emphasis: "secondary",
      density: "comfortable",
      chrome: "embedded",
      state_styling: [],
    },
    layout_semantics: {
      pattern: "flow",
      alignment: "leading",
      sizing_behavior: "fluid",
      responsive_behavior: ["wrap"],
      hierarchy: [{ region: "content", role: "primary" }],
    },
  };
}

async function extractFromFile(
  repoName: string,
  file: ScannedFile,
  framework: Framework,
  diagnostics: UiScanDiagnostic[],
  sourceByFile: Map<string, string>,
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
    sourceByFile.set(file.rel, source);
    const names = extractReactComponentNames(source);
    if (names.length === 0) {
      // Fall back to filename if it looks like a component; many React
      // files use `export default Foo` patterns the regexes miss
      // (HOCs, memo wrappers, etc.). Filename-based fallback keeps
      // coverage high without hallucinating arbitrary identifiers.
      const stemName = componentNameFromFile(file);
      if (!stemName) return [];
      const fallback = buildElement({ repoName, file, framework, componentName: stemName });
      applyReactSourceFacts(fallback, source);
      return [fallback];
    }
    return names.map((name) => {
      const element = buildElement({ repoName, file, framework, componentName: name });
      applyReactSourceFacts(element, source);
      return element;
    });
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
  const sourceByFile = new Map<string, string>();
  for (const file of candidates) {
    const framework = frameworkFor(file)!;
    let perFile: SemanticElement[];
    try {
      perFile = await extractFromFile(scan.repoName, file, framework, quality.diagnostics, sourceByFile);
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

  // Convert source-evidenced JSX composition into reciprocal graph structure.
  // Duplicate component names are intentionally not resolved: selecting one
  // would manufacture an edge without enough source evidence.
  const idsByName = new Map<string, string[]>();
  for (const element of elements) {
    const ids = idsByName.get(element.name) ?? [];
    ids.push(element.id);
    idsByName.set(element.name, ids);
  }
  const elementsById = new Map(elements.map((element) => [element.id, element]));
  for (const parent of elements) {
    const source = parent.source_file ? sourceByFile.get(parent.source_file) : undefined;
    if (!source) continue;
    const childIds = new Set(parent.children ?? []);
    for (const match of source.matchAll(/<([A-Z][A-Za-z0-9_]*)\b/g)) {
      const componentName = match[1];
      const candidatesForName = idsByName.get(componentName) ?? [];
      if (candidatesForName.length !== 1) continue;
      const childId = candidatesForName[0];
      if (childId === parent.id || childIds.has(childId)) continue;
      childIds.add(childId);
      parent.links = [...(parent.links ?? []), {
        target: childId,
        type: "ui_element",
        relationship: "composes",
        description: `${parent.name} renders ${componentName} in ${parent.source_file}.`,
        strength: "strong",
        meta: {
          selected_by: "native-ui-scanner",
          evidence_excerpt: `<${componentName}`,
          source_file: parent.source_file,
        },
      }];
      const child = elementsById.get(childId);
      if (child && !child.used_by.includes(parent.id)) child.used_by.push(parent.id);
    }
    parent.children = [...childIds];
    if (childIds.size > 0) {
      const childNames = [...childIds].map((id) => elementsById.get(id)?.name ?? id);
      parent.description = `${parent.description} It composes ${childNames.join(", ")} as source-evidenced child UI.`;
    }
  }

  return { elements, quality };
}
