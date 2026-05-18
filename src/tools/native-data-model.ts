/**
 * DreamGraph — Native (parser-backed) data-model bridge.
 *
 * Wires the tree-sitter C / C++ extractors into `scan_project`. For
 * each C/C++ source file discovered by the project scan we run the
 * appropriate extractor, link the per-file outputs together with
 * `linkProject`, and convert every type-like entity (struct, union,
 * enum, typedef, class) into a `DataModelEntity`-shaped record that
 * can be merged into `data_model.json` alongside the heuristic
 * structural fallback.
 *
 * Design notes:
 *   - Pure transformation; the only I/O is reading file contents.
 *   - Extractor failures are diagnosed and treated as non-fatal:
 *     a broken file just doesn't contribute parser-backed coverage.
 *   - Output entries follow the same shape consumed by
 *     `generateStructuralDataModel`, so the existing `mergeById`
 *     pipeline can fold them into the seed file without special-casing.
 */

import fs from "node:fs/promises";
import type { Extractor, ExtractedEntity, ExtractorDiagnostic, ExtractorOutput } from "../scanner/types.js";
import { cExtractor } from "../scanner/extractors/c.js";
import { cppExtractor } from "../scanner/extractors/cpp.js";
import { rustExtractor } from "../scanner/extractors/rust.js";
import { javaExtractor } from "../scanner/extractors/java.js";
import { kotlinExtractor } from "../scanner/extractors/kotlin.js";
import { pythonExtractor } from "../scanner/extractors/python.js";
import { csharpExtractor } from "../scanner/extractors/csharp.js";
import { gradleExtractor } from "../scanner/extractors/gradle.js";
import { linkProject } from "../scanner/orchestrator.js";
import { CodeEntityKind, Relationship } from "../scanner/ontology.js";
import { logger } from "../utils/logger.js";
import { inferDomain, toSnakeCase, toTitleCase } from "./structural-generators.js";
import type { ProjectScan, ScannedFile } from "./scan-types.js";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Ordered list of native extractors. The first match in `extensions`
 * wins for any given file; this matters for `.h` (C wins over C++) so
 * mixed projects don't double-parse headers.
 */
const NATIVE_EXTRACTORS: readonly Extractor[] = [gradleExtractor, cExtractor, cppExtractor, rustExtractor, javaExtractor, kotlinExtractor, pythonExtractor, csharpExtractor];

const EXTENSION_TO_EXTRACTOR = new Map<string, Extractor>();
for (const ext of NATIVE_EXTRACTORS) {
  for (const e of ext.extensions) {
    if (!EXTENSION_TO_EXTRACTOR.has(e)) {
      EXTENSION_TO_EXTRACTOR.set(e, ext);
    }
  }
}

function pickExtractor(file: ScannedFile): Extractor | undefined {
  // Specialised matches() predicates take precedence over extension
  // dispatch — e.g. the gradle extractor claims `build.gradle.kts`
  // before kotlin can. Ordering follows NATIVE_EXTRACTORS registration.
  for (const ext of NATIVE_EXTRACTORS) {
    if (ext.matches && ext.matches(file)) return ext;
  }
  return EXTENSION_TO_EXTRACTOR.get(file.ext.toLowerCase());
}

/** File-extension presence check used by `scan_project` to decide whether to invoke the bridge at all. */
export function hasNativeCodeFiles(scan: ProjectScan): boolean {
  return scan.files.some((f) => pickExtractor(f) !== undefined);
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

// Mirror of the orchestrator's TYPE_KINDS. Kept language-agnostic so a
// Rust `Struct`, a C++ `Class`, and a Java `Interface` all surface as
// data-model entries through the same code path.
const TYPE_KINDS = new Set<string>([
  CodeEntityKind.Struct,
  CodeEntityKind.Union,
  CodeEntityKind.Enum,
  CodeEntityKind.TypeAlias,
  CodeEntityKind.Class,
  CodeEntityKind.Trait,
  CodeEntityKind.Interface,
  CodeEntityKind.Record,
  CodeEntityKind.Annotation,
]);

/**
 * Default `via` label for each canonical relationship. Extractors MAY
 * override per-edge by setting `edge.meta.via` (e.g. C++ `unique_ptr`
 * vs Rust `box`, both of which carry the OWNS relationship). The
 * relationship itself stays language-agnostic.
 */
const RELATIONSHIP_VIA: Partial<Record<string, string>> = {
  [Relationship.EXTENDS]: "inheritance",
  [Relationship.IMPLEMENTS]: "interface_impl",
  [Relationship.IMPLEMENTS_TRAIT]: "trait_impl",
  [Relationship.OWNS]: "owned",
  [Relationship.OWNS_SHARED]: "shared",
  [Relationship.BORROWS]: "borrow",
  [Relationship.BORROWS_WEAK]: "weak",
  [Relationship.CONTAINS_MANY]: "container",
  [Relationship.MAY_CONTAIN]: "optional",
  [Relationship.MAPS_K_TO_V]: "map",
  [Relationship.EMBEDS]: "value",
  [Relationship.POINTS_TO]: "pointer",
  [Relationship.POINTS_TO_POINTER]: "pointer_to_pointer",
  [Relationship.SPECIALIZES]: "specialization",
  [Relationship.HAS_ANNOTATION]: "annotation",
};

export interface NativeScanQuality {
  /** Files matched by a native extractor that produced output without throwing. */
  parserBackedFiles: number;
  /** All files matched by a native extractor (whether or not extraction succeeded). */
  totalNativeFiles: number;
  /** Non-fatal extractor diagnostics aggregated across the scan. */
  diagnostics: ExtractorDiagnostic[];
}

export interface NativeDataModelResult {
  entries: Record<string, unknown>[];
  quality: NativeScanQuality;
}

/**
 * Run the registered native extractors over every C/C++ file in
 * `scan`, link the results, and convert type-like entities into
 * data-model entry records ready for `mergeById`.
 */
export async function extractNativeDataModel(scan: ProjectScan): Promise<NativeDataModelResult> {
  const candidates: ScannedFile[] = scan.files.filter((f) => pickExtractor(f) !== undefined);
  const quality: NativeScanQuality = {
    parserBackedFiles: 0,
    totalNativeFiles: candidates.length,
    diagnostics: [],
  };
  if (candidates.length === 0) {
    return { entries: [], quality };
  }

  const outputs: ExtractorOutput[] = [];
  for (const file of candidates) {
    const extractor = pickExtractor(file)!;
    let source: string;
    try {
      source = await fs.readFile(file.abs, "utf-8");
    } catch (err) {
      quality.diagnostics.push({
        severity: "warning",
        relPath: file.rel,
        message: `native scan: failed to read file: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    try {
      const output = await extractor.extract({
        absPath: file.abs,
        relPath: file.rel,
        source,
        language: extractor.name,
        name: file.name,
        ext: file.ext,
        dirParts: file.dirParts,
      });
      outputs.push(output);
      quality.diagnostics.push(...output.diagnostics);
      quality.parserBackedFiles += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`native scan: ${extractor.name} extractor failed on ${file.rel}: ${msg}`);
      quality.diagnostics.push({
        severity: "error",
        relPath: file.rel,
        message: `${extractor.name} extractor threw: ${msg}`,
      });
    }
  }

  if (outputs.length === 0) {
    return { entries: [], quality };
  }

  const linked = linkProject(outputs);
  quality.diagnostics.push(...linked.diagnostics);

  const entries = entitiesToDataModel(linked.entities, linked.edges, scan.repoName);
  return { entries, quality };
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

interface IndexedEntities {
  byId: Map<string, ExtractedEntity>;
  fieldsByOwnerQn: Map<string, ExtractedEntity[]>;
}

function indexEntities(entities: readonly ExtractedEntity[]): IndexedEntities {
  const byId = new Map<string, ExtractedEntity>();
  const fieldsByOwnerQn = new Map<string, ExtractedEntity[]>();
  for (const e of entities) {
    byId.set(e.id, e);
    if (e.kind === CodeEntityKind.Field) {
      // Prefer the extractor-supplied owner qualifiedName: it is
      // language-agnostic and immune to separator drift (`::` in C++,
      // `.` in Java/Rust fields, plain struct name in C). All current
      // extractors set this; we fall back to a separator-tolerant
      // suffix strip only if the attr is missing.
      let ownerQn = typeof e.attrs?.owner_qualified_name === "string"
        ? (e.attrs.owner_qualified_name as string)
        : "";
      if (!ownerQn) {
        // Strip the trailing `<sep><name>` segment from the field's
        // qualifiedName, trying `.` first (Java/Rust fields), then
        // `::` (C++), then `.` again as last resort.
        const candidates = [".", "::"];
        for (const sep of candidates) {
          const suffix = `${sep}${e.name}`;
          if (e.qualifiedName.endsWith(suffix)) {
            ownerQn = e.qualifiedName.slice(0, e.qualifiedName.length - suffix.length);
            break;
          }
        }
      }
      if (!ownerQn) continue;
      const bucket = fieldsByOwnerQn.get(ownerQn) ?? [];
      bucket.push(e);
      fieldsByOwnerQn.set(ownerQn, bucket);
    }
  }
  return { byId, fieldsByOwnerQn };
}

function entitiesToDataModel(
  entities: readonly ExtractedEntity[],
  edges: readonly { from: string; to: string; relationship: string; meta?: Readonly<Record<string, unknown>> }[],
  repoName: string,
): Record<string, unknown>[] {
  const idx = indexEntities(entities);
  const seenEntryIds = new Set<string>();
  const out: Record<string, unknown>[] = [];

  // Pre-bucket edges by `from` so per-type relationship lookup stays linear.
  const edgesByFrom = new Map<string, typeof edges[number][]>();
  for (const edge of edges) {
    const bucket = edgesByFrom.get(edge.from) ?? [];
    bucket.push(edge);
    edgesByFrom.set(edge.from, bucket);
  }

  for (const entity of entities) {
    if (!TYPE_KINDS.has(entity.kind)) continue;

    const dirParts = entity.relPath.split("/").slice(0, -1);
    const entryId = toSnakeCase(
      `${repoName}_${entity.language}_${entity.qualifiedName}`,
    );
    if (seenEntryIds.has(entryId)) continue;
    seenEntryIds.add(entryId);

    const ownedFields = idx.fieldsByOwnerQn.get(entity.qualifiedName) ?? [];
    const key_fields = ownedFields.map(
      (f) => ({
        name: f.name,
        type: typeof f.attrs?.type_text === "string"
          ? (f.attrs.type_text as string).trim()
          : (typeof f.attrs?.base_type === "string" ? f.attrs.base_type as string : ""),
        description: describeField(f),
      }),
    );

    // Relationships originate from either the type entity itself
    // (EXTENDS, SPECIALIZES) or from one of its fields (OWNS,
    // CONTAINS_MANY, POINTS_TO, …). Fold both sources into a single
    // list and deduplicate by (type, target).
    const candidateEdges: typeof edges[number][] = [
      ...(edgesByFrom.get(entity.id) ?? []),
    ];
    for (const f of ownedFields) {
      candidateEdges.push(...(edgesByFrom.get(f.id) ?? []));
    }
    const seenRel = new Set<string>();
    const relationships: Array<{ type: string; target: string; via: string }> = [];
    for (const edge of candidateEdges) {
      if (RELATIONSHIP_VIA[edge.relationship] === undefined) continue;
      const target = idx.byId.get(edge.to);
      const targetLabel = target
        ? toSnakeCase(`${repoName}_${target.language}_${target.qualifiedName}`)
        : (typeof edge.meta?.base_type === "string" ? edge.meta.base_type as string : edge.to);
      const key = `${edge.relationship}|${targetLabel}`;
      if (seenRel.has(key)) continue;
      seenRel.add(key);
      relationships.push({
        type: edge.relationship,
        target: targetLabel,
        // Prefer the extractor-supplied per-edge label (Rust `box`, C++
        // `unique_ptr`, Java `Optional`, …) so consumers can tell which
        // language construct produced the otherwise-shared semantic
        // relationship. Fall back to the default label per relationship.
        via: (typeof edge.meta?.via === "string" && (edge.meta.via as string).length > 0)
          ? (edge.meta.via as string)
          : (RELATIONSHIP_VIA[edge.relationship] ?? edge.relationship),
      });
    }

    out.push({
      id: entryId,
      name: entity.name,
      description:
        `${entity.kind} \`${entity.qualifiedName}\` declared in ${entity.relPath}` +
        (entity.line ? ` (line ${entity.line})` : "") +
        ". Discovered by the parser-backed native scanner.",
      source_repo: repoName,
      source_files: [entity.relPath],
      domain: inferDomain(dirParts),
      keywords: [entity.name.toLowerCase(), entity.language, entity.kind.toLowerCase()],
      status: "active",
      model_kind: `${entity.language}:${entity.kind.toLowerCase()}`,
      key_fields,
      relationships,
      links: [],
      // Provenance hints for downstream auditing; consumers may ignore.
      provenance: {
        scanner: "native",
        language: entity.language,
        qualified_name: entity.qualifiedName,
      },
      // `name` displayed in titles needs Title Case; keep raw name as
      // `name` for stability and surface a friendlier `display_name`.
      display_name: toTitleCase(entity.name),
    });
  }

  return out;
}

function describeField(f: ExtractedEntity): string {
  const pieces: string[] = [];
  if (typeof f.attrs?.pointer_depth === "number" && f.attrs.pointer_depth > 0) {
    pieces.push(`pointer depth ${f.attrs.pointer_depth}`);
  }
  if (f.attrs?.is_reference === true) pieces.push("reference");
  if (typeof f.attrs?.access === "string") pieces.push(`${f.attrs.access} access`);
  if (typeof f.attrs?.smart_pointer === "string") pieces.push(`${f.attrs.smart_pointer}_ptr`);
  if (typeof f.attrs?.container_template === "string") pieces.push(`${f.attrs.container_template}<…>`);
  return pieces.length > 0 ? pieces.join(", ") : "field";
}
