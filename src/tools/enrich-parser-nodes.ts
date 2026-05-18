/**
 * DreamGraph MCP Server — `enrich_parser_nodes` tool.
 *
 * Autonomous, batch semantic enrichment for parser-discovered nodes.
 *
 * Background
 * ----------
 * The native scanner (`scan_project` → `native-data-model.ts`) discovers
 * structural facts: classes, structs, enums, fields, relationships.
 * Per the project's separation of concerns, the scanner does NOT invent
 * semantic data — descriptions are formulaic ("struct `Foo` declared in
 * src/foo.c (line 42)…"), and `intent`/`purpose` are not set. Result:
 * after a large scan, the graph can contain hundreds of orphan generic
 * nodes that defeat downstream reasoning.
 *
 * `enrich_seed_data` accepts batches but is reactive — it requires a
 * caller (typically an Architect agent) to orchestrate the iteration,
 * which hits autonomy/pass ceilings before the work finishes.
 *
 * This tool fixes that gap: ONE invocation enriches ALL eligible
 * parser-origin nodes via the configured LLM provider, in internal
 * batches, with per-batch atomic writes for crash safety.
 *
 * Behaviour
 * ---------
 *   1. Load `data/data_model.json` and/or `data/features.json`.
 *   2. Filter to entities where
 *        `provenance?.scanner === "native"`  AND
 *        `enrichment?.enriched !== true` (unless `force` is true).
 *   3. Bucket by `source_repo` + `domain` for context coherence.
 *   4. For each batch (default 10 nodes):
 *        - Build a graph-grounded prompt (no fabrication: only describe
 *          what the supplied node data supports).
 *        - Call `getLlmProvider().complete(..., { jsonSchema })`.
 *        - Merge results: preserve original `description` to
 *          `description_raw`, write `description`, `intent`, `purpose`,
 *          extra `tags`, `enrichment` metadata, and append any
 *          proposed feature-anchor `GraphLink`s (with `strength: "weak"`)
 *          to the entity's `links`.
 *        - Atomically persist the file after each batch.
 *   5. Return a structured summary.
 *
 * Out of scope (deliberate):
 *   - Auto-invocation from `scan_project` (kept explicit so the cost
 *     of an LLM-driven pass is always a conscious choice).
 *   - Writes to `validated_edges.json` (those must flow through the
 *     normalizer — anchors land as weak links on the entity).
 *   - UI panel.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getLlmProvider, getDreamerLlmConfig, isLlmAvailable } from "../cognitive/llm.js";
import { loadJsonArray, invalidateCache } from "../utils/cache.js";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { dataPath } from "../utils/paths.js";
import { success, error, safeExecute } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import type {
  ToolResponse,
  GraphLink,
  EnrichmentMetadata,
  Feature,
  DataModelEntity,
} from "../types/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const ENRICHER_ID = "enrich_parser_nodes/1.0";

type TargetFile = "data_model" | "features";

interface ParserNodeRecord {
  id: string;
  name?: string;
  description?: string;
  source_repo?: string;
  source_files?: string[];
  domain?: string;
  keywords?: string[];
  tags?: string[];
  status?: string;
  model_kind?: string;
  key_fields?: unknown[];
  relationships?: unknown[];
  links?: GraphLink[];
  provenance?: { scanner?: string; language?: string; qualified_name?: string };
  enrichment?: EnrichmentMetadata;
  intent?: string;
  purpose?: string;
  description_raw?: string;
  // Free-form pass-through preserved on write.
  [key: string]: unknown;
}

interface PerNodeEnrichment {
  id: string;
  description: string;
  intent: string;
  purpose: string;
  tags: string[];
  feature_anchors: Array<{
    target_id: string;
    relationship: string;
    rationale: string;
  }>;
  confidence: number;
}

interface EnrichResult {
  target: "data_model" | "features" | "both";
  dry_run: boolean;
  files_processed: TargetFile[];
  total_eligible: number;
  total_enriched: number;
  total_skipped: number;
  feature_anchors_written: number;
  batches_run: number;
  llm_calls: number;
  tokens_used: number;
  duration_ms: number;
  errors: string[];
  notes: string[];
}

// ---------------------------------------------------------------------------
// LLM schema (strict — OpenAI Structured Outputs / Ollama JSON mode)
// ---------------------------------------------------------------------------

const ENRICHMENT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "description",
          "intent",
          "purpose",
          "tags",
          "feature_anchors",
          "confidence",
        ],
        properties: {
          id: { type: "string" },
          description: { type: "string" },
          intent: { type: "string" },
          purpose: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          feature_anchors: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["target_id", "relationship", "rationale"],
              properties: {
                target_id: { type: "string" },
                relationship: { type: "string" },
                rationale: { type: "string" },
              },
            },
          },
          confidence: { type: "number" },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are a code-graph semantic enricher.

You receive a small batch of parser-discovered code entities (classes, structs, enums, etc.) that arrived in the graph with only formulaic, structural descriptions. For each entity, infer rich semantic data from the supplied evidence ONLY:
  - its name and qualified name
  - its declared fields, relationships, source files, and language
  - the list of nearby Feature anchors provided as context

Rules:
  1. Do NOT fabricate. If evidence is thin, say so in 'intent' and assign a low 'confidence' (e.g. 0.3). Do not invent purposes, behaviours, or relationships the data does not support.
  2. 'description': one-sentence rewrite that conveys what the entity IS in human terms, replacing the parser's mechanical text.
  3. 'intent': one short sentence — why this entity exists, what design need it serves.
  4. 'purpose': 1-3 word role tag (e.g. "configuration", "service-locator", "value-object", "request-payload", "domain-entity").
  5. 'tags': 1-5 short lowercase tokens for indexing. Do NOT repeat tokens already in the entity's keywords/tags unless they are essential.
  6. 'feature_anchors': zero or more anchors to Feature entries supplied in the context. Each anchor uses a target_id that MUST exactly match one of the supplied feature ids. Emit an empty array when no anchor is justified — quality beats quantity.
  7. 'confidence': self-reported 0..1 score for the whole record.
  8. 'id': must echo the input id verbatim.

Return strict JSON: { "results": [ ... ] } with one entry per input node, in the same order.`;

// ---------------------------------------------------------------------------
// Filtering & bucketing
// ---------------------------------------------------------------------------

export function isParserOrigin(e: ParserNodeRecord): boolean {
  return e?.provenance?.scanner === "native";
}

export function isAlreadyEnriched(e: ParserNodeRecord): boolean {
  return e?.enrichment?.enriched === true;
}

export function bucketKey(e: ParserNodeRecord): string {
  const repo = (e.source_repo ?? "_unknown").trim() || "_unknown";
  const domain = (e.domain ?? "_unknown").trim() || "_unknown";
  return `${repo}::${domain}`;
}

export function chunk<T>(arr: T[], n: number): T[][] {
  if (n <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

interface FeatureAnchorContext {
  id: string;
  name: string;
  description: string;
}

function pickFeatureContext(
  features: ParserNodeRecord[],
  repo: string,
  domain: string,
  max: number,
): FeatureAnchorContext[] {
  const inDomain = features.filter(
    (f) => f.source_repo === repo && f.domain === domain && typeof f.name === "string",
  );
  const fallback = features.filter(
    (f) => f.source_repo === repo && typeof f.name === "string",
  );
  const picked = (inDomain.length >= max ? inDomain : [...inDomain, ...fallback]).slice(0, max);
  return picked.map((f) => ({
    id: f.id,
    name: String(f.name),
    description: String(f.description ?? "").slice(0, 240),
  }));
}

function projectNodeForPrompt(n: ParserNodeRecord): Record<string, unknown> {
  // Send only the fields the LLM needs — keeps prompts compact.
  return {
    id: n.id,
    name: n.name,
    description: n.description,
    source_repo: n.source_repo,
    source_files: n.source_files,
    domain: n.domain,
    model_kind: n.model_kind,
    qualified_name: n.provenance?.qualified_name,
    language: n.provenance?.language,
    keywords: n.keywords,
    key_fields: Array.isArray(n.key_fields) ? n.key_fields.slice(0, 20) : [],
    relationships: Array.isArray(n.relationships) ? n.relationships.slice(0, 20) : [],
  };
}

// ---------------------------------------------------------------------------
// LLM response parsing
// ---------------------------------------------------------------------------

export function parseLlmEnrichment(text: string): PerNodeEnrichment[] {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    // Best-effort fence strip — providers without strict schema enforcement
    // sometimes wrap output in ```json ... ```.
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (!fence) throw new Error("LLM did not return parseable JSON");
    payload = JSON.parse(fence[1]);
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("LLM response was not an object");
  }
  const results = (payload as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    throw new Error("LLM response missing 'results' array");
  }
  const out: PerNodeEnrichment[] = [];
  for (const r of results) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    if (typeof rec.id !== "string") continue;
    out.push({
      id: rec.id,
      description: typeof rec.description === "string" ? rec.description : "",
      intent: typeof rec.intent === "string" ? rec.intent : "",
      purpose: typeof rec.purpose === "string" ? rec.purpose : "",
      tags: Array.isArray(rec.tags) ? rec.tags.filter((t): t is string => typeof t === "string") : [],
      feature_anchors: Array.isArray(rec.feature_anchors)
        ? rec.feature_anchors
            .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
            .map((a) => ({
              target_id: typeof a.target_id === "string" ? a.target_id : "",
              relationship: typeof a.relationship === "string" ? a.relationship : "related_to",
              rationale: typeof a.rationale === "string" ? a.rationale : "",
            }))
            .filter((a) => a.target_id.length > 0)
        : [],
      confidence:
        typeof rec.confidence === "number" && rec.confidence >= 0 && rec.confidence <= 1
          ? rec.confidence
          : 0.5,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entity merge
// ---------------------------------------------------------------------------

export function mergeEnrichment(
  node: ParserNodeRecord,
  e: PerNodeEnrichment,
  validAnchorIds: ReadonlySet<string>,
  model: string | undefined,
  nowIso: string,
): { node: ParserNodeRecord; anchorsAdded: number } {
  // Preserve original parser description the first time we touch the node.
  const description_raw =
    typeof node.description_raw === "string" && node.description_raw.length > 0
      ? node.description_raw
      : typeof node.description === "string"
        ? node.description
        : "";

  const newTags = Array.isArray(node.tags) ? [...node.tags] : [];
  for (const t of e.tags) {
    const norm = t.trim().toLowerCase();
    if (norm && !newTags.includes(norm)) newTags.push(norm);
  }

  // Build feature anchor GraphLinks, filtered to known target ids.
  const existingLinks: GraphLink[] = Array.isArray(node.links) ? [...node.links] : [];
  const existingTargets = new Set(existingLinks.map((l) => l.target));
  let anchorsAdded = 0;
  for (const a of e.feature_anchors) {
    if (!validAnchorIds.has(a.target_id)) continue;
    if (existingTargets.has(a.target_id)) continue;
    existingLinks.push({
      target: a.target_id,
      type: "feature",
      relationship: a.relationship || "related_to",
      description: a.rationale || `Feature anchor proposed by ${ENRICHER_ID}`,
      strength: "weak",
    });
    existingTargets.add(a.target_id);
    anchorsAdded++;
  }

  const enrichment: EnrichmentMetadata = {
    enriched: true,
    enriched_at: nowIso,
    enricher: ENRICHER_ID,
    ...(model ? { model } : {}),
    confidence: e.confidence,
  };

  const next: ParserNodeRecord = {
    ...node,
    description: e.description.trim().length > 0 ? e.description.trim() : (node.description ?? ""),
    description_raw,
    intent: e.intent.trim(),
    purpose: e.purpose.trim(),
    tags: newTags,
    links: existingLinks,
    enrichment,
  };

  return { node: next, anchorsAdded };
}

// ---------------------------------------------------------------------------
// Core execution
// ---------------------------------------------------------------------------

interface EnrichOptions {
  target: "data_model" | "features" | "both";
  maxNodes: number;
  batchSize: number;
  dryRun: boolean;
  force: boolean;
  featureContextSize: number;
}

export { executeEnrichParserNodes };

async function executeEnrichParserNodes(
  opts: EnrichOptions,
): Promise<ToolResponse<EnrichResult>> {
  const started = Date.now();

  const available = await isLlmAvailable();
  if (!available) {
    return error(
      "LLM_UNAVAILABLE",
      "enrich_parser_nodes requires a configured LLM provider. Set DREAMGRAPH_LLM_PROVIDER and related env vars before running.",
    );
  }

  const llm = getLlmProvider();
  const cfg = getDreamerLlmConfig();

  // Always load both files: features supply anchor context even when only
  // data_model is being enriched.
  const allFeatures = (await loadJsonArray<ParserNodeRecord>("features.json")) ?? [];
  const allDataModel = (await loadJsonArray<ParserNodeRecord>("data_model.json")) ?? [];

  const targets: Array<{ key: TargetFile; filename: string; entries: ParserNodeRecord[] }> = [];
  if (opts.target === "data_model" || opts.target === "both") {
    targets.push({ key: "data_model", filename: "data_model.json", entries: allDataModel });
  }
  if (opts.target === "features" || opts.target === "both") {
    targets.push({ key: "features", filename: "features.json", entries: allFeatures });
  }

  const result: EnrichResult = {
    target: opts.target,
    dry_run: opts.dryRun,
    files_processed: [],
    total_eligible: 0,
    total_enriched: 0,
    total_skipped: 0,
    feature_anchors_written: 0,
    batches_run: 0,
    llm_calls: 0,
    tokens_used: 0,
    duration_ms: 0,
    errors: [],
    notes: [],
  };

  // Pre-build the set of valid feature ids — used to filter anchors so we
  // never write a link to a target that doesn't exist.
  const validFeatureIds = new Set<string>(
    allFeatures.filter((f) => typeof f.id === "string").map((f) => f.id),
  );

  let nodesProcessed = 0;

  for (const t of targets) {
    result.files_processed.push(t.key);

    const eligible = t.entries.filter(
      (e) => isParserOrigin(e) && (opts.force || !isAlreadyEnriched(e)),
    );
    result.total_eligible += eligible.length;

    if (eligible.length === 0) {
      result.notes.push(`${t.filename}: no eligible parser-origin nodes (already enriched or none scanned).`);
      continue;
    }

    // Respect the global max_nodes budget across both files.
    const remaining = Math.max(0, opts.maxNodes - nodesProcessed);
    if (remaining === 0) {
      result.notes.push(`${t.filename}: skipped — max_nodes budget exhausted.`);
      continue;
    }
    const slice = eligible.slice(0, remaining);

    // Bucket by repo+domain for context coherence.
    const buckets = new Map<string, ParserNodeRecord[]>();
    for (const node of slice) {
      const key = bucketKey(node);
      const arr = buckets.get(key) ?? [];
      arr.push(node);
      buckets.set(key, arr);
    }

    // Build a quick id → index map for in-place updates inside t.entries.
    const indexById = new Map<string, number>();
    t.entries.forEach((e, i) => {
      if (typeof e.id === "string") indexById.set(e.id, i);
    });

    for (const [bkey, bucketNodes] of buckets) {
      const [repo, domain] = bkey.split("::");
      const featureContext = pickFeatureContext(
        allFeatures,
        repo,
        domain,
        opts.featureContextSize,
      );

      for (const batch of chunk(bucketNodes, opts.batchSize)) {
        result.batches_run++;

        const userPrompt = [
          `Repo: ${repo}`,
          `Domain: ${domain}`,
          "",
          "Feature anchors available in this domain (use only these ids in feature_anchors):",
          featureContext.length === 0
            ? "  (none — emit empty feature_anchors arrays)"
            : featureContext
                .map((f) => `  - ${f.id}: ${f.name} — ${f.description}`)
                .join("\n"),
          "",
          "Parser-discovered nodes to enrich (one per element):",
          JSON.stringify(batch.map(projectNodeForPrompt), null, 2),
        ].join("\n");

        let parsed: PerNodeEnrichment[] = [];
        let modelUsed: string | undefined;

        try {
          const resp = await llm.complete(
            [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: userPrompt },
            ],
            {
              model: cfg.model,
              temperature: 0.2,
              maxTokens: Math.min(cfg.maxTokens, 4096),
              jsonSchema: {
                name: "parser_node_enrichment",
                schema: ENRICHMENT_JSON_SCHEMA,
              },
            },
          );
          result.llm_calls++;
          result.tokens_used += resp.tokensUsed ?? 0;
          modelUsed = resp.model;
          parsed = parseLlmEnrichment(resp.text);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`Batch (${bkey}, ${batch.length} nodes): ${msg}`);
          result.total_skipped += batch.length;
          nodesProcessed += batch.length;
          continue;
        }

        // Match LLM results back to input nodes by id.
        const resultsById = new Map<string, PerNodeEnrichment>();
        for (const r of parsed) resultsById.set(r.id, r);

        const validAnchorIds = new Set<string>(featureContext.map((f) => f.id));
        // Allow anchors to any feature in the same repo even if not in the
        // context list — keeps the LLM from being penalised for picking a
        // legitimate cross-domain feature it has seen during scanning.
        for (const fid of validFeatureIds) validAnchorIds.add(fid);

        const nowIso = new Date().toISOString();
        let batchEnriched = 0;
        let batchAnchors = 0;

        for (const node of batch) {
          const enrichment = resultsById.get(node.id);
          nodesProcessed++;
          if (!enrichment) {
            result.total_skipped++;
            result.errors.push(`Node ${node.id}: missing in LLM response`);
            continue;
          }
          const { node: merged, anchorsAdded } = mergeEnrichment(
            node,
            enrichment,
            validAnchorIds,
            modelUsed,
            nowIso,
          );
          const idx = indexById.get(node.id);
          if (idx !== undefined) t.entries[idx] = merged;
          batchEnriched++;
          batchAnchors += anchorsAdded;
        }

        result.total_enriched += batchEnriched;
        result.feature_anchors_written += batchAnchors;

        // Per-batch persistence: crash-safe — work done so far survives.
        if (!opts.dryRun && batchEnriched > 0) {
          try {
            await atomicWriteFile(dataPath(t.filename), JSON.stringify(t.entries, null, 2));
            invalidateCache(t.filename);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            result.errors.push(`Persist ${t.filename}: ${msg}`);
          }
        }

        if (nodesProcessed >= opts.maxNodes) break;
      }
      if (nodesProcessed >= opts.maxNodes) break;
    }
  }

  result.duration_ms = Date.now() - started;

  logger.info(
    `enrich_parser_nodes: enriched=${result.total_enriched} eligible=${result.total_eligible} ` +
      `batches=${result.batches_run} anchors=${result.feature_anchors_written} ` +
      `errors=${result.errors.length} dry_run=${result.dry_run}`,
  );

  return success<EnrichResult>(result);
}

// Programmatic entry — used by tests and internal callers.
export async function enrichParserNodesProgrammatic(
  opts: Partial<EnrichOptions> = {},
): Promise<ToolResponse<EnrichResult>> {
  const merged: EnrichOptions = {
    target: opts.target ?? "both",
    maxNodes: opts.maxNodes ?? 500,
    batchSize: opts.batchSize ?? 10,
    dryRun: opts.dryRun ?? false,
    force: opts.force ?? false,
    featureContextSize: opts.featureContextSize ?? 20,
  };
  return executeEnrichParserNodes(merged);
}

// ---------------------------------------------------------------------------
// Helper used by tests and downstream code that needs the typed entity view.
// (Re-exports preserved so consumers can rely on Feature/DataModelEntity.)
// ---------------------------------------------------------------------------

export type EnrichableParserEntity = Feature | DataModelEntity;
export type { ParserNodeRecord, PerNodeEnrichment, EnrichResult, EnrichOptions };

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerEnrichParserNodesTool(server: McpServer): void {
  server.tool(
    "enrich_parser_nodes",
    "Autonomous batch enrichment for parser-discovered nodes. After scan_project " +
      "populates data_model.json and features.json with structural facts, this tool " +
      "calls the configured LLM provider to add semantic data (description rewrite, " +
      "intent, purpose, tags, feature anchors) to every eligible parser-origin entry " +
      "in a single invocation. Uses internal batching (default 10 nodes per LLM call) " +
      "and persists after each batch for crash safety. Filters to entries where " +
      "`provenance.scanner === \"native\"` and `enrichment.enriched !== true` (unless " +
      "force is true). Preserves the original parser description in description_raw. " +
      "Proposed feature anchors are written as weak GraphLinks on the entity — they " +
      "do not bypass the dream/normalize edge promotion pipeline.",
    {
      target: z
        .enum(["data_model", "features", "both"])
        .default("both")
        .describe("Which file(s) to enrich. Default: both."),
      max_nodes: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .default(500)
        .describe("Hard cap on nodes processed per invocation across both files."),
      batch_size: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("Number of nodes per LLM call. Smaller = more LLM calls but better focus."),
      dry_run: z
        .boolean()
        .default(false)
        .describe("When true, run the LLM but do not persist any changes. Useful for previewing."),
      force: z
        .boolean()
        .default(false)
        .describe("When true, re-enrich entries that have already been enriched."),
      feature_context_size: z
        .number()
        .int()
        .min(0)
        .max(100)
        .default(20)
        .describe("How many sibling features to include as anchor context per bucket."),
    },
    async ({ target, max_nodes, batch_size, dry_run, force, feature_context_size }) => {
      logger.info(
        `enrich_parser_nodes: target=${target} max_nodes=${max_nodes} batch_size=${batch_size} ` +
          `dry_run=${dry_run} force=${force}`,
      );
      const res = await safeExecute<EnrichResult>(
        () =>
          executeEnrichParserNodes({
            target,
            maxNodes: max_nodes,
            batchSize: batch_size,
            dryRun: dry_run,
            force,
            featureContextSize: feature_context_size,
          }),
        "enrich_parser_nodes",
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(res, null, 2) }],
      };
    },
  );
}
