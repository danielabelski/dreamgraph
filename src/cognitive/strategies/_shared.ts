/**
 * DreamGraph — Shared types and helpers for dream strategies.
 *
 * Extracted from dreamer.ts to support 1-strategy-per-file structure.
 * Each strategy file imports `FactSnapshot`, `FactEntity`, `dreamId`,
 * and other helpers from here.
 *
 * `idCounter` lives at module scope here so all strategies share the
 * same monotonically-increasing dream-id namespace, exactly as before.
 */

import { loadJsonArray } from "../../utils/cache.js";
import { isMissingFileError } from "../../utils/json-store.js";
import type { Feature, Workflow, DataModelEntity, Datastore, DatastoreTable } from "../../types/index.js";
import { FORBIDDEN_PERSISTENCE_SENTINELS } from "../../semantic-invariants.js";

// ---------------------------------------------------------------------------
// Fact Graph Snapshot — in-memory read-only copy for dream analysis
// ---------------------------------------------------------------------------

export interface FactEntity {
  id: string;
  type: "feature" | "workflow" | "data_model" | "datastore";
  name: string;
  description: string;
  domain: string;
  keywords: string[];
  source_repo: string;
  source_files: string[];
  tags: string[];
  category: string;
  links: Array<{
    target: string;
    type: string;
    relationship: string;
    description: string;
    strength: string;
    meta?: {
      direction?: string;
      api_route?: string;
      table?: string;
      see_also?: Array<{ target: string; type: string; hint: string }>;
    };
  }>;
  /** Workflow steps (ordered names) — only for workflow entities */
  steps: string[];
  /** Data model key field names — only for data_model entities */
  key_fields: string[];
  /** Data model relationship targets — only for data_model entities */
  relationships: Array<{ type: string; target: string; via: string }>;
  /** Words extracted from description for semantic matching */
  descriptionTokens: Set<string>;
  /** Datastore tables — only for datastore entities (per Slice 2 scan_database). */
  tables?: DatastoreTable[];
}

export interface FactSnapshot {
  entities: Map<string, FactEntity>;
  /** Set of "from|to" strings for fast edge existence checks */
  edgeSet: Set<string>;
  /** All domain values */
  domains: Set<string>;
  /** Shared source files → entity IDs that reference them */
  sourceFileIndex: Map<string, string[]>;
  /** Per-entity degree (outgoing + incoming links across the fact graph) */
  degree: Map<string, number>;
}

/**
 * Restrict a fact snapshot to named entities and their bounded neighborhood.
 * Targeted scheduled dreams use this to stabilize a changed graph region
 * without spending a cycle rediscovering unrelated areas.
 */
export function focusFactSnapshot(
  snapshot: FactSnapshot,
  entityIds: readonly string[],
  hops = 2,
): FactSnapshot {
  const roots = entityIds.filter((id) => snapshot.entities.has(id));
  if (roots.length === 0) return snapshot;
  const adjacency = new Map<string, Set<string>>();
  const connect = (left: string, right: string): void => {
    if (!snapshot.entities.has(left) || !snapshot.entities.has(right)) return;
    const l = adjacency.get(left) ?? new Set<string>(); l.add(right); adjacency.set(left, l);
    const r = adjacency.get(right) ?? new Set<string>(); r.add(left); adjacency.set(right, r);
  };
  for (const entity of snapshot.entities.values()) {
    for (const link of entity.links) connect(entity.id, link.target);
  }
  const selected = new Set(roots);
  let frontier = roots;
  for (let hop = 0; hop < Math.max(1, Math.min(4, hops)); hop++) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const neighbor of adjacency.get(current) ?? []) {
        if (selected.has(neighbor)) continue;
        selected.add(neighbor);
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  const entities = new Map([...snapshot.entities].filter(([id]) => selected.has(id)));
  const edgeSet = new Set([...snapshot.edgeSet].filter((edge) => {
    const separator = edge.indexOf("|");
    return separator > 0 && selected.has(edge.slice(0, separator)) && selected.has(edge.slice(separator + 1));
  }));
  const domains = new Set([...entities.values()].map((entity) => entity.domain).filter(Boolean));
  const sourceFileIndex = new Map<string, string[]>();
  for (const [file, ids] of snapshot.sourceFileIndex) {
    const kept = ids.filter((id) => selected.has(id));
    if (kept.length > 0) sourceFileIndex.set(file, kept);
  }
  const degree = new Map<string, number>();
  for (const id of selected) {
    degree.set(id, [...(adjacency.get(id) ?? [])].filter((neighbor) => selected.has(neighbor)).length);
  }
  return { entities, edgeSet, domains, sourceFileIndex, degree };
}

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

export const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "shall", "should", "may", "might", "can", "could", "this", "that",
  "these", "those", "it", "its", "not", "no", "all", "each", "every",
  "as", "if", "when", "than", "also", "into", "such", "which", "their",
]);

/** Extract meaningful tokens from text for semantic matching. */
export function tokenize(text: string): Set<string> {
  if (!text) return new Set();
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );
}

// ---------------------------------------------------------------------------
// Dream ID generation — shared monotonic counter across all strategies
// ---------------------------------------------------------------------------

let idCounter = 0;

export function dreamId(prefix: string): string {
  idCounter++;
  return `dream_${prefix}_${Date.now()}_${idCounter}`;
}

// ---------------------------------------------------------------------------
// Reverse relation map (used by symmetry-completion)
// ---------------------------------------------------------------------------

export function inferReverseRelation(relation: string): string {
  const reverseMap: Record<string, string> = {
    implements: "implemented_by",
    implemented_by: "implements",
    reads: "read_by",
    read_by: "reads",
    writes: "written_by",
    written_by: "writes",
    depends_on: "depended_on_by",
    depended_on_by: "depends_on",
    triggers: "triggered_by",
    triggered_by: "triggers",
    produces: "produced_by",
    produced_by: "produces",
    consumes: "consumed_by",
    consumed_by: "consumes",
    syncs: "synced_by",
    synced_by: "syncs",
    extends: "extended_by",
    extended_by: "extends",
    stores: "stored_in",
    stored_in: "stores",
    validates: "validated_by",
    validated_by: "validates",
    exports: "exported_by",
    exported_by: "exports",
    manages: "managed_by",
    managed_by: "manages",
  };

  return reverseMap[relation] ?? `reverse_of_${relation}`;
}

// ---------------------------------------------------------------------------
// Fact snapshot builder — assembles the read-only graph copy
// ---------------------------------------------------------------------------

export async function buildFactSnapshot(): Promise<FactSnapshot> {
  const [features, workflows, dataModel, datastoresMaybe] = await Promise.all([
    loadJsonArray<Feature>("features.json"),
    loadJsonArray<Workflow>("workflows.json"),
    loadJsonArray<DataModelEntity>("data_model.json"),
    loadJsonArray<Datastore>("datastores.json").catch((err) =>
      isMissingFileError(err) ? ([] as Datastore[]) : Promise.reject(err),
    ),
  ]);

  // Strip template stubs (entries with `_schema` / `_note` markers).
  const datastores = (datastoresMaybe as unknown as Array<Record<string, unknown>>)
    .filter((d) => d._schema === undefined && d._note === undefined)
    .map((d) => d as unknown as Datastore);

  const entities = new Map<string, FactEntity>();
  const edgeSet = new Set<string>();
  const domains = new Set<string>();
  const sourceFileIndex = new Map<string, string[]>();

  const indexSourceFiles = (entityId: string, files: string[]) => {
    for (const f of files) {
      const list = sourceFileIndex.get(f) ?? [];
      list.push(entityId);
      sourceFileIndex.set(f, list);
    }
  };

  const mapLinks = (links: Feature["links"]) =>
    (links ?? []).map((l) => ({
      target: l.target,
      type: l.type,
      relationship: l.relationship,
      description: l.description ?? "",
      strength: l.strength,
      meta: l.meta
        ? {
            direction: l.meta.direction,
            api_route: l.meta.api_route,
            table: l.meta.table,
            see_also: l.meta.see_also?.map((sa) => ({
              target: sa.target,
              type: sa.type,
              hint: sa.hint,
            })),
          }
        : undefined,
    }));

  for (const f of features) {
    const desc = f.description ?? "";
    entities.set(f.id, {
      id: f.id,
      type: "feature",
      name: f.name,
      description: desc,
      domain: f.domain ?? "",
      keywords: f.keywords ?? [],
      source_repo: f.source_repo,
      source_files: f.source_files ?? [],
      tags: f.tags ?? [],
      category: f.category ?? "",
      links: mapLinks(f.links),
      steps: [],
      key_fields: [],
      relationships: [],
      descriptionTokens: tokenize(desc),
    });
    if (f.domain) domains.add(f.domain);
    indexSourceFiles(f.id, f.source_files ?? []);
    for (const link of f.links ?? []) {
      edgeSet.add(`${f.id}|${link.target}`);
    }
  }

  for (const w of workflows) {
    const desc = w.description ?? "";
    entities.set(w.id, {
      id: w.id,
      type: "workflow",
      name: w.name,
      description: desc,
      domain: w.domain ?? "",
      keywords: w.keywords ?? [],
      source_repo: w.source_repo,
      source_files: w.source_files ?? [],
      tags: [],
      category: "",
      links: mapLinks(w.links),
      steps: (w.steps ?? []).map((s) => (typeof s === "string" ? s : s.name)),
      key_fields: [],
      relationships: [],
      descriptionTokens: tokenize(desc),
    });
    if (w.domain) domains.add(w.domain);
    indexSourceFiles(w.id, w.source_files ?? []);
    for (const link of w.links ?? []) {
      edgeSet.add(`${w.id}|${link.target}`);
    }
  }

  for (const e of dataModel) {
    const desc = e.description ?? "";
    entities.set(e.id, {
      id: e.id,
      type: "data_model",
      name: e.name,
      description: desc,
      domain: e.domain ?? "",
      keywords: e.keywords ?? [],
      source_repo: e.source_repo,
      source_files: e.source_files ?? [],
      tags: [],
      category: "",
      links: mapLinks(e.links),
      steps: [],
      key_fields: (e.key_fields ?? []).map((kf) =>
        typeof kf === "string" ? kf : kf.name,
      ),
      relationships: (e.relationships ?? []).map((r) => ({
        type: r.type,
        target: r.target,
        via: r.via,
      })),
      descriptionTokens: tokenize(desc),
    });
    if (e.domain) domains.add(e.domain);
    indexSourceFiles(e.id, e.source_files ?? []);
    for (const link of e.links ?? []) {
      edgeSet.add(`${e.id}|${link.target}`);
    }
  }

  // -------------------------------------------------------------------
  // Datastores (per plans/DATASTORE_AS_HUB.md, Slice 1).
  // Each datastore becomes a FactEntity. Every data_model entity that
  // does not already have a `stored_in` link gets one to the resolved
  // datastore so the hub becomes structurally visible.
  // -------------------------------------------------------------------
  for (const d of datastores) {
    const desc = d.description ?? "";
    entities.set(d.id, {
      id: d.id,
      type: "datastore",
      name: d.name,
      description: desc,
      domain: d.kind ?? "",
      keywords: d.tags ?? [],
      source_repo: d.source_repo ?? "",
      source_files: d.source_files ?? [],
      tags: d.tags ?? [],
      category: d.kind ?? "",
      links: [],
      steps: [],
      key_fields: [],
      relationships: [],
      descriptionTokens: tokenize(desc),
      tables: d.tables ?? [],
    });
    indexSourceFiles(d.id, d.source_files ?? []);
  }

  if (datastores.length > 0) {
    // Resolve datastore membership only from explicit data_model storage evidence.
    // Do not fall back to a primary/first datastore: many projects have no datastore,
    // and data structure nodes must not be anchored to storage without proof.
    const datastoreById = new Map(datastores.map((d) => [d.id, d]));
    const resolveDatastore = (storage: string | undefined): Datastore | undefined => {
      const value = storage?.trim();
      if (!value) return undefined;
      if (FORBIDDEN_PERSISTENCE_SENTINELS.includes(value.toLowerCase())) return undefined;
      const exact = datastoreById.get(value);
      if (exact) return exact;
      const needle = value.toLowerCase();
      return datastores.find((d) => {
        const hay = `${d.id} ${d.name} ${d.kind}`.toLowerCase();
        return hay.includes(needle) || needle.includes(d.kind);
      });
    };

    for (const e of dataModel) {
      const ent = entities.get(e.id);
      if (!ent) continue;
      const alreadyLinked = (e.links ?? []).some(
        (l) => l.relationship === "stored_in" || datastoreById.has(l.target),
      );
      if (alreadyLinked) continue;
      const target = resolveDatastore(e.storage);
      if (!target) continue;
      ent.links.push({
        target: target.id,
        type: "datastore" as unknown as FactEntity["links"][number]["type"],
        relationship: "stored_in",
        description: "Evidence-bound edge: data_model storage field resolves to this datastore.",
        strength: "medium",
      });
      edgeSet.add(`${e.id}|${target.id}`);
    }
  }

  // Compute per-entity degree (outgoing + incoming) from the assembled edge set.
  const degree = new Map<string, number>();
  for (const id of entities.keys()) degree.set(id, 0);
  for (const key of edgeSet) {
    const [from, to] = key.split("|");
    if (entities.has(from)) degree.set(from, (degree.get(from) ?? 0) + 1);
    if (entities.has(to) && to !== from) degree.set(to, (degree.get(to) ?? 0) + 1);
  }

  return { entities, edgeSet, domains, sourceFileIndex, degree };
}
