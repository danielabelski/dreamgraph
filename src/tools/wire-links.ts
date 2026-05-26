/**
 * DreamGraph MCP Server — wire_links tool.
 *
 * Uses the LLM to discover and write missing `links` between fact-graph
 * entities. Targets entities whose `links` field is empty (orphans), builds
 * a candidate pool from lexical/source-file overlap, and asks the LLM to
 * pick the semantically meaningful connections.
 *
 * Why this exists:
 *   init_graph and structural extractors create entities with `links: []`
 *   and never populate them. Dream-promoted features arrive disconnected.
 *   Capabilities have no native cross-references. The result: many entities
 *   sit as islands with degree 0, dragging down graph quality and rendering
 *   the explorer's connectivity story incomplete.
 *
 * The LLM is the right tool for this: it can read names + descriptions +
 * source_files and infer semantic relationships that pure heuristics miss.
 *
 * Writes are funneled through executeEnrichSeedData (merge mode) so the
 * normal validation, dedup, index-rebuild, cache-invalidation pipeline
 * applies. No bypass paths.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadJsonArray } from "../utils/cache.js";
import { success, error, safeExecute } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { selectLlmRoute } from "../cognitive/llm.js";
import type { LlmMessage } from "../cognitive/llm.js";
import { executeEnrichSeedData } from "./enrich-seed-data.js";
import type {
  Feature,
  Workflow,
  DataModelEntity,
  CapabilityEntity,
  GraphLink,
  ToolResponse,
} from "../types/index.js";

type EntityType = "feature" | "workflow" | "data_model" | "capability";

interface AnyEntity {
  id: string;
  name?: string;
  description?: string;
  source_files?: string[];
  tags?: string[];
  keywords?: string[];
  domain?: string;
  category?: string;
  links?: GraphLink[];
}

interface CandidateRow {
  id: string;
  type: EntityType;
  name: string;
  description: string;
  score: number;
}

interface WireLinksResult {
  scope: EntityType[];
  scanned_orphans: number;
  attempted: number;
  links_written: number;
  entities_updated: number;
  llm_calls: number;
  tokens_used: number;
  per_target: Record<EntityType, { orphans_found: number; entities_updated: number; links_written: number }>;
  notes: string[];
}

const TARGET_FILES: Record<EntityType, string> = {
  feature: "features.json",
  workflow: "workflows.json",
  data_model: "data_model.json",
  capability: "capabilities.json",
};

const SEED_TARGET: Record<EntityType, "features" | "workflows" | "data_model" | "capabilities"> = {
  feature: "features",
  workflow: "workflows",
  data_model: "data_model",
  capability: "capabilities",
};

const LINK_RELATIONSHIPS = [
  "depends_on",
  "implements",
  "manages",
  "reads_from",
  "writes_to",
  "realizes",
  "composes",
  "contains",
  "uses",
  "produces",
  "consumes",
  "configures",
  "supports",
  "documents",
  "tests",
  "related_to",
] as const;

const LINK_RELATIONSHIP_SET = new Set<string>(LINK_RELATIONSHIPS);
const LINK_DIRECTIONS = new Set(["upstream", "downstream", "bidirectional"]);
const LINK_STRENGTHS = new Set(["weak", "moderate", "strong"]);
const MAX_LINKS_PER_ENTITY = 8;

const LINK_SELECTION_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["links"],
  properties: {
    links: {
      type: "array",
      maxItems: MAX_LINKS_PER_ENTITY,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["target", "relationship", "direction", "description", "evidence_excerpt", "confidence", "strength"],
        properties: {
          target: { type: "string" },
          relationship: { type: "string", enum: LINK_RELATIONSHIPS },
          direction: { type: "string", enum: Array.from(LINK_DIRECTIONS) },
          description: { type: "string", minLength: 1 },
          evidence_excerpt: { type: "string", minLength: 1 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          strength: { type: "string", enum: Array.from(LINK_STRENGTHS) },
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Candidate scoring (lexical + structural overlap)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "with",
  "from", "into", "by", "is", "are", "was", "were", "be", "been", "being",
  "this", "that", "these", "those", "it", "its", "as", "at", "but", "if",
  "data", "system", "tool", "service", "manager", "handler", "core", "main",
]);

function tokenize(text: string | undefined): Set<string> {
  if (!text) return new Set();
  return new Set(
    text
      .toLowerCase()
      .replace(/[_\-./]/g, " ")
      .split(/\s+/)
      .map((w) => w.replace(/[^a-z0-9]/g, ""))
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function sourceFileOverlap(a: string[] | undefined, b: string[] | undefined): number {
  if (!a?.length || !b?.length) return 0;
  const setA = new Set(a);
  let hits = 0;
  for (const f of b) if (setA.has(f)) hits++;
  return hits / Math.min(a.length, b.length);
}

function buildSignature(e: AnyEntity): { tokens: Set<string>; tags: Set<string> } {
  const tokens = new Set<string>();
  for (const t of tokenize(e.name)) tokens.add(t);
  for (const t of tokenize(e.description)) tokens.add(t);
  for (const k of e.keywords ?? []) for (const t of tokenize(k)) tokens.add(t);
  if (e.domain) for (const t of tokenize(e.domain)) tokens.add(t);
  if (e.category) for (const t of tokenize(e.category)) tokens.add(t);
  const tags = new Set((e.tags ?? []).map((t) => t.toLowerCase()));
  return { tokens, tags };
}

function scoreCandidates(
  source: AnyEntity,
  pool: Array<{ entity: AnyEntity; type: EntityType }>,
  topK: number,
): CandidateRow[] {
  const sourceSig = buildSignature(source);
  const rows: CandidateRow[] = [];
  for (const { entity, type } of pool) {
    if (entity.id === source.id) continue;
    const targetSig = buildSignature(entity);
    const tokenScore = jaccard(sourceSig.tokens, targetSig.tokens);
    const tagScore = jaccard(sourceSig.tags, targetSig.tags);
    const fileScore = sourceFileOverlap(source.source_files, entity.source_files);
    // Weighted blend; source-file overlap dominates when present.
    const score = fileScore * 0.6 + tokenScore * 0.3 + tagScore * 0.1;
    if (score <= 0) continue;
    rows.push({
      id: entity.id,
      type,
      name: entity.name ?? entity.id,
      description: (entity.description ?? "").slice(0, 200),
      score,
    });
  }
  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, topK);
}

function buildPrompt(
  source: { type: EntityType; entity: AnyEntity },
  candidates: CandidateRow[],
): LlmMessage[] {
  const sourceJson = {
    id: source.entity.id,
    type: source.type,
    name: source.entity.name,
    description: source.entity.description,
    source_files: source.entity.source_files ?? [],
    tags: source.entity.tags ?? [],
    domain: source.entity.domain,
    category: source.entity.category,
  };
  const candJson = candidates.map((c) => ({
    id: c.id,
    type: c.type,
    name: c.name,
    description: c.description,
    deterministic_score: Number(c.score.toFixed(3)),
  }));

  const system = [
    "You wire semantic links between knowledge-graph entities.",
    "Given a SOURCE entity and a deterministic CANDIDATE evidence list, decide which candidates the source",
    "is genuinely related to. Be conservative: only emit links justified by names, descriptions, source files,",
    "domain context, or the deterministic candidate score. Skip candidates with no clear relationship.",
    "Each chosen link must use an allowed relationship, a direction, a compact evidence_excerpt, and confidence.",
    "Output STRICT JSON: { \"links\": [...] }, no prose, no markdown. Empty links is valid.",
    `Allowed relationships: ${LINK_RELATIONSHIPS.join(", ")}.`,
    "Allowed directions: upstream, downstream, bidirectional.",
    "Maximum 8 links. If nothing fits, return { \"links\": [] }.",
  ].join(" ");

  const user = [
    "SOURCE:",
    JSON.stringify(sourceJson, null, 2),
    "",
    "CANDIDATE EVIDENCE:",
    JSON.stringify(candJson, null, 2),
    "",
    "Return strict JSON object with a links array only.",
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

export function parseLinkArray(
  text: string,
  candidates: CandidateRow[] | Set<string>,
): { links: GraphLink[]; errors: string[] } {
  const candidateMap = new Map<string, CandidateRow>();
  if (Array.isArray(candidates)) {
    for (const candidate of candidates) candidateMap.set(candidate.id, candidate);
  } else {
    for (const id of candidates) {
      candidateMap.set(id, { id, type: "feature", name: id, description: "", score: 0 });
    }
  }

  const errors: string[] = [];
  let payload: unknown = null;
  try {
    payload = JSON.parse(text);
  } catch {
    const objectMatch = text.match(/\{[\s\S]*\}/);
    const arrayMatch = text.match(/\[[\s\S]*\]/);
    const match = objectMatch ?? arrayMatch;
    if (!match) {
      return { links: [], errors: ["LLM did not return parseable JSON"] };
    }
    try {
      payload = JSON.parse(match[0]);
    } catch {
      return { links: [], errors: ["LLM did not return parseable JSON"] };
    }
  }

  let rawLinks: unknown;
  if (Array.isArray(payload)) {
    rawLinks = payload;
  } else if (payload && typeof payload === "object" && Array.isArray((payload as { links?: unknown[] }).links)) {
    rawLinks = (payload as { links: unknown[] }).links;
  } else {
    return { links: [], errors: ["LLM response missing links array"] };
  }

  if (!Array.isArray(rawLinks)) {
    return { links: [], errors: ["LLM links payload was not an array"] };
  }
  if (rawLinks.length > MAX_LINKS_PER_ENTITY) {
    return { links: [], errors: [`excessive edge count ${rawLinks.length} > ${MAX_LINKS_PER_ENTITY}`] };
  }

  const out: GraphLink[] = [];
  for (const [index, entry] of rawLinks.entries()) {
    if (!entry || typeof entry !== "object") {
      errors.push(`link ${index}: not an object`);
      continue;
    }
    const e = entry as Record<string, unknown>;
    const target = typeof e.target === "string" ? e.target.trim() : "";
    if (!target || !candidateMap.has(target)) {
      errors.push(`link ${index}: invalid target ${target || "(missing)"}`);
      continue;
    }

    const relationship = typeof e.relationship === "string" ? e.relationship.trim() : "";
    if (!LINK_RELATIONSHIP_SET.has(relationship)) {
      errors.push(`link ${index}: invalid relationship ${relationship || "(missing)"}`);
      continue;
    }

    const direction = typeof e.direction === "string" ? e.direction.trim() : "";
    if (!LINK_DIRECTIONS.has(direction)) {
      errors.push(`link ${index}: invalid direction ${direction || "(missing)"}`);
      continue;
    }

    const evidenceExcerpt = typeof e.evidence_excerpt === "string" ? e.evidence_excerpt.trim() : "";
    if (!evidenceExcerpt) {
      errors.push(`link ${index}: missing evidence excerpt`);
      continue;
    }

    const confidence = typeof e.confidence === "number" ? e.confidence : Number.NaN;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      errors.push(`link ${index}: invalid confidence`);
      continue;
    }

    const description = typeof e.description === "string" ? e.description.trim() : "";
    if (!description) {
      errors.push(`link ${index}: missing description`);
      continue;
    }

    const rawStrength = typeof e.strength === "string" ? e.strength.toLowerCase() : "";
    if (!LINK_STRENGTHS.has(rawStrength)) {
      errors.push(`link ${index}: invalid strength ${rawStrength || "(missing)"}`);
      continue;
    }

    const candidate = candidateMap.get(target);
    out.push({
      target,
      type: candidate?.type ?? "feature",
      relationship,
      description,
      strength: rawStrength,
      meta: {
        direction: direction as "upstream" | "downstream" | "bidirectional",
        evidence_excerpt: evidenceExcerpt,
        confidence,
      },
    });
  }

  if (errors.length > 0) {
    return { links: [], errors };
  }

  const seen = new Set<string>();
  return {
    links: out.filter((l) => {
      if (seen.has(l.target)) return false;
      seen.add(l.target);
      return true;
    }),
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

async function loadAll(): Promise<Record<EntityType, AnyEntity[]>> {
  const [features, workflows, dataModel, capabilities] = await Promise.all([
    loadJsonArray<Feature>("features.json"),
    loadJsonArray<Workflow>("workflows.json"),
    loadJsonArray<DataModelEntity>("data_model.json"),
    loadJsonArray<CapabilityEntity>("capabilities.json"),
  ]);
  return {
    feature: features as unknown as AnyEntity[],
    workflow: workflows as unknown as AnyEntity[],
    data_model: dataModel as unknown as AnyEntity[],
    capability: capabilities as unknown as AnyEntity[],
  };
}

function isOrphan(e: AnyEntity): boolean {
  return !Array.isArray(e.links) || e.links.length === 0;
}

interface WireOptions {
  scope: EntityType[];
  limit: number;
  candidateTopK: number;
  dryRun: boolean;
}

/**
 * Programmatic entry point for the wire_links logic. Used by self-healing
 * hooks (see graph-integrity.ts) so post-promotion / post-enrichment passes
 * can wire freshly created orphans without going through MCP.
 */
export async function executeWireLinksProgrammatic(
  opts: WireOptions,
): Promise<ToolResponse<WireLinksResult>> {
  return executeWireLinks(opts);
}

async function executeWireLinks(opts: WireOptions): Promise<ToolResponse<WireLinksResult>> {
  const route = await selectLlmRoute({
    task: "graph_enrichment",
    daemon_component: "dreamer",
    daemon_temperature: 0.2,
    max_tokens: 1500,
  });
  const all = await loadAll();

  // Build the global pool of all entities (used as candidate space).
  const pool: Array<{ entity: AnyEntity; type: EntityType }> = [];
  for (const t of ["feature", "workflow", "data_model", "capability"] as EntityType[]) {
    for (const e of all[t]) if (e?.id) pool.push({ entity: e, type: t });
  }

  const result: WireLinksResult = {
    scope: opts.scope,
    scanned_orphans: 0,
    attempted: 0,
    links_written: 0,
    entities_updated: 0,
    llm_calls: 0,
    tokens_used: 0,
    per_target: {
      feature: { orphans_found: 0, entities_updated: 0, links_written: 0 },
      workflow: { orphans_found: 0, entities_updated: 0, links_written: 0 },
      data_model: { orphans_found: 0, entities_updated: 0, links_written: 0 },
      capability: { orphans_found: 0, entities_updated: 0, links_written: 0 },
    },
    notes: [],
  };

  if (route.layer === "deterministic_fallback") {
    result.notes.push(
      `ADR-203 route=deterministic_fallback reason=${route.provenance.fallback_reason ?? "unknown"}; wire_links uses safe no-op fallback.`,
    );
  } else {
    result.notes.push(`ADR-203 route=${route.layer} provider=${route.provenance.provider ?? "unknown"} model=${route.model ?? "unknown"}.`);
  }

  for (const targetType of opts.scope) {
    const orphans = all[targetType].filter((e) => e?.id && isOrphan(e));
    result.per_target[targetType].orphans_found = orphans.length;
    result.scanned_orphans += orphans.length;

    if (orphans.length === 0) continue;

    // Apply per-type limit by sharing the global limit budget proportionally.
    const remaining = Math.max(0, opts.limit - result.attempted);
    if (remaining === 0) {
      result.notes.push(`Skipped ${orphans.length} ${targetType} orphans — global limit reached.`);
      continue;
    }
    const slice = orphans.slice(0, remaining);

    if (route.layer === "deterministic_fallback") {
      result.attempted += slice.length;
      result.notes.push(`Skipped ${slice.length} ${targetType} orphans — deterministic fallback does not invent graph links.`);
      continue;
    }

    const provider = route.provider;
    if (!provider) {
      result.attempted += slice.length;
      result.notes.push(`Skipped ${slice.length} ${targetType} orphans — selected route had no provider.`);
      continue;
    }

    // Group writes per type to issue one enrich call.
    const updatedEntries: Array<Record<string, unknown>> = [];

    for (const orphan of slice) {
      result.attempted++;
      const candidates = scoreCandidates(orphan, pool, opts.candidateTopK);
      if (candidates.length === 0) continue;

      const messages = buildPrompt({ type: targetType, entity: orphan }, candidates);

      let links: GraphLink[] = [];
      try {
        const resp = await provider.complete(messages, {
          ...route.options,
          maxTokens: Math.min(route.options.maxTokens ?? 1500, 1500),
          jsonSchema: {
            name: "wire_link_selection",
            schema: LINK_SELECTION_JSON_SCHEMA,
          },
        });
        result.llm_calls++;
        result.tokens_used += resp.tokensUsed ?? 0;
        const parsed = parseLinkArray(resp.text, candidates);
        if (parsed.errors.length > 0) {
          result.notes.push(`Rejected invalid link selection for ${orphan.id}: ${parsed.errors.join("; ")}`);
          continue;
        }
        const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
        links = parsed.links.map((link) => ({
          ...link,
          meta: {
            ...(link.meta ?? {}),
            deterministic_score: Number((candidateById.get(link.target)?.score ?? 0).toFixed(3)),
          },
        }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.notes.push(`LLM error for ${orphan.id}: ${msg}`);
        continue;
      }

      if (links.length === 0) continue;

      result.per_target[targetType].entities_updated++;
      result.per_target[targetType].links_written += links.length;
      result.entities_updated++;
      result.links_written += links.length;

      logger.info(`wire_links: ${orphan.id} -> ${links.length} link(s) [${links.map((l) => l.target).join(", ")}]`);

      // Build a minimal merge record. Spread the existing entity to preserve all fields,
      // overwrite `links` with the new list. enrich_seed_data merges by id.
      updatedEntries.push({
        ...(orphan as unknown as Record<string, unknown>),
        links,
      });
    }

    if (updatedEntries.length === 0) continue;
    if (opts.dryRun) {
      result.notes.push(`[dry-run] would write ${updatedEntries.length} ${targetType} entries.`);
      continue;
    }

    const enrichRes = await executeEnrichSeedData({
      target: SEED_TARGET[targetType],
      entries: updatedEntries,
      mode: "merge",
      strict: false,
    });
    if (!enrichRes.success) {
      result.notes.push(`enrich_seed_data failed for ${targetType}: ${enrichRes.error?.message ?? "unknown"}`);
    }
  }

  return success(result);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerWireLinksTool(server: McpServer): void {
  server.tool(
    "wire_links",
    "Use the LLM to discover and write missing `links` between fact-graph entities. " +
    "Targets entities whose `links` field is empty (orphans). For each orphan, builds a " +
    "candidate pool ranked by source-file overlap, name/description tokens, and tags, then " +
    "asks the LLM to pick the semantically meaningful connections. Writes are funneled " +
    "through enrich_seed_data (merge mode) so validation, dedup, and index rebuild apply. " +
    "Use this to repair the connectivity of dream-promoted features, init_graph entities " +
    "that arrived with empty links, and isolated capabilities.",
    {
      scope: z
        .array(z.enum(["feature", "workflow", "data_model", "capability"]))
        .default(["feature", "workflow", "data_model", "capability"])
        .describe("Which entity types to wire. Default: all four fact-graph types."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(50)
        .describe("Maximum number of orphan entities to process across all scopes (one LLM call each)."),
      candidate_top_k: z
        .number()
        .int()
        .min(5)
        .max(80)
        .default(30)
        .describe("How many top-scored candidates to send to the LLM per orphan."),
      dry_run: z
        .boolean()
        .default(false)
        .describe("When true, run LLM proposals but don't persist. Useful for previewing."),
    },
    async ({ scope, limit, candidate_top_k, dry_run }) => {
      logger.info(`wire_links: scope=[${scope.join(",")}] limit=${limit} top_k=${candidate_top_k} dry_run=${dry_run}`);
      const res = await safeExecute<WireLinksResult>(() =>
        executeWireLinks({
          scope: scope as EntityType[],
          limit,
          candidateTopK: candidate_top_k,
          dryRun: dry_run,
        }),
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(res, null, 2) }],
      };
    },
  );
}
