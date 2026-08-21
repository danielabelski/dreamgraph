/**
 * DreamGraph MCP Server — `enrich_parser_nodes` tool.
 *
 * Autonomous, batch semantic enrichment for every canonical graph node.
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
 *   1. Load every canonical graph store.
 *   2. Select every non-enriched node, or every node when `force` is true.
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
 *   - Writes to `validated_edges.json` (those must flow through the
 *     normalizer — anchors land as weak links on the entity).
 *   - UI panel.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  createLlmProviderForConfig,
  getArchitectLlmConfig,
  llmRouteFailureReason,
  selectLlmRoute,
  type LlmCompletionOptions,
  type LlmMessage,
  type LlmProvider,
  type LlmResponse,
  type LlmRouteSelection,
} from "../cognitive/llm.js";
import { buildAdaptiveFutureAuditTrail } from "../cognitive/adaptive-future-scaffold.js";
import { loadJsonArray, invalidateCache } from "../utils/cache.js";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { dataPath } from "../utils/paths.js";
import { success, error, safeExecute } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config/config.js";
import { loadAuxiliaryEntities } from "./auxiliary-store.js";
import {
  createArchitectCliBridgeSpawnPlan,
  resolveArchitectCliBridgeExecutablePath,
} from "../architect/cli-bridge.js";
import { updateGraphMaintenanceState } from "../cognitive/graph-maintenance-state.js";
import { scheduleTargetedDreamStabilization } from "../cognitive/targeted-dreams.js";
import { loadScanState } from "./scan-state.js";
import {
  classifyEnrichmentFailure,
  createEnrichmentRun,
  loadEnrichmentRun,
  persistEnrichmentRun,
  recordEnrichmentOutcome,
  resumableNodeIds,
  type EnrichmentRunState,
} from "./enrichment-state.js";
import type {
  ToolResponse,
  GraphLink,
  EnrichmentMetadata,
  Feature,
  DataModelEntity,
  AuxiliaryEntitiesFile,
  UIRegistryFile,
  SemanticElement,
} from "../types/index.js";
import type { AdaptiveFutureAuditTrail } from "../cognitive/adaptive-future-scaffold.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const ENRICHER_ID = "enrich_parser_nodes/1.1";

type TargetFile = "data_model" | "features" | "workflows" | "capabilities" | "ui" | "datastores" | "auxiliary";
type TargetSpec = TargetFile | "both" | "all";
type ModelSource = "auto" | "standalone" | "architect";
type GraphNodeType = "feature" | "workflow" | "data_model" | "ui_element" | "datastore" | "capability";

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
  graph_type?: GraphNodeType;
  trigger?: string;
  steps?: unknown[];
  table_name?: string;
  storage?: string;
  tables?: unknown[];
  kind?: string;
  data_contract?: SemanticElement["data_contract"];
  interactions?: SemanticElement["interactions"];
  implementations?: SemanticElement["implementations"];
  used_by?: string[];
  children?: string[];
  flows?: string[];
  visual_semantics?: SemanticElement["visual_semantics"];
  layout_semantics?: SemanticElement["layout_semantics"];
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
    evidence_excerpt: string;
  }>;
  relations: Array<{
    target_id: string;
    target_type: GraphNodeType;
    relationship: string;
    rationale: string;
    evidence_excerpt: string;
  }>;
  ui_knowledge?: {
    data_contract: SemanticElement["data_contract"];
    interactions: SemanticElement["interactions"];
    visual_semantics: NonNullable<SemanticElement["visual_semantics"]>;
    layout_semantics: NonNullable<SemanticElement["layout_semantics"]>;
    used_by: string[];
    children: string[];
  };
  confidence: number;
}

interface EnrichResult {
  target: TargetSpec;
  dry_run: boolean;
  files_processed: TargetFile[];
  total_eligible: number;
  total_enriched: number;
  total_skipped: number;
  feature_anchors_written: number;
  relations_written: number;
  enriched_node_ids: string[];
  enriched_node_ids_truncated: boolean;
  batches_run: number;
  llm_calls: number;
  tokens_used: number;
  duration_ms: number;
  errors: string[];
  notes: string[];
  /** UI nodes that received rich semantic metadata but still lack an evidenced relation. */
  ui_relation_gaps: string[];
  semantic_coverage: {
    total_nodes: number;
    llm_enriched: number;
    fallback_nodes: number;
    complete: boolean;
    context_hops: number;
    model_source: ModelSource;
  };
  semantic_cache: {
    enabled: boolean;
    nodes_served_from_cache: number;
    cache_misses: number;
    neighbor_entries_reused: number;
    low_confidence_rejections: number;
    conflicts_detected: number;
    source_files_considered: number;
    source_files_covered: number;
    source_reads_avoided: number;
    source_file_reads: number;
    source_file_cache_hits: number;
    prompt_source_reuses: number;
    prompt_neighbor_reuses: number;
  };
  targeted_dream_schedules: {
    created: number;
    reused: number;
    schedule_ids: string[];
  };
  enrichment_checkpoint: {
    file: string;
    run_id: string;
    scan_revision: string;
    provider_fingerprint: string;
    remaining: number;
    complete: boolean;
  };
  adaptive_future_audit?: AdaptiveFutureAuditTrail;
}

const UI_KNOWLEDGE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["data_contract", "interactions", "visual_semantics", "layout_semantics", "used_by", "children"],
  properties: {
    data_contract: {
      type: "object",
      additionalProperties: false,
      required: ["inputs", "outputs"],
      properties: {
        inputs: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "type", "description", "required"],
            properties: {
              name: { type: "string" },
              type: { type: "string" },
              description: { type: "string" },
              required: { type: "boolean" },
            },
          },
        },
        outputs: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "type", "description", "trigger"],
            properties: {
              name: { type: "string" },
              type: { type: "string" },
              description: { type: "string" },
              trigger: { type: "string" },
            },
          },
        },
      },
    },
    interactions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "description"],
        properties: {
          action: { type: "string" },
          description: { type: "string" },
        },
      },
    },
    visual_semantics: {
      type: "object",
      additionalProperties: false,
      required: ["visual_role", "emphasis", "density", "chrome", "state_styling"],
      properties: {
        visual_role: { type: "string" },
        emphasis: { type: "string", enum: ["primary", "secondary", "muted", "warning", "danger", "success", "info"] },
        density: { type: "string", enum: ["compact", "comfortable", "spacious"] },
        chrome: { type: "string", enum: ["minimal", "embedded", "panel", "full_shell"] },
        state_styling: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["state", "treatment"],
            properties: { state: { type: "string" }, treatment: { type: "string" } },
          },
        },
      },
    },
    layout_semantics: {
      type: "object",
      additionalProperties: false,
      required: ["pattern", "alignment", "sizing_behavior", "responsive_behavior", "hierarchy"],
      properties: {
        pattern: { type: "string", enum: ["stack", "split_view", "grid", "table", "toolbar", "flow", "inspector", "shell", "dialog"] },
        alignment: { type: "string", enum: ["leading", "centered", "distributed"] },
        sizing_behavior: { type: "string", enum: ["fixed", "fluid", "content_sized", "fill_parent"] },
        responsive_behavior: {
          type: "array",
          items: { type: "string", enum: ["wrap", "collapse", "scroll", "paginate", "promote_to_dialog"] },
        },
        hierarchy: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["region", "role"],
            properties: {
              region: { type: "string" },
              role: { type: "string", enum: ["primary", "secondary", "auxiliary"] },
            },
          },
        },
      },
    },
    used_by: { type: "array", items: { type: "string" } },
    children: { type: "array", items: { type: "string" } },
  },
};

function enrichmentJsonSchema(batch: readonly ParserNodeRecord[]): Record<string, unknown> {
  const uiBatch = batch.some((node) => node.graph_type === "ui_element");
  const resultProperties: Record<string, unknown> = {
    id: { type: "string" },
    description: { type: "string" },
    intent: { type: "string" },
    purpose: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    feature_anchors: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["target_id", "relationship", "rationale", "evidence_excerpt"],
        properties: {
          target_id: { type: "string" },
          relationship: {
            type: "string",
            enum: ["implements", "supports", "belongs_to", "realizes", "documents", "tests", "uses", "depends_on", "composes", "related_to"],
          },
          rationale: { type: "string" },
          evidence_excerpt: { type: "string", minLength: 1 },
        },
      },
    },
    relations: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["target_id", "target_type", "relationship", "rationale", "evidence_excerpt"],
        properties: {
          target_id: { type: "string" },
          target_type: { type: "string", enum: ["feature", "workflow", "data_model", "ui_element", "datastore", "capability"] },
          relationship: { type: "string" },
          rationale: { type: "string" },
          evidence_excerpt: { type: "string", minLength: 1 },
        },
      },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  };
  const required = ["id", "description", "intent", "purpose", "tags", "feature_anchors", "relations", "confidence"];
  if (uiBatch) {
    resultProperties.ui_knowledge = UI_KNOWLEDGE_JSON_SCHEMA;
    required.push("ui_knowledge");
  }
  return {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required,
        properties: resultProperties,
      },
    },
  },
  };
}

const SYSTEM_PROMPT = `You are DreamGraph's graph-wide semantic knowledge enricher.

You receive a small batch of graph nodes, a deduplicated source-evidence catalog, confidence-qualified semantic cache entries from already-enriched neighbors, and an unresolved neighborhood expanded to multiple hops. For EVERY input node, infer rich knowledge from the supplied evidence only. Treat high-confidence semantic cache entries as reusable evidence for the areas identified by evidence_plan; do not require source excerpts again for covered areas. Use source evidence for uncovered, stale, conflicting, or low-confidence areas, and reconcile cache conflicts in favor of the supplied source catalog. source_evidence_refs point to entries in that catalog. Follow causal, data-flow, composition, invocation, rendering, persistence, contract, configuration, and verification relations through the neighborhood instead of stopping at names or directory proximity.

Rules:
  1. Do NOT fabricate. If evidence is thin, state the evidence boundary in intent and lower confidence. Never invent a datastore, UI behavior, or code relation.
  2. description: write 2-4 substantive sentences explaining WHAT the node represents, WHY it exists, HOW it works or participates in a flow, and its meaningful relations to named neighbor nodes. Never return inventory prose such as "N source files in path/", "detected by scanner", or "auto-created from introspection".
  3. intent: one substantive sentence explaining the design need or user/system outcome this node serves.
  4. purpose: a concise semantic role tag such as configuration, service-locator, value-object, request-payload, domain-entity, workflow, datastore, or UI-shell.
  5. tags: 1-5 short lowercase indexing tokens.
  6. feature_anchors: retained for compatibility; use only for evidenced Feature links and exact supplied ids.
  7. relations: zero to eight deeper semantic links to exact ids in the supplied semantic cache or unresolved multi-hop neighborhoods. Prefer precise relations over related_to and include compact evidence for every relation.
  8. For graph_type=ui_element, also return ui_knowledge. List every source-evidenced prop as a data_contract input and always include at least one output describing the rendered information or state. Capture evidenced user interactions (an empty list is valid only for a passive component), abstract appearance and visual hierarchy, layout/composition, owning features, and child UI elements.
  9. confidence: self-reported 0..1 score for the whole record.
  10. id: echo the input id verbatim.

Allowed feature anchor relationships: implements, supports, belongs_to, realizes, documents, tests, uses, depends_on, composes, related_to.
Return strict JSON: { "results": [ ... ] } with one entry per input node, in the same order. Every result includes relations; ui_knowledge is included for UI nodes.`;

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

// ---------------------------------------------------------------------------
// UI registry adapter — translate SemanticElement <-> ParserNodeRecord so the
// same enrichment pipeline can process UI entries. UI elements have their own
// `purpose` field with established semantics; we keep that field as the role
// tag and route the LLM's role-tag output into the SAME field (idempotent
// when already enriched).
// ---------------------------------------------------------------------------

export function isUiParserOrigin(el: SemanticElement): boolean {
  return el?.source_kind === "scanner" && typeof el?.source_repo === "string" && el.source_repo.length > 0;
}

export function uiElementToRecord(el: SemanticElement): ParserNodeRecord {
  return {
    id: el.id,
    name: el.name,
    description: el.description ?? el.purpose,
    source_repo: el.source_repo,
    source_files: el.source_file ? [el.source_file] : (el.evidence_refs ?? []),
    domain: "ui",
    tags: Array.isArray(el.tags) ? [...el.tags] : [],
    links: Array.isArray(el.links)
      ? (el.links as GraphLink[]).map((l) => ({ ...l }))
      : [],
    provenance: { scanner: "native" },
    enrichment: el.enrichment,
    intent: el.intent,
    purpose: el.purpose,
    description_raw: el.description_raw,
    graph_type: "ui_element",
    data_contract: el.data_contract,
    interactions: el.interactions,
    implementations: el.implementations,
    used_by: el.used_by,
    children: el.children,
    flows: el.flows,
    visual_semantics: el.visual_semantics,
    layout_semantics: el.layout_semantics,
  };
}

async function loadUiRegistry(): Promise<UIRegistryFile | null> {
  const file = dataPath("ui_registry.json");
  if (!existsSync(file)) return null;
  try {
    const raw = await readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as UIRegistryFile;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.elements)) return null;
    return parsed;
  } catch (err) {
    logger.warn(`enrich_parser_nodes: failed to load ui_registry.json: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function saveUiRegistry(file: UIRegistryFile): Promise<void> {
  file.metadata.total_elements = file.elements.length;
  file.metadata.last_updated = new Date().toISOString();
  await atomicWriteFile(dataPath("ui_registry.json"), JSON.stringify(file, null, 2));
  invalidateCache("ui_registry.json");
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
    graph_type: n.graph_type,
    name: n.name,
    description: n.description,
    intent: n.intent,
    purpose: n.purpose,
    source_repo: n.source_repo,
    source_files: n.source_files,
    domain: n.domain,
    model_kind: n.model_kind,
    qualified_name: n.provenance?.qualified_name,
    language: n.provenance?.language,
    keywords: n.keywords,
    key_fields: Array.isArray(n.key_fields) ? n.key_fields.slice(0, 20) : [],
    relationships: Array.isArray(n.relationships) ? n.relationships.slice(0, 20) : [],
    links: Array.isArray(n.links) ? n.links.slice(0, 20) : [],
    trigger: n.trigger,
    steps: Array.isArray(n.steps) ? n.steps.slice(0, 30) : [],
    table_name: n.table_name,
    storage: n.storage,
    tables: Array.isArray(n.tables) ? n.tables.slice(0, 80) : [],
    data_contract: n.data_contract,
    interactions: n.interactions,
    implementations: n.implementations,
    used_by: n.used_by,
    children: n.children,
    flows: n.flows,
    visual_semantics: n.visual_semantics,
    layout_semantics: n.layout_semantics,
    enrichment: n.enrichment ? {
      enriched: n.enrichment.enriched,
      enriched_at: n.enrichment.enriched_at,
      enricher: n.enrichment.enricher,
      model: n.enrichment.model,
      confidence: n.enrichment.confidence,
      semantic_cache: n.enrichment.semantic_cache,
    } : undefined,
  };
}

function parseUiKnowledge(value: unknown): PerNodeEnrichment["ui_knowledge"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const contract = raw.data_contract;
  if (!contract || typeof contract !== "object") return undefined;
  const contractRaw = contract as Record<string, unknown>;
  if (!Array.isArray(contractRaw.inputs) || !Array.isArray(contractRaw.outputs) || !Array.isArray(raw.interactions)) return undefined;
  if (!raw.visual_semantics || typeof raw.visual_semantics !== "object") return undefined;
  if (!raw.layout_semantics || typeof raw.layout_semantics !== "object") return undefined;
  return {
    data_contract: {
      inputs: contractRaw.inputs.filter((item) => !!item && typeof item === "object") as SemanticElement["data_contract"]["inputs"],
      outputs: contractRaw.outputs.filter((item) => !!item && typeof item === "object") as SemanticElement["data_contract"]["outputs"],
    },
    interactions: raw.interactions.filter((item) => !!item && typeof item === "object") as SemanticElement["interactions"],
    visual_semantics: raw.visual_semantics as NonNullable<SemanticElement["visual_semantics"]>,
    layout_semantics: raw.layout_semantics as NonNullable<SemanticElement["layout_semantics"]>,
    used_by: Array.isArray(raw.used_by) ? raw.used_by.filter((id): id is string => typeof id === "string") : [],
    children: Array.isArray(raw.children) ? raw.children.filter((id): id is string => typeof id === "string") : [],
  };
}

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
              target_id: typeof a.target_id === "string" ? a.target_id.trim() : "",
              relationship: typeof a.relationship === "string" ? a.relationship.trim() : "",
              rationale: typeof a.rationale === "string" ? a.rationale.trim() : "",
              evidence_excerpt: typeof a.evidence_excerpt === "string" ? a.evidence_excerpt.trim() : "",
            }))
            .filter((a) => a.target_id.length > 0)
        : [],
      relations: Array.isArray(rec.relations)
        ? rec.relations
            .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
            .map((a) => ({
              target_id: typeof a.target_id === "string" ? a.target_id.trim() : "",
              target_type: typeof a.target_type === "string" ? a.target_type as GraphNodeType : "capability",
              relationship: typeof a.relationship === "string" ? a.relationship.trim() : "related_to",
              rationale: typeof a.rationale === "string" ? a.rationale.trim() : "",
              evidence_excerpt: typeof a.evidence_excerpt === "string" ? a.evidence_excerpt.trim() : "",
            }))
            .filter((a) => a.target_id.length > 0)
        : [],
      ui_knowledge: parseUiKnowledge(rec.ui_knowledge),
      confidence:
        typeof rec.confidence === "number" && rec.confidence >= 0 && rec.confidence <= 1
          ? rec.confidence
          : 0.5,
    });
  }
  return out;
}

const FEATURE_ANCHOR_RELATIONSHIPS = new Set([
  "implements",
  "supports",
  "belongs_to",
  "realizes",
  "documents",
  "tests",
  "uses",
  "depends_on",
  "composes",
  "related_to",
]);
const MAX_FEATURE_ANCHORS_PER_NODE = 5;

function validateBatchEnrichments(
  enrichments: PerNodeEnrichment[],
  batch: ParserNodeRecord[],
  validAnchorIds: ReadonlySet<string>,
  validRelationTargets: ReadonlyMap<string, GraphNodeType> = new Map(),
): string[] {
  const errors: string[] = [];
  const expectedIds = new Set(batch.map((node) => node.id));
  const nodesById = new Map(batch.map((node) => [node.id, node]));
  const seenIds = new Set<string>();

  for (const enrichment of enrichments) {
    if (!expectedIds.has(enrichment.id)) {
      errors.push(`unknown node id ${enrichment.id}`);
      continue;
    }
    if (seenIds.has(enrichment.id)) {
      errors.push(`duplicate node id ${enrichment.id}`);
    }
    seenIds.add(enrichment.id);
    if (/\b\d+\s+source file\(s\)|detected by (?:the )?scanner|auto-created from datastore introspection/i.test(enrichment.description)) {
      errors.push(`${enrichment.id}: hollow structural description was not replaced`);
    }
    if (enrichment.description.trim().length < 80 || enrichment.intent.trim().length < 24) {
      errors.push(`${enrichment.id}: semantic description or intent is too shallow`);
    }
    if (nodesById.get(enrichment.id)?.graph_type === "ui_element") {
      if (!enrichment.ui_knowledge) {
        errors.push(`${enrichment.id}: UI enrichment is missing data contract, interaction, appearance, and layout knowledge`);
      } else {
        if (enrichment.ui_knowledge.data_contract.outputs.length === 0) {
          errors.push(`${enrichment.id}: UI enrichment has no rendered-surface output contract`);
        }
        const visual = enrichment.ui_knowledge.visual_semantics;
        const layout = enrichment.ui_knowledge.layout_semantics;
        if (!visual.visual_role || !visual.emphasis || !visual.density || !visual.chrome) {
          errors.push(`${enrichment.id}: UI enrichment has incomplete visual semantics`);
        }
        if (!layout.pattern || !layout.alignment || !layout.sizing_behavior) {
          errors.push(`${enrichment.id}: UI enrichment has incomplete layout semantics`);
        }
      }
    }
    if (enrichment.feature_anchors.length > MAX_FEATURE_ANCHORS_PER_NODE) {
      errors.push(`${enrichment.id}: excessive feature anchors (${enrichment.feature_anchors.length} > ${MAX_FEATURE_ANCHORS_PER_NODE})`);
    }
    for (const anchor of enrichment.feature_anchors) {
      if (!validAnchorIds.has(anchor.target_id)) {
        errors.push(`${enrichment.id}: unknown feature anchor ${anchor.target_id}`);
      }
      if (!FEATURE_ANCHOR_RELATIONSHIPS.has(anchor.relationship)) {
        errors.push(`${enrichment.id}: invalid feature anchor relationship ${anchor.relationship}`);
      }
      if (!anchor.evidence_excerpt.trim()) {
        errors.push(`${enrichment.id}: missing feature anchor evidence excerpt for ${anchor.target_id}`);
      }
    }
    for (const relation of enrichment.relations.slice(0, 8)) {
      const targetType = validRelationTargets.get(relation.target_id);
      if (!targetType || relation.target_id === enrichment.id) {
        errors.push(`${enrichment.id}: unknown relation target ${relation.target_id}`);
      } else if (targetType !== relation.target_type) {
        errors.push(`${enrichment.id}: relation type mismatch for ${relation.target_id}`);
      }
      if (!relation.relationship || !relation.evidence_excerpt) {
        errors.push(`${enrichment.id}: incomplete relation evidence for ${relation.target_id}`);
      }
    }
  }

  for (const id of expectedIds) {
    if (!seenIds.has(id)) {
      errors.push(`missing enrichment for node ${id}`);
    }
  }

  return errors;
}

function structuralEnrichmentFor(node: ParserNodeRecord): PerNodeEnrichment {
  const kind = typeof node.model_kind === "string" && node.model_kind.trim()
    ? node.model_kind.trim()
    : "parser-node";
  const name = typeof node.name === "string" && node.name.trim() ? node.name.trim() : node.id;
  const source = Array.isArray(node.source_files) && node.source_files.length > 0
    ? ` from ${node.source_files.slice(0, 2).join(", ")}`
    : "";
  return {
    id: node.id,
    description: `${name} is a ${kind} evidenced${source || " by the canonical graph record"}. ` +
      `Its declared fields, source provenance, and explicit links define how it participates in the project while semantic model output is unavailable. ` +
      `This evidence-only account is intentionally provisional and will be replaced by the next successful LLM enrichment pass.`,
    intent: `Preserve the evidenced role of ${name} without inventing behavior until validated semantic model output is available.`,
    purpose: kind.split(":").pop()?.replace(/[^a-z0-9_-]/gi, "-").toLowerCase() || "parser-node",
    tags: ["parser-discovered", "structural-fallback"],
    feature_anchors: [],
    relations: [],
    confidence: 0.3,
  };
}

export function mergeEnrichment(
  node: ParserNodeRecord,
  e: PerNodeEnrichment,
  validAnchorIds: ReadonlySet<string>,
  model: string | undefined,
  nowIso: string,
  validRelationTargets: ReadonlyMap<string, GraphNodeType> = new Map(),
  evidence?: { plan: SemanticCachePlan; sourceFilesRead: string[]; contextHops: number },
): { node: ParserNodeRecord; anchorsAdded: number; relationsAdded: number } {
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

  // Build feature anchor GraphLinks, filtered to known target ids. Validation
  // happens before this function is called; these guards keep the merge safe
  // if a caller uses the helper directly.
  const existingLinks: GraphLink[] = Array.isArray(node.links) ? [...node.links] : [];
  const existingTargets = new Set(existingLinks.map((l) => l.target));
  let anchorsAdded = 0;
  for (const a of e.feature_anchors) {
    if (!validAnchorIds.has(a.target_id)) continue;
    if (!FEATURE_ANCHOR_RELATIONSHIPS.has(a.relationship)) continue;
    if (!a.evidence_excerpt.trim()) continue;
    if (existingTargets.has(a.target_id)) continue;
    existingLinks.push({
      target: a.target_id,
      type: "feature",
      relationship: a.relationship || "related_to",
      description: a.rationale || `Feature anchor proposed by ${ENRICHER_ID}`,
      strength: "weak",
      meta: {
        evidence_excerpt: a.evidence_excerpt,
        confidence: e.confidence,
        selected_by: ENRICHER_ID,
      },
    });
    existingTargets.add(a.target_id);
    anchorsAdded++;
  }

  let relationsAdded = 0;
  for (const relation of (e.relations ?? []).slice(0, 8)) {
    const targetType = validRelationTargets.get(relation.target_id);
    if (!targetType || targetType !== relation.target_type || relation.target_id === node.id) continue;
    if (!relation.relationship || !relation.evidence_excerpt || existingTargets.has(relation.target_id)) continue;
    existingLinks.push({
      target: relation.target_id,
      type: relation.target_type,
      relationship: relation.relationship,
      description: relation.rationale || `Semantic relation discovered by ${ENRICHER_ID}`,
      strength: "weak",
      meta: {
        evidence_excerpt: relation.evidence_excerpt,
        confidence: e.confidence,
        selected_by: ENRICHER_ID,
      },
    });
    existingTargets.add(relation.target_id);
    relationsAdded++;
  }

  const enrichment: EnrichmentMetadata = {
    enriched: model !== "deterministic_fallback",
    enriched_at: nowIso,
    enricher: ENRICHER_ID,
    ...(model ? { model } : {}),
    confidence: e.confidence,
    ...(evidence ? {
      semantic_cache: {
        coverage: evidence.plan.coverage,
        cache_confidence: evidence.plan.cache_confidence,
        reused_neighbor_ids: evidence.plan.reused_neighbor_ids,
        source_files_considered: evidence.plan.source_files_considered,
        source_files_covered: evidence.plan.source_files_covered,
        source_files_read: evidence.sourceFilesRead,
        conflicts: evidence.plan.conflicts,
        context_hops: Math.max(2, evidence.contextHops),
      },
    } : {}),
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

  return { node: next, anchorsAdded, relationsAdded };
}

function mergeUniqueIds(
  existing: string[] | undefined,
  enriched: string[],
  accepts: (id: string) => boolean,
): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const id of [...(existing ?? []), ...enriched]) {
    if (typeof id !== "string" || !accepts(id) || seen.has(id)) continue;
    seen.add(id);
    merged.push(id);
  }
  return merged;
}

function mergeNamedRecords<T extends Record<string, unknown>>(
  existing: T[] | undefined,
  enriched: T[],
  key: keyof T,
): T[] {
  const merged = new Map<string, T>();
  for (const item of [...(existing ?? []), ...enriched]) {
    const value = String(item[key] ?? "").trim().toLowerCase();
    if (!value) continue;
    // Enriched entries appear last and replace scanner summaries for the same
    // source-grounded contract member while scanner-only facts survive.
    merged.set(value, item);
  }
  return [...merged.values()];
}

function uiHasEvidencedRelation(node: ParserNodeRecord, enrichment: PerNodeEnrichment): boolean {
  return (node.links?.length ?? 0) > 0 ||
    (node.used_by?.length ?? 0) > 0 ||
    (node.children?.length ?? 0) > 0 ||
    (node.flows?.length ?? 0) > 0 ||
    enrichment.relations.length > 0 ||
    enrichment.feature_anchors.length > 0 ||
    (enrichment.ui_knowledge?.used_by.length ?? 0) > 0 ||
    (enrichment.ui_knowledge?.children.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Core execution
// ---------------------------------------------------------------------------

interface EnrichOptions {
  target: TargetSpec;
  maxNodes: number;
  batchSize: number;
  dryRun: boolean;
  force: boolean;
  featureContextSize: number;
  contextHops: number;
  relationContextSize: number;
  modelSource: ModelSource;
  scheduleStabilization: boolean;
  semanticCache: boolean;
  semanticCacheMinConfidence: number;
  semanticCacheMinCoverage: number;
  /** Emits durable batch milestones to callers of long-running graph operations. */
  onProgress?: (message: string, batch: number) => void;
}

function withGraphType(entries: ParserNodeRecord[], graphType: GraphNodeType): ParserNodeRecord[] {
  return entries.map((entry) => ({ ...entry, graph_type: graphType }));
}

function sourceFilesFor(node: ParserNodeRecord): string[] {
  return Array.isArray(node.source_files)
    ? node.source_files.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
}

function words(value: unknown): Set<string> {
  const tokens = String(value ?? "").toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [];
  return new Set(tokens.filter((token) => !["source", "files", "generated", "native", "scanner"].includes(token)));
}

function semanticAffinity(a: ParserNodeRecord, b: ParserNodeRecord): number {
  if (a.id === b.id) return -1;
  let score = 0;
  if (a.source_repo && a.source_repo === b.source_repo) score += 2;
  if (a.domain && a.domain === b.domain) score += 2;
  const aFiles = sourceFilesFor(a);
  const bFiles = new Set(sourceFilesFor(b));
  if (aFiles.some((file) => bFiles.has(file))) score += 8;
  const aDirs = new Set(aFiles.map((file) => path.posix.dirname(file)));
  if (sourceFilesFor(b).some((file) => aDirs.has(path.posix.dirname(file)))) score += 3;
  const aWords = words([a.name, a.id, a.description, a.intent, a.keywords, a.tags].flat().join(" "));
  const bWords = words([b.name, b.id, b.description, b.intent, b.keywords, b.tags].flat().join(" "));
  for (const token of aWords) if (bWords.has(token)) score += 1;
  return score;
}

function explicitNeighborIds(node: ParserNodeRecord): string[] {
  const ids = new Set<string>();
  for (const link of Array.isArray(node.links) ? node.links : []) if (link?.target) ids.add(link.target);
  for (const field of [node.used_by, node.children, node.flows]) {
    if (Array.isArray(field)) for (const id of field) if (typeof id === "string") ids.add(id);
  }
  if (Array.isArray(node.relationships)) {
    for (const relationship of node.relationships) {
      if (relationship && typeof relationship === "object") {
        const target = (relationship as { target?: unknown }).target;
        if (typeof target === "string") ids.add(target);
      }
    }
  }
  return [...ids];
}

/** Build an undirected semantic neighborhood and traverse it beyond one hop. */
function buildSemanticAdjacency(allNodes: ParserNodeRecord[]): {
  byId: Map<string, ParserNodeRecord>;
  adjacency: Map<string, Set<string>>;
} {
  const byId = new Map(allNodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, Set<string>>();
  const connect = (left: string, right: string): void => {
    if (!byId.has(left) || !byId.has(right) || left === right) return;
    const l = adjacency.get(left) ?? new Set<string>(); l.add(right); adjacency.set(left, l);
    const r = adjacency.get(right) ?? new Set<string>(); r.add(left); adjacency.set(right, r);
  };
  for (const node of allNodes) for (const target of explicitNeighborIds(node)) connect(node.id, target);

  // Structural scanners do not always emit links. Add only the strongest
  // source/domain/name candidates so subsequent hops have useful evidence.
  // Candidate indexes keep this bounded for large repositories instead of
  // performing an all-pairs comparison.
  const index = new Map<string, string[]>();
  const addIndex = (key: string, id: string): void => {
    if (!key) return;
    const values = index.get(key) ?? [];
    if (values.length < 100) values.push(id);
    index.set(key, values);
  };
  for (const node of allNodes) {
    addIndex(`domain:${node.source_repo ?? ""}:${node.domain ?? ""}`, node.id);
    for (const file of sourceFilesFor(node)) {
      addIndex(`file:${node.source_repo ?? ""}:${file}`, node.id);
      addIndex(`dir:${node.source_repo ?? ""}:${path.posix.dirname(file)}`, node.id);
    }
    for (const token of words([node.name, node.id, node.keywords, node.tags].flat().join(" "))) {
      addIndex(`word:${node.source_repo ?? ""}:${token}`, node.id);
    }
  }
  for (const node of allNodes) {
    const candidateIds = new Set<string>();
    candidateIds.add(node.id);
    const keys = [`domain:${node.source_repo ?? ""}:${node.domain ?? ""}`];
    for (const file of sourceFilesFor(node)) {
      keys.push(`file:${node.source_repo ?? ""}:${file}`);
      keys.push(`dir:${node.source_repo ?? ""}:${path.posix.dirname(file)}`);
    }
    for (const token of words([node.name, node.id, node.keywords, node.tags].flat().join(" "))) {
      keys.push(`word:${node.source_repo ?? ""}:${token}`);
    }
    for (const key of keys) for (const id of index.get(key) ?? []) candidateIds.add(id);
    const candidates = [...candidateIds]
      .map((id) => ({ id, score: semanticAffinity(node, byId.get(id)!) }))
      .filter((candidate) => candidate.score >= 4)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
    for (const candidate of candidates) connect(node.id, candidate.id);
  }
  return { byId, adjacency };
}

function walkMultiHopContext(
  root: ParserNodeRecord,
  graph: ReturnType<typeof buildSemanticAdjacency>,
  contextHops: number,
  maxNodes: number,
): ParserNodeRecord[] {
  const { byId, adjacency } = graph;
  const visited = new Set<string>([root.id]);
  let frontier = [root.id];
  const result: ParserNodeRecord[] = [];
  for (let hop = 1; hop <= Math.max(2, contextHops) && frontier.length > 0 && result.length < maxNodes; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        const found = byId.get(neighbor);
        if (found) result.push(found);
        next.push(neighbor);
        if (result.length >= maxNodes) break;
      }
      if (result.length >= maxNodes) break;
    }
    frontier = next;
  }
  return result;
}

export function buildMultiHopContext(
  root: ParserNodeRecord,
  allNodes: ParserNodeRecord[],
  contextHops: number,
  maxNodes: number,
): ParserNodeRecord[] {
  return walkMultiHopContext(root, buildSemanticAdjacency(allNodes), contextHops, maxNodes);
}

export interface SemanticCachePlan {
  cache_entries: ParserNodeRecord[];
  reused_neighbor_ids: string[];
  low_confidence_neighbor_ids: string[];
  source_files_considered: string[];
  source_files_covered: string[];
  source_files_to_read: string[];
  coverage: number;
  cache_confidence: number;
  sufficient: boolean;
  conflicts: string[];
}

interface SemanticCachePlannerOptions {
  enabled: boolean;
  minConfidence: number;
  minCoverage: number;
  sourceModifiedAt?: ReadonlyMap<string, number>;
}

interface SourceEvidenceEntry {
  evidence_id: string;
  repo: string;
  file: string;
  excerpt: string;
}

function normalizedSourceFile(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function nodeSemanticCompleteness(node: ParserNodeRecord): number {
  let score = 0;
  if (String(node.description ?? "").trim().length >= 80) score += 0.3;
  if (String(node.intent ?? "").trim().length >= 24) score += 0.25;
  if (String(node.purpose ?? "").trim().length >= 3) score += 0.1;
  if ((node.links?.length ?? 0) > 0 || (node.relationships?.length ?? 0) > 0 || (node.flows?.length ?? 0) > 0) score += 0.15;
  if ((node.tags?.length ?? 0) > 0 || (node.keywords?.length ?? 0) > 0) score += 0.1;
  if ((node.steps?.length ?? 0) > 0 || (node.key_fields?.length ?? 0) > 0 || node.data_contract || node.visual_semantics || node.tables?.length) score += 0.1;
  return Math.min(1, score);
}

function nodeCacheConfidence(node: ParserNodeRecord): number {
  const stated = node.enrichment?.confidence;
  const completeness = nodeSemanticCompleteness(node);
  const hasRichCore = String(node.description ?? "").trim().length >= 80
    && String(node.intent ?? "").trim().length >= 24
    && String(node.purpose ?? "").trim().length >= 3;
  // A self-reported score cannot turn a hollow or mechanically seeded record
  // into trusted semantic evidence. Rich core knowledge is a hard cache gate.
  if (!hasRichCore) return Math.min(0.5, completeness);
  return typeof stated === "number" && Number.isFinite(stated)
    ? Math.sqrt(Math.max(0, Math.min(1, stated)) * completeness)
    : completeness;
}

function hasDirectSemanticRelation(left: ParserNodeRecord, right: ParserNodeRecord): boolean {
  if (left.links?.some((link) => link.target === right.id) || right.links?.some((link) => link.target === left.id)) return true;
  const targets = (node: ParserNodeRecord): string[] => (node.relationships ?? []).flatMap((relationship) => {
    if (typeof relationship === "string") return [relationship];
    if (relationship && typeof relationship === "object" && "target" in relationship) return [String((relationship as { target?: unknown }).target ?? "")];
    return [];
  });
  return targets(left).includes(right.id) || targets(right).includes(left.id);
}

/**
 * Decide which persisted neighbor semantics can replace source reads for a
 * node. Exact shared source files and explicit graph relations are the only
 * coverage signals; weak name/directory affinity can discover a neighbor but
 * cannot by itself suppress source evidence.
 */
export function buildSemanticCachePlan(
  root: ParserNodeRecord,
  neighborhood: readonly ParserNodeRecord[],
  options: SemanticCachePlannerOptions,
): SemanticCachePlan {
  const considered = sourceFilesFor(root).slice(0, 3).map(normalizedSourceFile);
  if (!options.enabled) {
    return {
      cache_entries: [], reused_neighbor_ids: [], low_confidence_neighbor_ids: [],
      source_files_considered: considered, source_files_covered: [], source_files_to_read: considered,
      coverage: 0, cache_confidence: 0, sufficient: false, conflicts: [],
    };
  }

  const trusted: Array<{ node: ParserNodeRecord; confidence: number; shared: string[]; direct: boolean }> = [];
  const lowConfidence: string[] = [];
  for (const neighbor of neighborhood) {
    if (!isAlreadyEnriched(neighbor)) continue;
    const confidence = nodeCacheConfidence(neighbor);
    const direct = hasDirectSemanticRelation(root, neighbor);
    const neighborFiles = new Set(sourceFilesFor(neighbor).map(normalizedSourceFile));
    const shared = considered.filter((file) => neighborFiles.has(file));
    if (shared.length === 0 && !direct) continue;
    if (confidence < options.minConfidence) {
      lowConfidence.push(neighbor.id);
      continue;
    }
    trusted.push({ node: neighbor, confidence, shared, direct });
  }

  const covered = new Set<string>();
  const staleFiles = new Set<string>();
  const conflicts: string[] = [];
  for (const entry of trusted) {
    const enrichedAt = Date.parse(entry.node.enrichment?.enriched_at ?? "");
    for (const file of entry.shared) {
      const modifiedAt = options.sourceModifiedAt?.get(file);
      const stale = modifiedAt !== undefined && (!Number.isFinite(enrichedAt) || modifiedAt > enrichedAt + 1_000);
      if (stale) {
        staleFiles.add(file);
        conflicts.push(`source_newer_than_cache:${file}:${entry.node.id}`);
      } else {
        covered.add(file);
      }
    }
  }
  // A fresh entry must not hide a stale entry for the same file. Conflicting
  // cache claims require one source read so the model can reconcile them.
  for (const file of staleFiles) covered.delete(file);

  const relevant = trusted.filter((entry) => entry.direct || entry.shared.length > 0);
  const cacheConfidence = relevant.length > 0
    ? relevant.reduce((sum, entry) => sum + entry.confidence, 0) / relevant.length
    : 0;
  const directCoverage = relevant.some((entry) => entry.direct) ? 1 : 0;
  const fileCoverage = considered.length > 0 ? covered.size / considered.length : 0;
  const coverage = considered.length > 0
    ? fileCoverage * 0.75 + directCoverage * 0.25
    : directCoverage;
  const confidenceSufficient = cacheConfidence >= options.minConfidence;
  const sourceFilesToRead = confidenceSufficient
    ? considered.filter((file) => !covered.has(file))
    : considered;
  const sufficient = relevant.length > 0 && confidenceSufficient && coverage >= options.minCoverage && conflicts.length === 0 && sourceFilesToRead.length === 0;

  return {
    cache_entries: relevant.map((entry) => entry.node).slice(0, 20),
    reused_neighbor_ids: relevant.map((entry) => entry.node.id),
    low_confidence_neighbor_ids: lowConfidence,
    source_files_considered: considered,
    source_files_covered: [...covered],
    source_files_to_read: sourceFilesToRead,
    coverage: Number(coverage.toFixed(4)),
    cache_confidence: Number(cacheConfidence.toFixed(4)),
    sufficient,
    conflicts,
  };
}

function resolveRepoSource(node: ParserNodeRecord, relativeFile: string): { key: string; root: string; absolute: string; relative: string } | null {
  const repo = node.source_repo ?? "";
  const repoRoot = repo ? config.repos[repo] : undefined;
  if (!repoRoot) return null;
  const root = path.resolve(repoRoot);
  const absolute = path.resolve(root, relativeFile);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return { key: `${repo}:${normalizedSourceFile(relativeFile)}`, root, absolute, relative: normalizedSourceFile(relativeFile) };
}

async function sourceModifiedTimes(
  node: ParserNodeRecord,
  files: readonly string[],
  cache: Map<string, Promise<number | null>>,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  await Promise.all(files.map(async (file) => {
    const resolved = resolveRepoSource(node, file);
    if (!resolved) return;
    let pending = cache.get(resolved.key);
    if (!pending) {
      pending = stat(resolved.absolute).then((value) => value.mtimeMs).catch(() => null);
      cache.set(resolved.key, pending);
    }
    const modifiedAt = await pending;
    if (modifiedAt !== null) result.set(normalizedSourceFile(file), modifiedAt);
  }));
  return result;
}

async function loadSourceEvidence(
  node: ParserNodeRecord,
  files: readonly string[],
  cache: Map<string, Promise<SourceEvidenceEntry | null>>,
  metrics: EnrichResult["semantic_cache"],
): Promise<SourceEvidenceEntry[]> {
  const evidence: SourceEvidenceEntry[] = [];
  for (const relativeFile of files) {
    const resolved = resolveRepoSource(node, relativeFile);
    if (!resolved) continue;
    let pending = cache.get(resolved.key);
    if (pending) {
      metrics.source_file_cache_hits++;
    } else {
      metrics.source_file_reads++;
      pending = readFile(resolved.absolute, "utf-8")
        .then((content) => ({
          evidence_id: `source:${resolved.key}`,
          repo: node.source_repo ?? "",
          file: resolved.relative,
          excerpt: content.slice(0, 6000),
        }))
        .catch(() => null);
      cache.set(resolved.key, pending);
    }
    const loaded = await pending;
    if (loaded) evidence.push(loaded);
  }
  return evidence;
}

/**
 * Read-only adapter for reusing the Architect Codex CLI selection when the
 * daemon has no standalone API provider. The enrichment prompt already
 * contains the bounded graph/source evidence, so this adapter does not grant
 * the child process write access or require a recursive MCP connection.
 */
class ArchitectCodexEnrichmentProvider implements LlmProvider {
  readonly name = "architect-codex-cli";

  constructor(private readonly configuredModel: string, private readonly timeoutMs: number) {}

  private async executable(): Promise<string | null> {
    const configured = process.env.DREAMGRAPH_ARCHITECT_CODEX_CLI_BINARY?.trim() || "codex";
    return resolveArchitectCliBridgeExecutablePath(configured, process.env);
  }

  async isAvailable(): Promise<boolean> {
    return (await this.executable()) !== null;
  }

  async complete(messages: LlmMessage[], options: LlmCompletionOptions = {}): Promise<LlmResponse> {
    const executable = await this.executable();
    if (!executable) throw new Error("Architect Codex CLI executable was not found");
    const scratch = await mkdtemp(path.join(tmpdir(), "dreamgraph-enrich-"));
    const outputFile = path.join(scratch, "last-message.json");
    const schemaFile = path.join(scratch, "output-schema.json");
    const model = options.model || this.configuredModel;
    const args = [
      "exec", "--json", "--cd", scratch, "--sandbox", "read-only",
      "--output-last-message", outputFile, "--skip-git-repo-check", "--ignore-rules", "--ephemeral",
    ];
    if (options.jsonSchema) {
      await writeFile(schemaFile, JSON.stringify(options.jsonSchema.schema), "utf-8");
      args.push("--output-schema", schemaFile);
    }
    if (model && model !== "auto") args.push("--model", model);
    if (model.startsWith("gpt-5.6")) args.push("-c", 'model_reasoning_effort="xhigh"');
    args.push("-");
    const prompt = messages.map((message) => `## ${message.role.toUpperCase()}\n${message.content}`).join("\n\n");

    try {
      const stderr = await new Promise<string>((resolve, reject) => {
        const spawnPlan = createArchitectCliBridgeSpawnPlan(executable, args);
        const child = spawn(spawnPlan.command, spawnPlan.args, {
          cwd: scratch,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          stdio: ["pipe", "ignore", "pipe"],
          windowsHide: true,
          windowsVerbatimArguments: spawnPlan.windowsVerbatimArguments,
        });
        let errors = "";
        const timer = setTimeout(() => child.kill(), Math.max(30_000, this.timeoutMs));
        child.stderr.on("data", (chunk) => { errors += String(chunk); });
        child.on("error", (err) => { clearTimeout(timer); reject(err); });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(errors);
          else reject(new Error(`Architect Codex CLI exited ${code}: ${errors.slice(-2000)}`));
        });
        child.stdin.end(prompt);
      });
      void stderr;
      const text = await readFile(outputFile, "utf-8");
      return { text, model: model || "architect-codex-cli", tokensUsed: 0 };
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function selectEnrichmentRoute(modelSource: ModelSource): Promise<LlmRouteSelection> {
  if (modelSource !== "architect") {
    const standalone = await selectLlmRoute({
      task: "graph_enrichment",
      daemon_component: "dreamer",
      daemon_temperature: 0.2,
      max_tokens: 8192,
    });
    if (modelSource === "standalone" || standalone.layer !== "deterministic_fallback") return standalone;
  }

  const architect = getArchitectLlmConfig();
  const architectAdapter = process.env.DREAMGRAPH_LLM_ARCHITECT_ADAPTER?.trim().toLowerCase();
  if (architectAdapter === "codex-cli") {
    const boundedTimeoutMs = Math.max(60_000, Math.min(architect.timeoutMs, 180_000));
    const cliProvider = new ArchitectCodexEnrichmentProvider(architect.model || "auto", boundedTimeoutMs);
    if (await cliProvider.isAvailable()) {
      return {
        layer: "connected",
        provider: cliProvider,
        model: architect.model || "auto",
        options: { maxTokens: 8192, model: architect.model || "auto" },
        provenance: {
          task: "graph_enrichment",
          layer: "connected",
          provider: cliProvider.name,
          model: architect.model || "auto",
          source: "architect",
        },
      };
    }
  }
  const provider = createLlmProviderForConfig(architect);
  if (architect.provider !== "none" && architect.model && await provider.isAvailable()) {
    return {
      layer: "connected",
      provider,
      model: architect.model,
      options: { temperature: 0.2, maxTokens: Math.max(4096, architect.maxTokens), model: architect.model },
      provenance: {
        task: "graph_enrichment",
        layer: "connected",
        provider: provider.name,
        model: architect.model,
        source: "architect",
        temperature: 0.2,
      },
    };
  }

  return selectLlmRoute({
    task: "graph_enrichment",
    daemon_component: "dreamer",
    daemon_temperature: 0.2,
    max_tokens: 8192,
  });
}

export { executeEnrichParserNodes };

async function executeEnrichParserNodes(
  opts: EnrichOptions,
): Promise<ToolResponse<EnrichResult>> {
  const started = Date.now();
  const route = await selectEnrichmentRoute(opts.modelSource);
  const standaloneFallbackRoute = opts.modelSource === "architect"
    ? await selectLlmRoute({
        task: "graph_enrichment",
        daemon_component: "dreamer",
        daemon_temperature: 0.2,
        max_tokens: 8192,
      })
    : null;

  // Always load both files: features supply anchor context even when only
  // data_model is being enriched.
  const allFeatures = withGraphType((await loadJsonArray<ParserNodeRecord>("features.json")) ?? [], "feature");
  const allDataModel = withGraphType((await loadJsonArray<ParserNodeRecord>("data_model.json")) ?? [], "data_model");
  const allWorkflows = withGraphType((await loadJsonArray<ParserNodeRecord>("workflows.json")) ?? [], "workflow");
  const allCapabilities = withGraphType((await loadJsonArray<ParserNodeRecord>("capabilities.json")) ?? [], "capability");
  const allDatastores = withGraphType((await loadJsonArray<ParserNodeRecord>("datastores.json")) ?? [], "datastore");
  const auxiliaryFile = await loadAuxiliaryEntities();
  const allAuxiliary = withGraphType(auxiliaryFile.entries as unknown as ParserNodeRecord[], "capability");

  // Normalize legacy `"both"` → features + data_model (without UI) with a
  // deprecation note in the result. Slice 1 introduces `"ui"` and `"all"`;
  // `"both"` becomes semantically ambiguous and will be removed in a future
  // release.
  const deprecationNotes: string[] = [];
  const resolvedTarget = opts.target;
  const wantsFeatures = resolvedTarget === "features" || resolvedTarget === "both" || resolvedTarget === "all";
  const wantsDataModel = resolvedTarget === "data_model" || resolvedTarget === "both" || resolvedTarget === "all";
  const wantsUi = resolvedTarget === "ui" || resolvedTarget === "all";
  if (resolvedTarget === "both") {
    deprecationNotes.push(
      'target "both" is deprecated: use "all" to include UI, or list "features" / "data_model" / "ui" explicitly. "both" currently maps to features + data_model (excluding UI) for back-compat.',
    );
  }

  // Load UI registry only when needed. We hold the full file so we can save
  // it back with the wrapper metadata intact. Eligibility gate: only
  // scanner-origin elements with a non-empty source_repo are enrichment
  // candidates. Manual / SDK / user-guidance entries stay in the registry
  // untouched.
  const uiRegistry = await loadUiRegistry();
  const uiEntries: ParserNodeRecord[] = [];
  const uiIndexById = new Map<string, number>();
  uiRegistry?.elements.forEach((el, i) => {
    if (!el.source_repo) return;
    uiIndexById.set(el.id, i);
    uiEntries.push(uiElementToRecord(el));
  });

  interface TargetSlot {
    key: TargetFile;
    filename: string;
    entries: ParserNodeRecord[];
    /** When true, persist by re-wrapping into UIRegistryFile rather than as a top-level array. */
    wrapped: "array" | "ui" | "auxiliary";
  }

  const everyTarget: TargetSlot[] = [
    { key: "data_model", filename: "data_model.json", entries: allDataModel, wrapped: "array" },
    { key: "features", filename: "features.json", entries: allFeatures, wrapped: "array" },
    { key: "workflows", filename: "workflows.json", entries: allWorkflows, wrapped: "array" },
    { key: "capabilities", filename: "capabilities.json", entries: allCapabilities, wrapped: "array" },
    { key: "datastores", filename: "datastores.json", entries: allDatastores, wrapped: "array" },
    { key: "ui", filename: "ui_registry.json", entries: uiEntries, wrapped: "ui" },
    { key: "auxiliary", filename: "auxiliary_entities.json", entries: allAuxiliary, wrapped: "auxiliary" },
  ];
  const selected = resolvedTarget === "all"
    ? new Set<TargetFile>(everyTarget.map((target) => target.key))
    : resolvedTarget === "both"
      ? new Set<TargetFile>(["features", "data_model"])
      : new Set<TargetFile>([resolvedTarget]);
  const targets = everyTarget.filter((target) => selected.has(target.key) && (resolvedTarget !== "all" || target.entries.length > 0));
  const allNodes = everyTarget.flatMap((target) => target.entries);
  const scanBaseline = await loadScanState();
  const scanRevision = scanBaseline.state?.committed_revision ?? "legacy-unscoped";
  const providerFingerprint = [
    route.layer,
    route.provenance.provider ?? "none",
    route.model ?? "none",
    standaloneFallbackRoute?.provenance.provider ?? "none",
    standaloneFallbackRoute?.model ?? "none",
  ].join(":");
  const checkpointFile = dataPath("enrichment_state.json");
  const eligibleIds = targets.flatMap((target) =>
    target.entries.filter((entry) => entry.id && (opts.force || !isAlreadyEnriched(entry))).map((entry) => entry.id),
  );
  const loadedCheckpoint = opts.dryRun ? null : await loadEnrichmentRun(checkpointFile);
  let checkpoint: EnrichmentRunState = loadedCheckpoint &&
    loadedCheckpoint.scan_revision === scanRevision &&
    loadedCheckpoint.provider_fingerprint === providerFingerprint
      ? loadedCheckpoint
      : createEnrichmentRun(scanRevision, providerFingerprint, eligibleIds);
  const resumableIds = new Set(resumableNodeIds(checkpoint));
  if (!opts.dryRun && !loadedCheckpoint) await persistEnrichmentRun(checkpointFile, checkpoint);
  const semanticGraph = buildSemanticAdjacency(allNodes);
  const graphTypeById = new Map<string, GraphNodeType>(allNodes.map((node) => [node.id, node.graph_type ?? "capability"]));
  const sourceMtimeCache = new Map<string, Promise<number | null>>();
  const sourceExcerptCache = new Map<string, Promise<SourceEvidenceEntry | null>>();

  const result: EnrichResult = {
    target: resolvedTarget,
    dry_run: opts.dryRun,
    files_processed: [],
    total_eligible: 0,
    total_enriched: 0,
    total_skipped: 0,
    feature_anchors_written: 0,
    relations_written: 0,
    enriched_node_ids: [],
    enriched_node_ids_truncated: false,
    batches_run: 0,
    llm_calls: 0,
    tokens_used: 0,
    duration_ms: 0,
    errors: [],
    notes: [...deprecationNotes],
    ui_relation_gaps: [],
    semantic_coverage: {
      total_nodes: 0,
      llm_enriched: 0,
      fallback_nodes: 0,
      complete: false,
      context_hops: Math.max(2, opts.contextHops),
      model_source: opts.modelSource,
    },
    semantic_cache: {
      enabled: opts.semanticCache,
      nodes_served_from_cache: 0,
      cache_misses: 0,
      neighbor_entries_reused: 0,
      low_confidence_rejections: 0,
      conflicts_detected: 0,
      source_files_considered: 0,
      source_files_covered: 0,
      source_reads_avoided: 0,
      source_file_reads: 0,
      source_file_cache_hits: 0,
      prompt_source_reuses: 0,
      prompt_neighbor_reuses: 0,
    },
    targeted_dream_schedules: { created: 0, reused: 0, schedule_ids: [] },
    enrichment_checkpoint: {
      file: checkpointFile,
      run_id: checkpoint.run_id,
      scan_revision: checkpoint.scan_revision,
      provider_fingerprint: checkpoint.provider_fingerprint,
      remaining: resumableIds.size,
      complete: resumableIds.size === 0,
    },
  };

  if (route.layer === "deterministic_fallback") {
    result.notes.push(
      `ADR-203 route=deterministic_fallback reason=${route.provenance.fallback_reason ?? "unknown"}; using structural parser-node enrichment fallback.`,
    );
  } else {
    result.notes.push(`ADR-203 route=${route.layer} provider=${route.provenance.provider ?? "unknown"} model=${route.model ?? "unknown"}.`);
  }

  // Pre-build the set of valid feature ids — used to validate anchors so we
  // never write a link to a target that doesn't exist.
  const validFeatureIds = new Set<string>(
    allFeatures.filter((f) => typeof f.id === "string").map((f) => f.id),
  );
  const cleanForPersistence = (entry: ParserNodeRecord): ParserNodeRecord => {
    const { graph_type: _graphType, ...clean } = entry;
    return clean;
  };

  let nodesProcessed = 0;

  for (const t of targets) {
    result.files_processed.push(t.key);

    const eligible = t.entries.filter((e) =>
      e.id && (opts.force || !isAlreadyEnriched(e)) && (opts.dryRun || resumableIds.has(e.id)),
    );
    result.total_eligible += eligible.length;
    result.semantic_coverage.total_nodes += eligible.length;

    if (eligible.length === 0) {
      result.notes.push(`${t.filename}: no nodes require enrichment.`);
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
      for (const batch of chunk(bucketNodes, opts.batchSize)) {
        result.batches_run++;

        const contexts = new Map<string, ParserNodeRecord[]>();
        const relationTargets = new Map<string, GraphNodeType>();
        for (const node of batch) {
          const neighborhood = walkMultiHopContext(node, semanticGraph, opts.contextHops, opts.relationContextSize);
          contexts.set(node.id, neighborhood);
          for (const neighbor of neighborhood) relationTargets.set(neighbor.id, neighbor.graph_type ?? "capability");
        }
        const featureContext = [...new Map(
          [...contexts.values()].flat()
            .filter((node) => node.graph_type === "feature")
            .map((node) => [node.id, node]),
        ).values()].slice(0, opts.featureContextSize).map((feature) => ({
          id: feature.id,
          name: String(feature.name ?? feature.id),
          description: String(feature.description ?? "").slice(0, 400),
        }));
        const validAnchorIds = new Set<string>(featureContext.map((f) => f.id));
        // Allow anchors to any feature in the same repo even if not in the
        // context list — keeps the LLM from being penalised for picking a
        // legitimate cross-domain feature it has seen during scanning.
        for (const fid of validFeatureIds) if (relationTargets.has(fid)) validAnchorIds.add(fid);
        const cachePlans = new Map<string, SemanticCachePlan>();
        await Promise.all(batch.map(async (node) => {
          const neighborhood = contexts.get(node.id) ?? [];
          const considered = sourceFilesFor(node).slice(0, 3).map(normalizedSourceFile);
          const sourceModifiedAt = opts.semanticCache
            ? await sourceModifiedTimes(node, considered, sourceMtimeCache)
            : new Map<string, number>();
          const plan = buildSemanticCachePlan(node, neighborhood, {
            enabled: opts.semanticCache,
            minConfidence: opts.semanticCacheMinConfidence,
            minCoverage: opts.semanticCacheMinCoverage,
            sourceModifiedAt,
          });
          cachePlans.set(node.id, plan);
        }));

        for (const plan of cachePlans.values()) {
          result.semantic_cache.source_files_considered += plan.source_files_considered.length;
          result.semantic_cache.source_files_covered += plan.source_files_covered.length;
          result.semantic_cache.source_reads_avoided += Math.max(0, plan.source_files_considered.length - plan.source_files_to_read.length);
          result.semantic_cache.neighbor_entries_reused += plan.reused_neighbor_ids.length;
          result.semantic_cache.low_confidence_rejections += plan.low_confidence_neighbor_ids.length;
          result.semantic_cache.conflicts_detected += plan.conflicts.length;
          if (opts.semanticCache) {
            if (plan.sufficient) result.semantic_cache.nodes_served_from_cache++;
            else result.semantic_cache.cache_misses++;
          }
        }

        const sourceById = new Map<string, SourceEvidenceEntry[]>();
        await Promise.all(batch.map(async (node) => {
          const plan = cachePlans.get(node.id);
          const loaded = await loadSourceEvidence(
            node,
            plan?.source_files_to_read ?? sourceFilesFor(node).slice(0, 3),
            sourceExcerptCache,
            result.semantic_cache,
          );
          sourceById.set(node.id, loaded);
        }));
        const evidenceCatalog = new Map<string, SourceEvidenceEntry>();
        let sourceEvidenceReferences = 0;
        for (const evidence of sourceById.values()) {
          sourceEvidenceReferences += evidence.length;
          for (const entry of evidence) evidenceCatalog.set(entry.evidence_id, entry);
        }
        result.semantic_cache.prompt_source_reuses += Math.max(0, sourceEvidenceReferences - evidenceCatalog.size);

        const semanticNeighborhoodCatalog = new Map<string, ParserNodeRecord>();
        let semanticNeighborhoodReferences = 0;
        for (const node of batch) {
          const plan = cachePlans.get(node.id);
          const reused = new Set(plan?.reused_neighbor_ids ?? []);
          const referenced = [
            ...(plan?.cache_entries ?? []),
            ...(contexts.get(node.id) ?? []).filter((neighbor) => !reused.has(neighbor.id)),
          ];
          semanticNeighborhoodReferences += referenced.length;
          for (const neighbor of referenced) semanticNeighborhoodCatalog.set(neighbor.id, neighbor);
        }
        result.semantic_cache.prompt_neighbor_reuses += Math.max(
          0,
          semanticNeighborhoodReferences - semanticNeighborhoodCatalog.size,
        );

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
          `Semantic context depth: ${Math.max(2, opts.contextHops)} hops`,
          "Source evidence catalog (shared excerpts appear once and are referenced by evidence_id):",
          JSON.stringify([...evidenceCatalog.values()], null, 2),
          "",
          "Semantic neighborhood catalog (shared projected nodes appear once and are referenced by id):",
          JSON.stringify([...semanticNeighborhoodCatalog.values()].map(projectNodeForPrompt), null, 2),
          "",
          "Graph nodes to enrich and their grounded evidence:",
          JSON.stringify(batch.map((node) => ({
            node: projectNodeForPrompt(node),
            evidence_plan: (() => {
              const plan = cachePlans.get(node.id)!;
              return {
                policy: plan.sufficient
                  ? "reuse_semantic_cache"
                  : plan.source_files_covered.length > 0
                    ? "hybrid_cache_and_source"
                    : "source_backed",
                semantic_cache_coverage: plan.coverage,
                cache_confidence: plan.cache_confidence,
                source_files_considered: plan.source_files_considered,
                source_files_covered: plan.source_files_covered,
                source_files_to_read: plan.source_files_to_read,
                conflicts: plan.conflicts,
              };
            })(),
            source_evidence_refs: (sourceById.get(node.id) ?? []).map((entry) => entry.evidence_id),
            semantic_cache_entry_refs: (cachePlans.get(node.id)?.cache_entries ?? []).map((neighbor) => neighbor.id),
            unresolved_semantic_neighborhood_refs: (() => {
              const reused = new Set(cachePlans.get(node.id)?.reused_neighbor_ids ?? []);
              return (contexts.get(node.id) ?? []).filter((neighbor) => !reused.has(neighbor.id)).map((neighbor) => neighbor.id);
            })(),
          })), null, 2),
        ].join("\n");

        let parsed: PerNodeEnrichment[] = [];
        let modelUsed: string | undefined;
        let retryableFailureReason: string | undefined;
        const fallbackNodeIds = new Set<string>();

        if (route.layer === "deterministic_fallback") {
          parsed = batch.map(structuralEnrichmentFor);
          modelUsed = "deterministic_fallback";
          for (const node of batch) fallbackNodeIds.add(node.id);
        } else {
          const provider = route.provider ?? standaloneFallbackRoute?.provider;
          if (!provider) {
            parsed = batch.map(structuralEnrichmentFor);
            modelUsed = "deterministic_fallback";
            for (const node of batch) fallbackNodeIds.add(node.id);
            result.errors.push(`Batch (${bkey}, ${batch.length} nodes): provider_missing; deterministic fallback used.`);
            logger.warn(result.errors[result.errors.length - 1]);
          } else {
            try {
              let responseText = "";
              try {
                const messages: LlmMessage[] = [
                  { role: "system", content: SYSTEM_PROMPT },
                  { role: "user", content: userPrompt },
                ];
                const structuredOptions = {
                  ...route.options,
                  maxTokens: Math.min(route.options.maxTokens ?? 8192, 8192),
                  jsonMode: true,
                  jsonSchema: {
                    name: batch.some((node) => node.graph_type === "ui_element")
                      ? "dreamgraph_ui_enrichment_batch"
                      : "dreamgraph_node_enrichment_batch",
                    schema: enrichmentJsonSchema(batch),
                  },
                } satisfies LlmCompletionOptions;
                let resp: LlmResponse;
                try {
                  result.llm_calls++;
                  resp = await provider.complete(messages, structuredOptions);
                } catch (primaryError) {
                  const fallbackProvider = standaloneFallbackRoute?.layer !== "deterministic_fallback"
                    ? standaloneFallbackRoute?.provider
                    : null;
                  if (!fallbackProvider || fallbackProvider === provider) throw primaryError;
                  const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
                  result.errors.push(
                    `Batch (${bkey}, ${batch.length} nodes): Architect provider failed (${primaryMessage}); retrying with standalone provider.`,
                  );
                  logger.warn(result.errors[result.errors.length - 1]);
                  result.llm_calls++;
                  resp = await fallbackProvider.complete(messages, {
                    ...structuredOptions,
                    ...standaloneFallbackRoute?.options,
                    maxTokens: Math.min(standaloneFallbackRoute?.options.maxTokens ?? 8192, 8192),
                  });
                }
                result.tokens_used += resp.tokensUsed ?? 0;
                modelUsed = resp.model ?? route.model ?? standaloneFallbackRoute?.model ?? route.layer;
                responseText = resp.text;
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                throw new Error(`${llmRouteFailureReason("provider")}: ${msg}`);
              }

              try {
                parsed = parseLlmEnrichment(responseText);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                throw new Error(`${llmRouteFailureReason("invalid_output")}: ${msg}`);
              }

              const validationErrors = validateBatchEnrichments(parsed, batch, validAnchorIds, relationTargets);
              if (validationErrors.length > 0) {
                const candidates = new Map(parsed.map((candidate) => [candidate.id, candidate]));
                const salvaged: PerNodeEnrichment[] = [];
                for (const node of batch) {
                  const candidate = candidates.get(node.id);
                  const nodeErrors = validateBatchEnrichments(
                    candidate ? [candidate] : [],
                    [node],
                    validAnchorIds,
                    relationTargets,
                  );
                  if (candidate && nodeErrors.length === 0) {
                    salvaged.push(candidate);
                  } else {
                    fallbackNodeIds.add(node.id);
                    salvaged.push(structuralEnrichmentFor(node));
                  }
                }
                parsed = salvaged;
                result.errors.push(
                  `Batch (${bkey}, ${batch.length} nodes): ${llmRouteFailureReason("validation")}: ` +
                  `${fallbackNodeIds.size} node(s) used deterministic fallback; ${validationErrors.join("; ")}`,
                );
                logger.warn(result.errors[result.errors.length - 1]);
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              const classified = classifyEnrichmentFailure(err);
              if (classified.state === "failed_retryable") {
                retryableFailureReason = classified.reason;
                result.errors.push(`Batch (${bkey}, ${batch.length} nodes): ${msg}; checkpointed as retryable.`);
                parsed = [];
              } else {
                result.errors.push(`Batch (${bkey}, ${batch.length} nodes): ${msg}; deterministic fallback used.`);
                parsed = batch.map(structuralEnrichmentFor);
                modelUsed = "deterministic_fallback";
                for (const node of batch) fallbackNodeIds.add(node.id);
              }
              logger.warn(result.errors[result.errors.length - 1]);
            }
          }
        }

        // Match validated or deterministic-fallback results back to input nodes by id.
        const resultsById = new Map<string, PerNodeEnrichment>();
        for (const r of parsed) resultsById.set(r.id, r);

        const nowIso = new Date().toISOString();
        let batchEnriched = 0;
        let batchAnchors = 0;
        let batchRelations = 0;

        for (const node of batch) {
          const enrichment = resultsById.get(node.id);
          nodesProcessed++;
          if (!enrichment) {
            result.total_skipped++;
            result.errors.push(`Node ${node.id}: missing in enrichment response`);
            if (!opts.dryRun) checkpoint = recordEnrichmentOutcome(checkpoint, node.id, retryableFailureReason
              ? { state: "failed_retryable", reason: retryableFailureReason }
              : { state: "failed_terminal", reason: "missing_enrichment_response" });
            continue;
          }
          const { node: merged, anchorsAdded, relationsAdded } = mergeEnrichment(
            node,
            enrichment,
            validAnchorIds,
            fallbackNodeIds.has(node.id) ? "deterministic_fallback" : modelUsed,
            nowIso,
            relationTargets,
            {
              plan: cachePlans.get(node.id)!,
              sourceFilesRead: (sourceById.get(node.id) ?? []).map((entry) => entry.file),
              contextHops: opts.contextHops,
            },
          );
          if (node.graph_type === "ui_element" && enrichment.ui_knowledge) {
            merged.data_contract = {
              inputs: mergeNamedRecords(
                node.data_contract?.inputs,
                enrichment.ui_knowledge.data_contract.inputs,
                "name",
              ),
              outputs: mergeNamedRecords(
                node.data_contract?.outputs,
                enrichment.ui_knowledge.data_contract.outputs,
                "name",
              ),
            };
            merged.interactions = mergeNamedRecords(
              node.interactions,
              enrichment.ui_knowledge.interactions,
              "action",
            );
            merged.visual_semantics = enrichment.ui_knowledge.visual_semantics;
            merged.layout_semantics = enrichment.ui_knowledge.layout_semantics;
            merged.used_by = mergeUniqueIds(
              node.used_by,
              enrichment.ui_knowledge.used_by,
              (id) => graphTypeById.has(id),
            );
            merged.children = mergeUniqueIds(
              node.children,
              enrichment.ui_knowledge.children,
              (id) => graphTypeById.get(id) === "ui_element",
            );
            if (!fallbackNodeIds.has(node.id) && !uiHasEvidencedRelation(node, enrichment)) {
              result.ui_relation_gaps.push(node.id);
            }
          }
          const idx = indexById.get(node.id);
          if (idx !== undefined) t.entries[idx] = merged;
          // Make successful enrichments immediately reusable by later batches
          // in the same invocation, including the semantic links just learned.
          semanticGraph.byId.set(node.id, merged);
          for (const link of merged.links ?? []) {
            if (!semanticGraph.byId.has(link.target) || link.target === node.id) continue;
            const own = semanticGraph.adjacency.get(node.id) ?? new Set<string>();
            own.add(link.target);
            semanticGraph.adjacency.set(node.id, own);
            const reciprocal = semanticGraph.adjacency.get(link.target) ?? new Set<string>();
            reciprocal.add(node.id);
            semanticGraph.adjacency.set(link.target, reciprocal);
          }
          batchEnriched++;
          if (result.enriched_node_ids.length < 100) result.enriched_node_ids.push(node.id);
          else result.enriched_node_ids_truncated = true;
          batchAnchors += anchorsAdded;
          batchRelations += relationsAdded;
          if (fallbackNodeIds.has(node.id)) result.semantic_coverage.fallback_nodes++;
          else result.semantic_coverage.llm_enriched++;
          if (!opts.dryRun) checkpoint = recordEnrichmentOutcome(checkpoint, node.id, {
            state: "enriched",
            ...(fallbackNodeIds.has(node.id) ? { reason: "evidence_only_fallback" } : {}),
          });
        }

        result.total_enriched += batchEnriched;
        result.feature_anchors_written += batchAnchors;
        result.relations_written += batchRelations;
        logger.info(
          `Semantic enrichment batch ${result.batches_run}: ${batchEnriched}/${batch.length} persisted candidates, ` +
          `${fallbackNodeIds.size} fallback, ${result.semantic_coverage.llm_enriched}/${result.semantic_coverage.total_nodes} LLM-enriched overall`,
        );
        // Per-batch persistence: crash-safe — work done so far survives.
        if (!opts.dryRun && batchEnriched > 0) {
          try {
            if (t.wrapped === "ui") {
              // UI registry: merge enriched fields back into the wrapped file.
              if (!uiRegistry) throw new Error("ui_registry.json missing during write");
              for (const node of batch) {
                const idx = uiIndexById.get(node.id);
                if (idx === undefined) continue;
                const updated = t.entries[indexById.get(node.id) ?? -1];
                if (!updated) continue;
                const el = uiRegistry.elements[idx];
                el.description = updated.description;
                el.tags = Array.isArray(updated.tags) ? [...updated.tags] : el.tags;
                if (typeof updated.intent === "string" && updated.intent.length > 0) el.intent = updated.intent;
                if (typeof updated.description_raw === "string") el.description_raw = updated.description_raw;
                if (updated.enrichment) el.enrichment = updated.enrichment;
                if (Array.isArray(updated.links)) {
                  el.links = (updated.links as GraphLink[]).map((l) => ({ ...l }));
                }
                if (updated.data_contract) el.data_contract = updated.data_contract;
                if (updated.interactions) el.interactions = updated.interactions;
                if (updated.visual_semantics) el.visual_semantics = updated.visual_semantics;
                if (updated.layout_semantics) el.layout_semantics = updated.layout_semantics;
                if (updated.used_by) el.used_by = updated.used_by;
                if (updated.children) el.children = updated.children;
              }
              await saveUiRegistry(uiRegistry);
            } else if (t.wrapped === "auxiliary") {
              const wrapped: AuxiliaryEntitiesFile = {
                metadata: { ...auxiliaryFile.metadata, total: t.entries.length, last_scanned: new Date().toISOString() },
                entries: t.entries.map(cleanForPersistence) as unknown as AuxiliaryEntitiesFile["entries"],
              };
              await atomicWriteFile(dataPath(t.filename), JSON.stringify(wrapped, null, 2));
              invalidateCache(t.filename);
            } else {
              await atomicWriteFile(dataPath(t.filename), JSON.stringify(t.entries.map(cleanForPersistence), null, 2));
              invalidateCache(t.filename);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            result.errors.push(`Persist ${t.filename}: ${msg}`);
          }
        }
        if (!opts.dryRun) await persistEnrichmentRun(checkpointFile, checkpoint);
        opts.onProgress?.(
          `Semantic enrichment batch ${result.batches_run}: ${batchEnriched}/${batch.length} persisted, ` +
          `${fallbackNodeIds.size} fallback`,
          result.batches_run,
        );

        if (nodesProcessed >= opts.maxNodes) break;
      }
      if (nodesProcessed >= opts.maxNodes) break;
    }
  }

  result.duration_ms = Date.now() - started;
  const remainingCheckpointIds = resumableNodeIds(checkpoint);
  result.enrichment_checkpoint.remaining = remainingCheckpointIds.length;
  result.enrichment_checkpoint.complete = remainingCheckpointIds.length === 0;
  if (!opts.dryRun) await persistEnrichmentRun(checkpointFile, checkpoint);
  if (result.ui_relation_gaps.length > 0) {
    result.notes.push(
      `${result.ui_relation_gaps.length} richly enriched UI node(s) still lack an evidenced relation; ` +
      "their semantic metadata was preserved and they remain candidates for targeted relation discovery.",
    );
  }
  result.semantic_coverage.complete =
    result.semantic_coverage.total_nodes === result.semantic_coverage.llm_enriched &&
    result.semantic_coverage.fallback_nodes === 0 &&
    result.total_skipped === 0;
  if (!opts.dryRun && result.semantic_coverage.llm_enriched > 0) {
    await updateGraphMaintenanceState({ last_enrichment_at: new Date().toISOString() }).catch((err) => {
      result.errors.push(`Graph maintenance timestamp: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
  const majorGraphChangeThreshold = Math.max(1, Number(process.env.DREAMGRAPH_MAJOR_GRAPH_CHANGE_NODES) || 20);
  if (!opts.dryRun && opts.scheduleStabilization && result.total_enriched >= majorGraphChangeThreshold && result.enriched_node_ids.length > 0) {
    try {
      const stabilization = await scheduleTargetedDreamStabilization({
        entity_ids: result.enriched_node_ids,
        reason: `Major semantic enrichment refreshed ${result.total_enriched} canonical graph nodes`,
      });
      result.targeted_dream_schedules = {
        created: stabilization.scheduled.length,
        reused: stabilization.reused.length,
        schedule_ids: [...stabilization.scheduled, ...stabilization.reused].map((schedule) => schedule.id),
      };
    } catch (err) {
      result.errors.push(`Targeted dream scheduling: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  result.adaptive_future_audit = buildAdaptiveFutureAuditTrail({
    task_class: "graph_tool_change",
    selected_candidate_id: `enrich_parser_nodes:${resolvedTarget}:semantic_enrichment`,
    route: route.layer === "deterministic_fallback" ? "deterministic" : "llm",
    fallback: route.layer === "deterministic_fallback" || result.errors.length > 0 ? "deterministic_fallback" : "none",
    candidates: [
      {
        id: `enrich_parser_nodes:${resolvedTarget}:semantic_enrichment`,
        task_class: "graph_tool_change",
        selected: true,
        score_factors: {
          adr_alignment: 0.85,
          workflow_fit: result.total_eligible === 0 ? 0.5 : 0.8,
          verification_path: 0.75,
          graph_sync_impact: !result.dry_run && result.total_enriched > 0 ? 0.9 : 0.4,
          blast_radius: result.total_eligible > 50 ? 0.7 : 0.4,
          evidence_strength: result.total_eligible === 0 ? 0.4 : result.total_enriched / Math.max(result.total_eligible, 1),
        },
        anchors: result.files_processed.map((file) => ({
          kind: file === "features" ? "feature" as const : "data_model" as const,
          id: `enrich_parser_nodes:${file}`,
          source_file: `${file}.json`,
        })),
        objections: result.errors,
        validation_failures: result.errors,
      },
    ],
    notes: result.notes,
  });

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
  const threshold = (explicit: number | undefined, envName: string, fallback: number): number => {
    const fromEnvironment = Number(process.env[envName]);
    const candidate = explicit ?? (Number.isFinite(fromEnvironment) ? fromEnvironment : fallback);
    return Math.max(0, Math.min(1, Number.isFinite(candidate) ? candidate : fallback));
  };
  const merged: EnrichOptions = {
    target: opts.target ?? "all",
    maxNodes: opts.maxNodes ?? Number.MAX_SAFE_INTEGER,
    batchSize: opts.batchSize ?? 10,
    dryRun: opts.dryRun ?? false,
    force: opts.force ?? false,
    featureContextSize: opts.featureContextSize ?? 20,
    contextHops: Math.max(2, opts.contextHops ?? 3),
    relationContextSize: opts.relationContextSize ?? 40,
    modelSource: opts.modelSource ?? "auto",
    scheduleStabilization: opts.scheduleStabilization ?? true,
    semanticCache: opts.semanticCache ?? true,
    semanticCacheMinConfidence: threshold(
      opts.semanticCacheMinConfidence,
      "DREAMGRAPH_SEMANTIC_CACHE_MIN_CONFIDENCE",
      0.72,
    ),
    semanticCacheMinCoverage: threshold(
      opts.semanticCacheMinCoverage,
      "DREAMGRAPH_SEMANTIC_CACHE_MIN_COVERAGE",
      0.75,
    ),
    onProgress: opts.onProgress,
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
    "Graph-wide batch enrichment for every canonical node. It uses the configured standalone " +
      "LLM or Architect model/adapter, confidence-aware semantic cache entries from enriched neighbors, " +
      "selective source excerpts for uncovered or stale evidence, and at least two semantic graph hops " +
      "to write rich descriptions, intent, UI contracts and layout, and evidenced relations. " +
      "Targets include data_model, features, workflows, capabilities, UI, datastores, auxiliary, all, or " +
      "the deprecated 'both' (= features + data_model, no UI). Uses internal " +
      "batching (default 10 nodes per LLM call) and persists after each batch " +
      "for crash safety. Every non-enriched graph node is eligible, or every node when force " +
      "is true. Source-bound UI elements retain their role tag while description, intent, " +
      "contract, interaction, appearance, layout, and semantic links are refreshed. " +
      "Proposed relations are written as weak " +
      "GraphLinks on the entity \u2014 they do not bypass the dream/normalize edge " +
      "promotion pipeline.",
    {
      target: z
        .enum(["data_model", "features", "workflows", "capabilities", "ui", "datastores", "auxiliary", "both", "all"])
        .default("all")
        .describe(
          'Which target(s) to enrich. "all" covers every canonical graph store; "ui" enriches source-bound UI registry entries. "both" is deprecated and maps to features + data_model for one compatibility cycle.',
        ),
      max_nodes: z
        .number()
        .int()
        .min(1)
        .max(1_000_000)
        .default(1_000_000)
        .describe("Hard cap on nodes processed per invocation across all graph stores."),
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
      context_hops: z.number().int().min(2).max(6).default(3)
        .describe("How many semantic graph hops to traverse for every node (minimum 2)."),
      relation_context_size: z.number().int().min(5).max(100).default(40)
        .describe("Maximum related nodes supplied as semantic context for each node."),
      model_source: z.enum(["auto", "standalone", "architect"]).default("auto")
        .describe("Use standalone LLM configuration, Architect LLM configuration, or automatically choose an available route."),
      semantic_cache: z.boolean().default(true)
        .describe("Reuse sufficiently complete, confident, and fresh enriched neighbors as semantic evidence."),
      semantic_cache_min_confidence: z.number().min(0).max(1).default(0.72)
        .describe("Minimum completeness-adjusted confidence required before a rich neighbor can serve as semantic cache evidence."),
      semantic_cache_min_coverage: z.number().min(0).max(1).default(0.75)
        .describe("Minimum source/relationship coverage required to omit source reads for a node."),
    },
    async ({
      target,
      max_nodes,
      batch_size,
      dry_run,
      force,
      feature_context_size,
      context_hops,
      relation_context_size,
      model_source,
      semantic_cache,
      semantic_cache_min_confidence,
      semantic_cache_min_coverage,
    }, extra) => {
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
            contextHops: context_hops,
            relationContextSize: relation_context_size,
            modelSource: model_source,
            scheduleStabilization: true,
            semanticCache: semantic_cache,
            semanticCacheMinConfidence: semantic_cache_min_confidence,
            semanticCacheMinCoverage: semantic_cache_min_coverage,
            onProgress: (message, batch) => {
              extra.sendNotification({
                method: "notifications/progress" as const,
                params: {
                  progressToken: (extra._meta as Record<string, unknown>)?.progressToken as string | number ?? "enrich",
                  progress: batch,
                  message,
                },
              }).catch(() => {});
            },
          }),
        "enrich_parser_nodes",
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(res, null, 2) }],
      };
    },
  );
}
