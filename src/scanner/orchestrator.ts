/**
 * DreamGraph — cross-file linker (wave 1, phase C-3).
 *
 * Per-file extractors are intentionally narrow: they can only see one
 * translation unit at a time, so they emit symbolic placeholders for
 * cross-file references:
 *
 *   - `INCLUDES` edges point at `c:include:<path>` rather than a real
 *     file entity, because the included header may live in a different
 *     file the extractor never saw.
 *   - `POINTS_TO` / `POINTS_TO_POINTER` edges point at `c:type:<Name>`,
 *     because the underlying struct / typedef may be defined elsewhere.
 *   - Function prototypes (`is_definition:false`) and definitions
 *     (`is_definition:true`) live in different files (`.h` vs `.c`) and
 *     must be stitched together.
 *
 * The orchestrator runs after all per-file extractor outputs are in.
 * It is a pure function: same inputs → same outputs. It never mutates
 * the input arrays.
 *
 * Resolution rules:
 *
 *   1. INCLUDES: match `c:include:<path>` to a file entity whose
 *      relPath has the same basename (when the include uses a bare
 *      filename like `"foo.h"`) or whose relPath ends with the include
 *      path. Ambiguous matches (≥2 candidates) are left unresolved and
 *      surfaced as a diagnostic so the caller can act on it.
 *
 *   2. POINTS_TO: rewrite `c:type:<Name>` when exactly one Struct,
 *      Union, Enum, or TypeAlias entity across the project carries
 *      that name. Multi-match is left unresolved + diagnostic.
 *
 *   3. BINDS_DECLARATION_TO_DEFINITION: when a Function entity with
 *      `attrs.is_definition === false` shares a name with a Function
 *      entity carrying `attrs.is_definition === true` in another file,
 *      emit a new edge from the declaration to the definition. If the
 *      same name has multiple definitions, no edge is emitted and a
 *      diagnostic is added.
 *
 * Failure mode: when resolution can't be done unambiguously, the edge
 * is left exactly as the extractor emitted it (symbolic target,
 * `meta.resolved:false`). Consumers can still see the intent and the
 * orchestrator surfaces a `warning` diagnostic naming the conflict.
 */

import { Confidence, Relationship } from "./ontology.js";
import type {
  ExtractedEdge,
  ExtractedEntity,
  ExtractorDiagnostic,
  ExtractorOutput,
  ExtractedShape,
} from "./types.js";

/** Aggregated, cross-file-resolved view of a multi-file project. */
export interface ProjectGraph {
  readonly entities: readonly ExtractedEntity[];
  readonly edges: readonly ExtractedEdge[];
  readonly shapes: readonly ExtractedShape[];
  readonly diagnostics: readonly ExtractorDiagnostic[];
}

const TYPE_KINDS = new Set<string>(["Struct", "Union", "Enum", "TypeAlias"]);

const ORCHESTRATOR_EVIDENCE = {
  extractor: "orchestrator",
  extractor_version: "0.1.0",
  parser_backed: true,
  confidence: Confidence.High,
  language: "*",
} as const;

/**
 * Resolve cross-file references across a batch of per-file extractor
 * outputs. Inputs are not mutated; a fresh `ProjectGraph` is returned.
 */
export function linkProject(outputs: readonly ExtractorOutput[]): ProjectGraph {
  // Flatten while preserving order so caller-visible edge order stays
  // deterministic for snapshot tests.
  const entities: ExtractedEntity[] = [];
  const shapes: ExtractedShape[] = [];
  const diagnostics: ExtractorDiagnostic[] = [];
  const rawEdges: ExtractedEdge[] = [];

  for (const out of outputs) {
    entities.push(...out.entities);
    shapes.push(...out.shapes);
    diagnostics.push(...out.diagnostics);
    rawEdges.push(...out.edges);
  }

  // --- Indexes used during resolution ------------------------------------

  // file entities by relPath (SourceFile / HeaderFile)
  const fileByRelPath = new Map<string, ExtractedEntity>();
  // file entities indexed by basename → list of matching relPaths
  const filesByBasename = new Map<string, ExtractedEntity[]>();
  // type-like entities (Struct/Union/Enum/TypeAlias) by name → list
  const typesByName = new Map<string, ExtractedEntity[]>();
  // function entities by name, partitioned by definition vs declaration
  const fnDefsByName = new Map<string, ExtractedEntity[]>();
  const fnDeclsByName = new Map<string, ExtractedEntity[]>();

  for (const e of entities) {
    if (e.kind === "SourceFile" || e.kind === "HeaderFile") {
      fileByRelPath.set(e.relPath, e);
      const base = baseName(e.relPath);
      const bucket = filesByBasename.get(base) ?? [];
      bucket.push(e);
      filesByBasename.set(base, bucket);
      continue;
    }
    if (TYPE_KINDS.has(e.kind)) {
      const bucket = typesByName.get(e.name) ?? [];
      bucket.push(e);
      typesByName.set(e.name, bucket);
      continue;
    }
    if (e.kind === "Function") {
      const isDef = e.attrs?.is_definition === true;
      const target = isDef ? fnDefsByName : fnDeclsByName;
      const bucket = target.get(e.name) ?? [];
      bucket.push(e);
      target.set(e.name, bucket);
    }
  }

  // --- Edge rewriting ----------------------------------------------------

  const resolved: ExtractedEdge[] = [];
  for (const edge of rawEdges) {
    if (edge.relationship === Relationship.INCLUDES &&
        edge.to.startsWith("c:include:")) {
      resolved.push(resolveInclude(edge, filesByBasename, diagnostics));
      continue;
    }
    if ((edge.relationship === Relationship.POINTS_TO ||
         edge.relationship === Relationship.POINTS_TO_POINTER) &&
        edge.to.startsWith("c:type:")) {
      resolved.push(resolvePointerTarget(edge, typesByName, diagnostics));
      continue;
    }
    resolved.push(edge);
  }

  // --- Synthesise BINDS_DECLARATION_TO_DEFINITION edges ------------------

  for (const [name, decls] of fnDeclsByName) {
    const defs = fnDefsByName.get(name);
    if (!defs || defs.length === 0) continue;
    if (defs.length > 1) {
      diagnostics.push({
        severity: "warning",
        relPath: "<project>",
        message: `Function "${name}" has ${defs.length} definitions; ` +
          `cannot bind declarations unambiguously.`,
      });
      continue;
    }
    const def = defs[0]!;
    for (const decl of decls) {
      // Skip self-binding: if a decl and def share the same file/line,
      // they're the same entity emitted twice (shouldn't happen, but be
      // safe).
      if (decl.id === def.id) continue;
      resolved.push({
        from: decl.id,
        to: def.id,
        relationship: Relationship.BINDS_DECLARATION_TO_DEFINITION,
        evidence: {
          ...ORCHESTRATOR_EVIDENCE,
          line: decl.line,
          column: decl.column,
        },
      });
    }
  }

  return { entities, edges: resolved, shapes, diagnostics };
}

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

function baseName(relPath: string): string {
  const i = Math.max(relPath.lastIndexOf("/"), relPath.lastIndexOf("\\"));
  return i >= 0 ? relPath.slice(i + 1) : relPath;
}

function resolveInclude(
  edge: ExtractedEdge,
  filesByBasename: Map<string, ExtractedEntity[]>,
  diagnostics: ExtractorDiagnostic[],
): ExtractedEdge {
  // The extractor stores the original `path` and `system` flag in
  // edge.meta. System headers (e.g. `<stdio.h>`) are intentionally NOT
  // resolved against project files: a project file named `stdio.h`
  // would otherwise hijack the system include.
  const meta = edge.meta ?? {};
  if (meta.system === true) return edge;
  const path = typeof meta.path === "string" ? meta.path : "";
  if (!path) return edge;
  const base = baseName(path);
  const candidates = filesByBasename.get(base) ?? [];
  // Prefer candidates whose relPath ends with the literal include path,
  // because `#include "subsys/foo.h"` should bind to `.../subsys/foo.h`
  // even if other `foo.h` files exist in the project.
  const exact = candidates.filter((c) =>
    c.relPath === path || c.relPath.endsWith(`/${path}`),
  );
  const pool = exact.length > 0 ? exact : candidates;
  if (pool.length === 0) return edge;
  if (pool.length > 1) {
    diagnostics.push({
      severity: "warning",
      relPath: "<project>",
      message: `#include "${path}" matches ${pool.length} files; ` +
        `leaving unresolved.`,
    });
    return edge;
  }
  const target = pool[0]!;
  return {
    ...edge,
    to: target.id,
    meta: { ...meta, resolved: true },
  };
}

function resolvePointerTarget(
  edge: ExtractedEdge,
  typesByName: Map<string, ExtractedEntity[]>,
  diagnostics: ExtractorDiagnostic[],
): ExtractedEdge {
  const meta = edge.meta ?? {};
  const baseType = typeof meta.base_type === "string" ? meta.base_type : "";
  if (!baseType) return edge;
  const candidates = typesByName.get(baseType) ?? [];
  if (candidates.length === 0) return edge;
  if (candidates.length > 1) {
    diagnostics.push({
      severity: "warning",
      relPath: "<project>",
      message: `Pointer target "${baseType}" matches ${candidates.length} ` +
        `type entities; leaving unresolved.`,
    });
    return edge;
  }
  return {
    ...edge,
    to: candidates[0]!.id,
    meta: { ...meta, resolved: true },
  };
}
