/**
 * DreamGraph — Scanner extractor types.
 *
 * Defines the contract that every per-language extractor (C, C++, Rust,
 * regex-fallback, …) satisfies. The orchestrator in `scan-project.ts`
 * dispatches files through a registry of `Extractor` instances and
 * collects their `ExtractorOutput` for emission into the graph stores.
 *
 * Layering:
 *   - This module imports from `./ontology` for entity/relationship
 *     vocabulary. No other runtime deps.
 *   - Extractors live in `./extractors/`.
 *   - `emit.ts` (separate module, not in this commit) maps
 *     `ExtractorOutput` onto the existing on-disk shapes
 *     (`Feature`, `DataModelEntity`, `Workflow`, `GraphLink`).
 *
 * Companion to plans/polyglot-graph-scanning-implementation-plan.md §4.
 */

import type {
  Confidence,
  EdgeEvidence,
  EntityKind,
  FieldRole,
  Relationship,
} from "./ontology.js";

// ---------------------------------------------------------------------------
// Input to an extractor
// ---------------------------------------------------------------------------

/**
 * Input passed to `Extractor.extract` for one file.
 *
 * The orchestrator owns file discovery and reading; the extractor only
 * sees the bytes and a few coordinates. This keeps extractors pure and
 * independently testable.
 */
export interface ExtractFileInput {
  /** Absolute path to the file on disk. */
  absPath: string;
  /** Workspace-relative path (POSIX-style separators). */
  relPath: string;
  /** Source text already decoded as UTF-8. */
  source: string;
  /** Language hint resolved by file extension (e.g. "c", "cpp", "rust"). */
  language: string;
  /** Workspace-relative directory parts, e.g. ["src", "core"]. */
  dirParts: readonly string[];
  /** File base name (`foo.c`). */
  name: string;
  /** File extension including the dot (`.c`). */
  ext: string;
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/**
 * One graph node produced by an extractor.
 *
 * `id` is a stable, content-derived key the extractor mints itself.
 * Convention (enforced by tests, not the type system):
 *   `${language}:${relPath}#${qualifiedName}` for code entities;
 *   `${language}:${relPath}` for file entities;
 *   `${language}:${relPath}#${kind}:${owner}.${name}` for fields/members.
 *
 * `attrs` is an open bag for kind-specific data (e.g. `pointer_depth`,
 * `is_const`, `template_parameters`). Downstream consumers must treat
 * unknown attrs as opaque.
 */
export interface ExtractedEntity {
  id: string;
  kind: EntityKind;
  name: string;
  qualifiedName: string;
  language: string;
  relPath: string;
  /** 1-based line of the entity's primary location. */
  line?: number;
  /** 1-based column of the entity's primary location. */
  column?: number;
  attrs?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

/**
 * One directed edge between two entities. The endpoints reference
 * `ExtractedEntity.id` strings. Cross-file edges are allowed; the
 * orchestrator joins them after every file has been extracted.
 */
export interface ExtractedEdge {
  /** Source entity id. */
  from: string;
  /** Target entity id. May be unresolved at extraction time (a placeholder). */
  to: string;
  /** Canonical edge label from the ontology. */
  relationship: Relationship;
  /** Provenance + line/column of the evidence. */
  evidence: EdgeEvidence;
  /** Optional role of the source field within the data shape (e.g. "next"). */
  fieldRole?: FieldRole;
  /** Extra edge-specific metadata (pointer depth, const-qualified, …). */
  meta?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

/**
 * Architectural shape detected across one or more entities (linked list,
 * array-with-count, intrusive list, opaque handle, …). Emitted as a
 * synthesised node plus participation edges so the explorer can show
 * "this struct *is* a linked list" without losing the underlying
 * declarations.
 */
export interface ExtractedShape {
  /** Stable id minted by the extractor (e.g. `${language}:shape:${kind}:${anchorId}`). */
  id: string;
  /** Shape kind from `DataShapeKind`. */
  kind: EntityKind;
  /** Human-readable label for explorers. */
  name: string;
  /** Detection confidence. */
  confidence: Confidence;
  /** Entities that participate in the shape (struct, fields, etc.). */
  participants: readonly string[];
  /** Optional per-participant role map. */
  roles?: Readonly<Record<string, FieldRole>>;
  /** Free-form notes (rule fired, supporting field names, …). */
  notes?: string;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export type DiagnosticSeverity = "info" | "warning" | "error";

/**
 * Non-fatal extractor diagnostics surfaced into `ScanProjectResult` so
 * users can see what the parser couldn't handle.
 */
export interface ExtractorDiagnostic {
  severity: DiagnosticSeverity;
  relPath: string;
  message: string;
  line?: number;
  column?: number;
}

// ---------------------------------------------------------------------------
// Output of one extractor invocation
// ---------------------------------------------------------------------------

/**
 * Aggregate output of running an extractor against one file.
 */
export interface ExtractorOutput {
  entities: ExtractedEntity[];
  edges: ExtractedEdge[];
  shapes: ExtractedShape[];
  diagnostics: ExtractorDiagnostic[];
}

// ---------------------------------------------------------------------------
// Extractor interface
// ---------------------------------------------------------------------------

/**
 * Stable contract every extractor implements. Pure: no I/O beyond the
 * incoming source string, no global state, idempotent for a given input.
 */
export interface Extractor {
  /** Short identifier used in evidence (`"c"`, `"cpp"`, `"rust"`). */
  readonly name: string;
  /** Extractor version. Bump when extraction semantics change. */
  readonly version: string;
  /** File extensions this extractor handles (lowercase, including the dot). */
  readonly extensions: readonly string[];
  /** True when backed by a real parser (tree-sitter etc.). */
  readonly parserBacked: boolean;
  /** Run the extractor against one file. */
  extract(file: ExtractFileInput): Promise<ExtractorOutput>;
}
