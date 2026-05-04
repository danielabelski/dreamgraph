/**
 * DreamGraph — graph-integrity helpers.
 *
 * Self-healing passes for the fact graph that run automatically after
 * promotion (in dream_cycle) and after enrichment (in enrich_seed_data).
 *
 * Two passes are exposed:
 *
 *   - applyBidirectionalBacklinks() — for every link A → B between fact-graph
 *     entities, ensures B has an inbound back-reference to A. Eliminates
 *     sink-only nodes and asymmetric edges so the explorer's connectivity
 *     story stays consistent.
 *
 *   - autoWireOrphans() — best-effort LLM-driven wiring of any newly created
 *     orphans (degree-0 entities). Wraps wire-links's executeWireLinks. Skips
 *     gracefully if no LLM provider is configured.
 *
 * Both passes funnel writes through executeEnrichSeedData (merge mode) and
 * pass `_skipIntegrityHooks: true` so they don't recurse into themselves.
 */

import { loadJsonArray } from "../utils/cache.js";
import { logger } from "../utils/logger.js";
import { executeEnrichSeedData } from "./enrich-seed-data.js";
import type {
  Feature,
  Workflow,
  DataModelEntity,
  CapabilityEntity,
  GraphLink,
} from "../types/index.js";

type EntityType = "feature" | "workflow" | "data_model" | "capability";

interface AnyEntity {
  id: string;
  name?: string;
  links?: GraphLink[];
}

const TARGET_FILES: Record<EntityType, { file: string; target: string }> = {
  feature: { file: "features.json", target: "features" },
  workflow: { file: "workflows.json", target: "workflows" },
  data_model: { file: "data_model.json", target: "data_model" },
  capability: { file: "capabilities.json", target: "capabilities" },
};

const RELATIONSHIP_INVERSE: Record<string, string> = {
  depends_on: "supports",
  supports: "depends_on",
  implements: "implemented_by",
  implemented_by: "implements",
  contains: "part_of",
  part_of: "contains",
  produces: "produced_by",
  produced_by: "produces",
  consumes: "consumed_by",
  consumed_by: "consumes",
  triggers: "triggered_by",
  triggered_by: "triggers",
};

function invertRelationship(rel?: string): string {
  if (!rel) return "related_to";
  return RELATIONSHIP_INVERSE[rel] ?? "related_to";
}

export interface BacklinkResult {
  considered_links: number;
  external_targets_skipped: number;
  entities_needing_backlinks: number;
  per_target: Record<EntityType, { entities_updated: number; links_added: number }>;
  errors: string[];
}

/**
 * Bidirectional backlink pass. For every fact-graph link A → B where B is also
 * a fact-graph entity, ensure B has a reverse link to A. Idempotent.
 */
export async function applyBidirectionalBacklinks(): Promise<BacklinkResult> {
  const collections: Record<EntityType, AnyEntity[]> = {
    feature: await loadJsonArray<Feature>("features.json"),
    workflow: await loadJsonArray<Workflow>("workflows.json"),
    data_model: await loadJsonArray<DataModelEntity>("data_model.json"),
    capability: await loadJsonArray<CapabilityEntity>("capabilities.json"),
  };

  const byId = new Map<string, { type: EntityType; entity: AnyEntity }>();
  for (const t of Object.keys(collections) as EntityType[]) {
    for (const e of collections[t]) if (e?.id) byId.set(e.id, { type: t, entity: e });
  }

  // Existing edge set "from|to"
  const edges = new Set<string>();
  for (const t of Object.keys(collections) as EntityType[]) {
    for (const e of collections[t]) {
      for (const l of e?.links ?? []) {
        if (l?.target) edges.add(`${e.id}|${l.target}`);
      }
    }
  }

  const additions = new Map<string, Array<{ sourceId: string; relationship: string }>>();
  let considered = 0;
  let skippedExternal = 0;

  for (const t of Object.keys(collections) as EntityType[]) {
    for (const e of collections[t]) {
      if (!e?.id) continue;
      for (const l of e?.links ?? []) {
        if (!l?.target) continue;
        considered++;
        if (!byId.has(l.target)) {
          skippedExternal++;
          continue;
        }
        const reciprocal = `${l.target}|${e.id}`;
        if (edges.has(reciprocal)) continue;
        const list = additions.get(l.target) ?? [];
        list.push({ sourceId: e.id, relationship: invertRelationship(l.relationship) });
        additions.set(l.target, list);
        edges.add(reciprocal);
      }
    }
  }

  const result: BacklinkResult = {
    considered_links: considered,
    external_targets_skipped: skippedExternal,
    entities_needing_backlinks: additions.size,
    per_target: {
      feature: { entities_updated: 0, links_added: 0 },
      workflow: { entities_updated: 0, links_added: 0 },
      data_model: { entities_updated: 0, links_added: 0 },
      capability: { entities_updated: 0, links_added: 0 },
    },
    errors: [],
  };

  if (additions.size === 0) return result;

  const batches: Record<EntityType, Array<Record<string, unknown>>> = {
    feature: [],
    workflow: [],
    data_model: [],
    capability: [],
  };

  for (const [targetId, news] of additions) {
    const meta = byId.get(targetId);
    if (!meta) continue;
    const updated = JSON.parse(JSON.stringify(meta.entity)) as AnyEntity & Record<string, unknown>;
    if (!Array.isArray(updated.links)) updated.links = [];
    for (const n of news) {
      updated.links.push({
        target: n.sourceId,
        type: meta.type,
        relationship: n.relationship,
        description: "auto-backlink",
        strength: "moderate",
      } as GraphLink);
    }
    batches[meta.type].push(updated);
    result.per_target[meta.type].entities_updated++;
    result.per_target[meta.type].links_added += news.length;
  }

  for (const t of Object.keys(batches) as EntityType[]) {
    if (batches[t].length === 0) continue;
    const res = await executeEnrichSeedData({
      target: TARGET_FILES[t].target,
      mode: "merge",
      entries: batches[t],
      _skipIntegrityHooks: true,
    });
    if (!res.success) {
      const msg = res.error?.message ?? "unknown";
      result.errors.push(`${t}: ${msg}`);
      logger.warn(`applyBidirectionalBacklinks: ${t} enrich failed — ${msg}`);
    }
  }

  logger.info(
    `applyBidirectionalBacklinks: considered=${considered} additions=${additions.size} ` +
    `errors=${result.errors.length}`,
  );

  return result;
}

/**
 * Best-effort orphan wiring. Defers to wire-links's executeWireLinks so any
 * newly created or promoted entities with empty `links` get an LLM-inferred
 * connection set. No-op when no LLM is configured.
 *
 * Returns a brief summary; never throws.
 */
export async function autoWireOrphans(opts?: {
  scope?: EntityType[];
  limit?: number;
}): Promise<{ ran: boolean; entities_updated: number; links_written: number; reason?: string }> {
  // Lazy import to avoid circular load (wire-links imports enrich).
  const { isLlmAvailable } = await import("../cognitive/llm.js");
  if (!isLlmAvailable()) {
    return { ran: false, entities_updated: 0, links_written: 0, reason: "LLM unavailable" };
  }

  const { executeWireLinksProgrammatic } = await import("./wire-links.js");

  try {
    const res = await executeWireLinksProgrammatic({
      scope: opts?.scope ?? ["feature", "workflow", "data_model", "capability"],
      limit: opts?.limit ?? 25,
      candidateTopK: 30,
      dryRun: false,
    });
    if (!res.success) {
      return {
        ran: false,
        entities_updated: 0,
        links_written: 0,
        reason: res.error?.message ?? "wire_links failed",
      };
    }
    return {
      ran: true,
      entities_updated: res.data?.entities_updated ?? 0,
      links_written: res.data?.links_written ?? 0,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`autoWireOrphans: ${msg}`);
    return { ran: false, entities_updated: 0, links_written: 0, reason: msg };
  }
}
