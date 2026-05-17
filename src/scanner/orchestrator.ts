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

import { Confidence, DataShapeKind, FieldRole, Relationship } from "./ontology.js";
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

  // --- C-4: detect linked-list shapes -----------------------------------

  const detected = detectLinkedListShapes(entities);
  shapes.push(...detected.shapes);
  resolved.push(...detected.participationEdges);

  // --- C-5: intrusive lists, array-with-count, opaque handles -----------

  const linkedListAnchors = new Set<string>(
    detected.shapes.map((s) => s.participants[0]!),
  );
  const c5 = detectC5Shapes(entities, linkedListAnchors);
  shapes.push(...c5.shapes);
  resolved.push(...c5.participationEdges);

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

// ---------------------------------------------------------------------------
// C-4: linked-list shape detection
// ---------------------------------------------------------------------------

/**
 * Rule:
 *   - Singly linked: exactly one Field on the struct whose
 *     `pointer_depth === 1` and `base_type === struct.name` (self-pointer).
 *   - Doubly linked: exactly two such self-pointer fields. Field roles
 *     (next / prev) are assigned by conventional name when available
 *     ("next", "prev"/"previous", "fwd"/"bwd"); otherwise by source
 *     order: first declared → next, second declared → prev.
 *
 * The detection is intentionally conservative: a self-pointer through a
 * typedef alias whose name differs from the struct's `name` field will
 * NOT be matched here. C-5's shape rules pick up the harder cases
 * (intrusive lists, opaque handles).
 */
function detectLinkedListShapes(
  entities: readonly ExtractedEntity[],
): { shapes: ExtractedShape[]; participationEdges: ExtractedEdge[] } {
  const fieldsByOwnerId = new Map<string, ExtractedEntity[]>();
  const structs: ExtractedEntity[] = [];

  for (const e of entities) {
    if (e.kind === "Struct") {
      structs.push(e);
      continue;
    }
    if (e.kind !== "Field") continue;
    const ownerName = e.qualifiedName.split(".")[0];
    if (!ownerName) continue;
    // Reconstruct owner id deterministically using the same convention
    // the extractor uses (`<lang>:<relPath>#Struct:<name>`). The owner
    // and field always share the same relPath because fields are
    // emitted while walking the struct body.
    const ownerId = `${e.language}:${e.relPath}#Struct:${ownerName}`;
    const bucket = fieldsByOwnerId.get(ownerId) ?? [];
    bucket.push(e);
    fieldsByOwnerId.set(ownerId, bucket);
  }

  const shapes: ExtractedShape[] = [];
  const edges: ExtractedEdge[] = [];

  for (const s of structs) {
    const fields = fieldsByOwnerId.get(s.id) ?? [];
    const selfPtrs = fields.filter(
      (f) =>
        f.attrs?.pointer_depth === 1 &&
        f.attrs?.base_type === s.name,
    );
    if (selfPtrs.length === 1) {
      const next = selfPtrs[0]!;
      const shape: ExtractedShape = {
        id: `${s.language}:shape:LinkedListShape:${s.id}`,
        kind: DataShapeKind.LinkedListShape,
        name: `${s.name} (singly linked)`,
        confidence: Confidence.High,
        participants: [s.id, next.id],
        roles: { [next.id]: FieldRole.Next },
        notes: `Self-pointer field "${next.name}" makes "${s.name}" ` +
          `a singly-linked list node.`,
      };
      shapes.push(shape);
      edges.push(
        participation(s.id, shape.id, s.line, s.column),
        participation(next.id, shape.id, next.line, next.column),
      );
      continue;
    }
    if (selfPtrs.length === 2) {
      const { next, prev } = pickDoublyRoles(selfPtrs);
      const shape: ExtractedShape = {
        id: `${s.language}:shape:DoublyLinkedListShape:${s.id}`,
        kind: DataShapeKind.DoublyLinkedListShape,
        name: `${s.name} (doubly linked)`,
        confidence: Confidence.High,
        participants: [s.id, next.id, prev.id],
        roles: {
          [next.id]: FieldRole.Next,
          [prev.id]: FieldRole.Previous,
        },
        notes: `Self-pointer fields "${next.name}" and "${prev.name}" ` +
          `make "${s.name}" a doubly-linked list node.`,
      };
      shapes.push(shape);
      edges.push(
        participation(s.id, shape.id, s.line, s.column),
        participation(next.id, shape.id, next.line, next.column),
        participation(prev.id, shape.id, prev.line, prev.column),
      );
    }
  }

  return { shapes, participationEdges: edges };
}

function pickDoublyRoles(
  ptrs: readonly ExtractedEntity[],
): { next: ExtractedEntity; prev: ExtractedEntity } {
  const NEXT_NAMES = new Set(["next", "fwd", "forward"]);
  const PREV_NAMES = new Set(["prev", "previous", "bwd", "back", "backward"]);
  const a = ptrs[0]!;
  const b = ptrs[1]!;
  const aName = a.name.toLowerCase();
  const bName = b.name.toLowerCase();
  if (NEXT_NAMES.has(aName) && PREV_NAMES.has(bName)) return { next: a, prev: b };
  if (NEXT_NAMES.has(bName) && PREV_NAMES.has(aName)) return { next: b, prev: a };
  if (NEXT_NAMES.has(aName)) return { next: a, prev: b };
  if (NEXT_NAMES.has(bName)) return { next: b, prev: a };
  if (PREV_NAMES.has(aName)) return { next: b, prev: a };
  if (PREV_NAMES.has(bName)) return { next: a, prev: b };
  // Fall back to declaration order.
  return { next: a, prev: b };
}

function participation(
  from: string,
  to: string,
  line?: number,
  column?: number,
): ExtractedEdge {
  return {
    from,
    to,
    relationship: Relationship.PARTICIPATES_IN,
    evidence: {
      ...ORCHESTRATOR_EVIDENCE,
      line,
      column,
    },
  };
}

// ---------------------------------------------------------------------------
// C-5: intrusive list, array-with-count, opaque handle
// ---------------------------------------------------------------------------

const COUNT_NAME = /^(count|len|length|size|num|n|n_.*|nb_.*|num_.*|nelem|nelements|nitems|nitem|elem_count|item_count)$/i;
const CAPACITY_NAME = /^(cap|capacity|alloc|allocated|reserved)$/i;
const INTEGER_TYPES = new Set([
  "int", "unsigned", "unsigned int", "signed int", "long", "long int",
  "unsigned long", "long long", "unsigned long long", "short",
  "unsigned short", "size_t", "ssize_t", "ptrdiff_t",
  "int8_t", "int16_t", "int32_t", "int64_t",
  "uint8_t", "uint16_t", "uint32_t", "uint64_t",
]);

/**
 * Detection rules, in evaluation order:
 *
 *   1. IntrusiveListShape — a struct contains a field, BY VALUE
 *      (pointer_depth === 0), whose `base_type` names another struct
 *      that itself was already classified as a LinkedListShape /
 *      DoublyLinkedListShape anchor. Typical Linux-kernel pattern:
 *      `struct list_head` embedded inside a payload struct.
 *
 *   2. ArrayWithCountShape — a struct has at least one pointer field
 *      AND at least one integer-typed field whose name matches the
 *      conventional count/capacity vocabulary. The pointer is tagged
 *      with role `pointer`; the integer with role `count` or
 *      `capacity` based on its name.
 *
 *   3. HandleTableShape (opaque handle) — a TypeAlias whose aliased
 *      text reduces to `struct X *` AND no Struct named `X` exists in
 *      the project graph. The TypeAlias is the sole participant.
 */
function detectC5Shapes(
  entities: readonly ExtractedEntity[],
  linkedListAnchors: ReadonlySet<string>,
): { shapes: ExtractedShape[]; participationEdges: ExtractedEdge[] } {
  const shapes: ExtractedShape[] = [];
  const edges: ExtractedEdge[] = [];

  // Index Struct entities by name → list of ids. A name may map to
  // multiple structs across files; we keep all of them.
  const structIdsByName = new Map<string, string[]>();
  for (const e of entities) {
    if (e.kind !== "Struct") continue;
    const bucket = structIdsByName.get(e.name) ?? [];
    bucket.push(e.id);
    structIdsByName.set(e.name, bucket);
  }

  // Group fields by owner struct id (same key reconstruction trick as C-4).
  const fieldsByOwnerId = new Map<string, ExtractedEntity[]>();
  for (const e of entities) {
    if (e.kind !== "Field") continue;
    const ownerName = e.qualifiedName.split(".")[0];
    if (!ownerName) continue;
    const ownerId = `${e.language}:${e.relPath}#Struct:${ownerName}`;
    const bucket = fieldsByOwnerId.get(ownerId) ?? [];
    bucket.push(e);
    fieldsByOwnerId.set(ownerId, bucket);
  }

  // --- 1. IntrusiveListShape ---------------------------------------------
  for (const struct of entities) {
    if (struct.kind !== "Struct") continue;
    const fields = fieldsByOwnerId.get(struct.id) ?? [];
    for (const f of fields) {
      const depth = (f.attrs?.pointer_depth as number | undefined) ?? 0;
      if (depth !== 0) continue;
      const baseType = (f.attrs?.base_type as string | undefined) ?? "";
      if (!baseType) continue;
      const candidateIds = structIdsByName.get(baseType) ?? [];
      const anchorId = candidateIds.find((id) => linkedListAnchors.has(id));
      if (!anchorId) continue;
      // Don't classify the list-node anchor itself as intrusive.
      if (struct.id === anchorId) continue;
      const shape: ExtractedShape = {
        id: `${struct.language}:shape:IntrusiveListShape:${struct.id}#${f.name}`,
        kind: DataShapeKind.IntrusiveListShape,
        name: `${struct.name} embeds list node "${baseType}" via "${f.name}"`,
        confidence: Confidence.Medium,
        participants: [struct.id, f.id, anchorId],
        roles: { [f.id]: FieldRole.Next },
        notes: `Struct "${struct.name}" embeds linked-list anchor ` +
          `"${baseType}" as field "${f.name}" by value.`,
      };
      shapes.push(shape);
      edges.push(
        participation(struct.id, shape.id, struct.line, struct.column),
        participation(f.id, shape.id, f.line, f.column),
      );
    }
  }

  // --- 2. ArrayWithCountShape --------------------------------------------
  for (const struct of entities) {
    if (struct.kind !== "Struct") continue;
    const fields = fieldsByOwnerId.get(struct.id) ?? [];
    const pointers = fields.filter(
      (f) => ((f.attrs?.pointer_depth as number | undefined) ?? 0) >= 1,
    );
    if (pointers.length === 0) continue;
    const countField = fields.find(
      (f) =>
        ((f.attrs?.pointer_depth as number | undefined) ?? 0) === 0 &&
        COUNT_NAME.test(f.name) &&
        isIntegerType(f.attrs?.type_text as string | undefined),
    );
    const capacityField = fields.find(
      (f) =>
        ((f.attrs?.pointer_depth as number | undefined) ?? 0) === 0 &&
        CAPACITY_NAME.test(f.name) &&
        isIntegerType(f.attrs?.type_text as string | undefined),
    );
    if (!countField && !capacityField) continue;
    // Choose the most likely "data pointer": prefer a depth-1 pointer
    // whose name isn't `next`/`prev`/`first` (those belong to lists).
    const dataPtr =
      pointers.find(
        (p) =>
          ((p.attrs?.pointer_depth as number | undefined) ?? 0) === 1 &&
          !LIST_NAMES.has(p.name.toLowerCase()),
      ) ?? pointers[0]!;
    const roles: Record<string, FieldRole> = {
      [dataPtr.id]: FieldRole.Pointer,
    };
    const participants = [struct.id, dataPtr.id];
    if (countField) {
      roles[countField.id] = FieldRole.Count;
      participants.push(countField.id);
    }
    if (capacityField) {
      roles[capacityField.id] = FieldRole.Capacity;
      participants.push(capacityField.id);
    }
    const shape: ExtractedShape = {
      id: `${struct.language}:shape:ArrayWithCountShape:${struct.id}`,
      kind: DataShapeKind.ArrayWithCountShape,
      name: `${struct.name} (array + count)`,
      confidence: Confidence.Medium,
      participants,
      roles,
      notes: `Struct "${struct.name}" pairs pointer field "${dataPtr.name}" ` +
        `with ${countField ? `count "${countField.name}"` : ""}` +
        `${countField && capacityField ? " and " : ""}` +
        `${capacityField ? `capacity "${capacityField.name}"` : ""}.`,
    };
    shapes.push(shape);
    edges.push(
      participation(struct.id, shape.id, struct.line, struct.column),
      participation(dataPtr.id, shape.id, dataPtr.line, dataPtr.column),
    );
    if (countField) {
      edges.push(participation(countField.id, shape.id, countField.line, countField.column));
    }
    if (capacityField) {
      edges.push(participation(capacityField.id, shape.id, capacityField.line, capacityField.column));
    }
  }

  // --- 3. HandleTableShape (opaque handle) -------------------------------
  for (const alias of entities) {
    if (alias.kind !== "TypeAlias") continue;
    const aliased = (alias.attrs?.aliased_text as string | undefined) ?? "";
    const m = /typedef\s+struct\s+(\w+)\s*\*\s*\w+\s*;/.exec(aliased);
    if (!m) continue;
    const targetName = m[1]!;
    // Opaque iff there is NO Struct named `targetName` defined anywhere
    // in the scanned project — i.e. the implementation is hidden.
    if ((structIdsByName.get(targetName) ?? []).length > 0) continue;
    const shape: ExtractedShape = {
      id: `${alias.language}:shape:HandleTableShape:${alias.id}`,
      kind: DataShapeKind.HandleTableShape,
      name: `${alias.name} (opaque handle to struct ${targetName})`,
      confidence: Confidence.Medium,
      participants: [alias.id],
      notes: `Typedef "${alias.name}" exposes "struct ${targetName} *" but ` +
        `the struct definition is not visible in this project.`,
    };
    shapes.push(shape);
    edges.push(participation(alias.id, shape.id, alias.line, alias.column));
  }

  return { shapes, participationEdges: edges };
}

const LIST_NAMES = new Set(["next", "prev", "previous", "first", "tail", "head"]);

function isIntegerType(text: string | undefined): boolean {
  if (!text) return false;
  const norm = text.replace(/\s+/g, " ").replace(/^const\s+/, "").trim();
  return INTEGER_TYPES.has(norm);
}
