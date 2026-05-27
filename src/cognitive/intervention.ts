/**
 * DreamGraph Intervention Engine — From Insight to Action
 *
 * Bridges the gap from "awareness" to "remedy" by generating
 * concrete remediation plans from high-urgency validated tensions.
 *
 * Each plan contains:
 *   - Ordered steps (what to change, where)
 *   - File-level change descriptions
 *   - Test suggestions
 *   - Effort estimates
 *   - ADR conflict checks
 *   - Predicted new tensions the change may create
 *
 * Philosophy: DreamGraph should not only SEE problems — it should
 * propose the first credible fix, so the developer can say "yes" or "refine".
 *
 * READ-ONLY: generates plans from data, writes nothing.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dataPath } from "../utils/paths.js";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { withFileLock } from "../utils/mutex.js";
import { loadJsonArray } from "../utils/cache.js";
import { engine } from "./engine.js";
import { logger } from "../utils/logger.js";
import { llmRouteFailureReason, selectLlmRoute, type LlmMessage } from "./llm.js";
import type { DataModelEntity } from "../types/index.js";
import type {
  TensionSignal,
  TensionResolutionCandidate,
  TensionResolutionStrategy,
  RemediationStep,
  RemediationPlan,
  RemediationPlanOutput,
  RemediationLogFile,
  RemediationInterventionType,
  RemediationEvidenceBundle,
  GeneratedRemediationPlanSet,
  CandidateFuture,
  FutureSignal,
  RemediationPlanOutcome,
  RemediationResolutionCall,
  RemediationEnrichmentAction,
  FileChange,
  DreamEdge,
} from "./types.js";

// ---------------------------------------------------------------------------
// File constants
// ---------------------------------------------------------------------------

const REMEDIATION_LOG_FILENAME = "remediation_log.json";
export const MAX_REMEDIATION_FUTURE_SIGNALS = 200;
export const MAX_REMEDIATION_FUTURE_OUTCOMES = 200;
export const MAX_REMEDIATION_CANDIDATE_RUNS = 100;
const SCHEMA_VERSION = "1.0";
const FUTURE_SIGNAL_STALE_WINDOW_MS = 1000 * 60 * 60 * 24 * 30;
const ADR_ANCHOR_PATTERN = /^ADR-\d+$/;
const NEGATIVE_FUTURE_SIGNAL_SOURCES = new Set<FutureSignal["source"]>(["rejected", "overridden", "reverted", "drift"]);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizeText(value: unknown): string {
  if (typeof value === "string") {
    return value.toLowerCase();
  }

  if (value == null) {
    return "";
  }

  try {
    return JSON.stringify(value).toLowerCase();
  } catch {
    return String(value).toLowerCase();
  }
}

interface AdrSummary {
  id: string;
  title: string;
  status: string;
  affected_entities: string[];
  tags: string[];
  guard_rails: string[];
}

function normalizeAdrEntry(entry: unknown): AdrSummary {
  if (!entry || typeof entry !== "object") {
    return {
      id: "unknown",
      title: "Unknown ADR",
      status: "unknown",
      affected_entities: [],
      tags: [],
      guard_rails: [],
    };
  }
  const c = entry as Record<string, unknown>;
  const ctx = (c.context && typeof c.context === "object") ? c.context as Record<string, unknown> : {};
  const affected = Array.isArray(ctx.affected_entities) ? ctx.affected_entities.filter((x): x is string => typeof x === "string") : [];
  const tags = Array.isArray(c.tags) ? c.tags.filter((x): x is string => typeof x === "string") : [];
  const rails = Array.isArray(c.guard_rails) ? c.guard_rails.filter((x): x is string => typeof x === "string") : [];
  return {
    id: typeof c.id === "string" ? c.id : "unknown",
    title: typeof c.title === "string" ? c.title : "Unknown ADR",
    status: typeof c.status === "string" ? c.status : "unknown",
    affected_entities: affected,
    tags,
    guard_rails: rails,
  };
}

/**
 * Load ADR log entries with their `affected_entities` and `tags`.
 * Used by `findAdrConflicts()` for entity-overlap matching.
 */
async function loadAdrLog(): Promise<AdrSummary[]> {
  try {
    const p = dataPath("adr_log.json");
    if (!existsSync(p)) return [];
    const raw = await readFile(p, "utf-8");
    const data = JSON.parse(raw);
    const entries = data?.decisions ?? data?.adrs ?? data?.entries ?? [];
    if (!Array.isArray(entries)) return [];
    return entries
      .map((entry: unknown) => normalizeAdrEntry(entry))
      .filter((adr) => adr.status !== "deprecated" && adr.status !== "superseded");
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Data-model entity resolution (replaces the old `inferFilePath` heuristic)
// ---------------------------------------------------------------------------

interface EntitySummary {
  id: string;
  exists: boolean;
  source_files: string[];
  relationships: Array<{ type: string; target: string; via: string }>;
  links: Array<{ target: string; type?: string; relationship?: string; description?: string; strength?: string }>;
  domain: string;
}

/** Build a lookup of entity_id → known facts from data_model.json. */
async function loadDataModelMap(): Promise<Map<string, EntitySummary>> {
  const map = new Map<string, EntitySummary>();
  try {
    const entries = await loadJsonArray<DataModelEntity>("data_model.json");
    for (const e of entries) {
      const id = (e as { id?: unknown }).id;
      if (typeof id !== "string" || !id) continue;
      map.set(id, {
        id,
        exists: true,
        source_files: Array.isArray(e.source_files) ? e.source_files.filter((x): x is string => typeof x === "string") : [],
        relationships: Array.isArray(e.relationships) ? e.relationships : [],
        links: Array.isArray(e.links) ? (e.links as EntitySummary["links"]) : [],
        domain: typeof e.domain === "string" ? e.domain : "unknown",
      });
    }
  } catch (err) {
    logger.warn(`loadDataModelMap: could not read data_model.json — phantom-entity detection disabled (${(err as Error).message})`);
  }
  return map;
}

function lookupEntity(id: string, map: Map<string, EntitySummary>): EntitySummary {
  return map.get(id) ?? { id, exists: false, source_files: [], relationships: [], links: [], domain: "unknown" };
}

/**
 * Resolve real source files for a tension's participating entities.
 * Returns one FileChange per entity that has at least one mapped source file.
 * Entities without mapped files are reported separately so the caller can
 * decide between `graph_enrichment` and `wont_fix`.
 */
function resolveFileChangesForEntities(
  entities: string[],
  map: Map<string, EntitySummary>,
  rationale: string,
  description: (entity: string, file: string) => string
): { resolved: FileChange[]; missing: string[]; phantom: string[] } {
  const resolved: FileChange[] = [];
  const missing: string[] = [];
  const phantom: string[] = [];
  for (const entity of entities) {
    const info = lookupEntity(entity, map);
    if (!info.exists) {
      phantom.push(entity);
      continue;
    }
    if (info.source_files.length === 0) {
      missing.push(entity);
      continue;
    }
    for (const file of info.source_files) {
      resolved.push({
        file_path: file,
        description: description(entity, file),
        change_type: "modify",
        rationale,
      });
    }
  }
  return { resolved, missing, phantom };
}

// ---------------------------------------------------------------------------
// Recently-rejected dream lookup (gives `weak_connection` plans real content)
// ---------------------------------------------------------------------------

function findRecentRejectedDream(
  tension: TensionSignal,
  edges: DreamEdge[]
): DreamEdge | undefined {
  if (tension.entities.length < 2) return undefined;
  const [a, b] = tension.entities;
  // Try latent edges first (still in dream graph), most recent dream cycle first.
  const sorted = [...edges].sort((x, y) => y.dream_cycle - x.dream_cycle);
  return sorted.find((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a));
}

// ---------------------------------------------------------------------------
// Persistence: data/remediation_log.json
// ---------------------------------------------------------------------------

async function loadRemediationLog(): Promise<RemediationLogFile> {
  const empty: RemediationLogFile = {
    metadata: {
      description: "DreamGraph remediation plans — current per tension + history of superseded plans",
      schema_version: SCHEMA_VERSION,
      last_updated: null,
    },
    current: {},
    history: [],
  };
  try {
    const p = dataPath(REMEDIATION_LOG_FILENAME);
    if (!existsSync(p)) return empty;
    const raw = await readFile(p, "utf-8");
    const parsed = JSON.parse(raw) as Partial<RemediationLogFile>;
    return {
      metadata: { ...empty.metadata, ...(parsed.metadata ?? {}) },
      current: (parsed.current && typeof parsed.current === "object") ? parsed.current as Record<string, RemediationPlan> : {},
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  } catch (err) {
    logger.warn(`loadRemediationLog: could not read ${REMEDIATION_LOG_FILENAME} — starting fresh (${(err as Error).message})`);
    return empty;
  }
}

async function persistRemediationPlans(
  plans: RemediationPlan[],
  outcomes: RemediationPlanOutcome[] = [],
  candidateRuns: Array<{
    evidence_bundle_id: string;
    selected_candidate_id?: string;
    selected_source?: "llm" | "heuristic" | "fallback";
    rejected_candidate_ids: string[];
    model_layer: GeneratedRemediationPlanSet["model_layer"];
    fallback_reason?: string;
    fallback_used?: boolean;
    validation_failures: string[];
    future_fit_score?: number;
    objection_count: number;
    future_signal_ids: string[];
    recorded_at: string;
  }> = [],
  futureSignals: FutureSignal[] = []
): Promise<void> {
  if (plans.length === 0 && outcomes.length === 0 && candidateRuns.length === 0 && futureSignals.length === 0) return;
  await withFileLock(REMEDIATION_LOG_FILENAME, async () => {
    const log = await loadRemediationLog();
    const now = new Date().toISOString();
    for (const plan of plans) {
      const prior = log.current[plan.tension_id];
      if (prior) {
        prior.superseded_by = plan.id;
        plan.supersedes = prior.id;
        log.history.push(prior);
      }
      log.current[plan.tension_id] = plan;
    }

    const adaptiveFuture = log.adaptive_future ?? {
      signals: [],
      outcomes: [],
      candidate_runs: [],
      metrics: {
        total_runs: 0,
        total_outcomes: 0,
        total_candidate_runs: 0,
        total_signals: 0,
        llm_selected_runs: 0,
        deterministic_fallback_runs: 0,
        average_future_fit_score: null,
        last_recorded_at: null,
      },
    };

    const signalIndexes = new Map(adaptiveFuture.signals.map((signal, index) => [signal.id, index] as const));
    for (const signal of futureSignals) {
      const existingIndex = signalIndexes.get(signal.id);
      if (existingIndex == null) {
        adaptiveFuture.signals.push(signal);
        signalIndexes.set(signal.id, adaptiveFuture.signals.length - 1);
        continue;
      }
      adaptiveFuture.signals[existingIndex] = {
        ...adaptiveFuture.signals[existingIndex],
        ...signal,
      };
    }
    adaptiveFuture.outcomes.push(...outcomes);
    adaptiveFuture.candidate_runs.push(...candidateRuns);

    adaptiveFuture.signals = adaptiveFuture.signals.slice(-200);
    adaptiveFuture.outcomes = adaptiveFuture.outcomes.slice(-200);
    adaptiveFuture.candidate_runs = adaptiveFuture.candidate_runs.slice(-200);

    const scoredRuns = adaptiveFuture.candidate_runs.filter((run) => typeof run.future_fit_score === "number");
    const scoreSum = scoredRuns.reduce((sum, run) => sum + (run.future_fit_score ?? 0), 0);
    adaptiveFuture.metrics = {
      total_runs: adaptiveFuture.metrics.total_runs + 1,
      total_outcomes: adaptiveFuture.outcomes.length,
      total_candidate_runs: adaptiveFuture.candidate_runs.length,
      total_signals: adaptiveFuture.signals.length,
      llm_selected_runs: adaptiveFuture.candidate_runs.filter((run) => run.model_layer !== "deterministic_fallback" && run.selected_candidate_id).length,
      deterministic_fallback_runs: adaptiveFuture.candidate_runs.filter((run) => run.model_layer === "deterministic_fallback").length,
      average_future_fit_score: scoredRuns.length === 0 ? null : Number((scoreSum / scoredRuns.length).toFixed(3)),
      last_recorded_at: now,
    };
    log.adaptive_future = adaptiveFuture;
    log.metadata.last_updated = now;
    log.metadata.schema_version = SCHEMA_VERSION;
    await atomicWriteFile(dataPath(REMEDIATION_LOG_FILENAME), JSON.stringify(log, null, 2), "utf-8");
  });
}

interface PlanContext {
  dataModel: Map<string, EntitySummary>;
  recentDreams: DreamEdge[];
}

interface DraftPlan {
  approach: string;
  intervention_type: RemediationInterventionType;
  steps: RemediationStep[];
  /** Pre-built `resolve_tension` invocation. Populated by `withResolutionCall`. */
  resolution: RemediationResolutionCall;
}

const ALLOWED_REMEDIATION_ACTION_CLASSES: RemediationInterventionType[] = [
  "source_change",
  "graph_enrichment",
  "wont_fix",
  "merge",
  "rescan",
];

function entityEvidenceSummary(entity: string, ctx: PlanContext): RemediationEvidenceBundle["entity_summaries"][number] {
  const summary = lookupEntity(entity, ctx.dataModel);
  return {
    id: entity,
    exists: summary.exists,
    source_files: summary.source_files,
    domain: summary.domain,
  };
}

function deterministicShortCircuitForTension(
  tension: TensionSignal,
  ctx: PlanContext
): RemediationEvidenceBundle["deterministic_short_circuit"] {
  if (tension.entities.some((entity) => !ctx.dataModel.has(entity))) {
    return "phantom_entity";
  }

  if (tension.entities.length === 2) {
    const [aId, bId] = tension.entities;
    const a = ctx.dataModel.get(aId);
    const b = ctx.dataModel.get(bId);
    if (a && b && !entitiesAlreadyConnected(a, b)) {
      return "graph_enrichment";
    }
  }

  return "none";
}

/**
 * Build the deterministic evidence envelope used by remediation drafting.
 * This is the engine-owned boundary: later LLM slices may compress or rank this
 * evidence, but they may not invent anchors outside this bundle.
 */
function buildRemediationEvidenceBundle(
  tension: TensionSignal,
  adrs: AdrSummary[],
  ctx: PlanContext
): RemediationEvidenceBundle {
  const entitySummaries = tension.entities.map((entity) => entityEvidenceSummary(entity, ctx));
  const entityAnchors = entitySummaries.map((entity) => ({
    kind: "graph_entity" as const,
    id: entity.id,
    summary: entity.exists
      ? `data_model entity with ${entity.source_files.length} source file binding(s)`
      : "entity absent from data_model.json",
  }));

  const adrGuardRails = adrs
    .filter((adr) => adr.status === "accepted" && adr.affected_entities.some((entity) => tension.entities.includes(entity)))
    .map((adr) => ({
      adr_id: adr.id,
      title: adr.title,
      guard_rails: adr.guard_rails,
    }));

  return {
    id: `remediation_evidence_${tension.id}`,
    tension_id: tension.id,
    tension_type: tension.type,
    urgency: tension.urgency,
    description: tension.description,
    entities: tension.entities,
    evidence_anchors: [
      {
        kind: "task",
        id: `tension:${tension.id}`,
        summary: tension.description,
      },
      ...entityAnchors,
      ...adrGuardRails.map((adr) => ({
        kind: "adr" as const,
        id: adr.adr_id,
        summary: adr.title,
      })),
      ...entitySummaries.flatMap((entity) => entity.source_files.map((file) => ({
        kind: "source_anchor" as const,
        id: file,
        summary: `source binding for ${entity.id}`,
      }))),
    ],
    entity_summaries: entitySummaries,
    adr_guard_rails: adrGuardRails,
    allowed_action_classes: ALLOWED_REMEDIATION_ACTION_CLASSES,
    deterministic_short_circuit: deterministicShortCircuitForTension(tension, ctx),
    verification_obligations: [
      {
        id: `verify_${tension.id}`,
        description: "Run the narrowest available verification for the files or graph entries changed by the remediation.",
        evidence_anchor_ids: [`tension:${tension.id}`, ...tension.entities],
      },
    ],
  };
}

function attachAdaptiveFutureMemory(
  bundle: RemediationEvidenceBundle,
  remediationLog: RemediationLogFile
): RemediationEvidenceBundle {
  const persistedSignals = remediationLog.adaptive_future?.signals ?? [];
  if (persistedSignals.length === 0) return bundle;

  const knownAnchorIds = new Set(bundle.evidence_anchors.map((anchor) => anchor.id));
  const knownAdrAnchorIds = new Set(bundle.adr_guard_rails.map((adr) => adr.adr_id));
  const priorFutureSignals = persistedSignals
    .filter((signal) => signal.evidence_anchor_ids.some((anchorId) => knownAnchorIds.has(anchorId) || knownAdrAnchorIds.has(anchorId)))
    .slice(-MAX_REMEDIATION_FUTURE_SIGNALS);

  return priorFutureSignals.length === 0
    ? bundle
    : { ...bundle, prior_future_signals: priorFutureSignals };
}

/**
 * Build a remediation strategy for a tension. The planner makes three
 * decisions in order:
 *
 * 1. **Phantom check** — any participant entity missing from
 *    `data_model.json` ⇒ `wont_fix` plan.
 * 2. **Graph-only check** — both entities exist but neither references
 *    the other in `relationships` / `links` ⇒ `graph_enrichment` plan
 *    with a pre-built `enrich_seed_data` payload.
 * 3. **Source change** — fall through to per-type remediation that
 *    resolves real `source_files` from the data model.
 */
function strategyForTension(tension: TensionSignal, ctx: PlanContext): DraftPlan {
  const entities = tension.entities;

  const phantomDraft = phantomEntityShortCircuit(tension, entities, ctx.dataModel);
  if (phantomDraft) return phantomDraft;

  const graphDraft = graphEnrichmentShortCircuit(tension, entities, ctx);
  if (graphDraft) return graphDraft;

  switch (tension.type) {
    case "missing_link":
      return missingLinkRemediation(tension, entities, ctx);
    case "weak_connection":
      return weakConnectionRemediation(tension, entities, ctx);
    case "hard_query":
      return hardQueryRemediation(tension, entities, ctx);
    case "ungrounded_dream":
      return ungroundedDreamRemediation(tension, entities, ctx);
    case "code_insight":
      return codeInsightRemediation(tension, entities, ctx);
    default:
      return genericRemediation(tension, entities, ctx);
  }
}

// ---------------------------------------------------------------------------
// Short-circuit strategies (run before per-type strategies)
// ---------------------------------------------------------------------------

function phantomEntityShortCircuit(
  t: TensionSignal,
  entities: string[],
  map: Map<string, EntitySummary>
): DraftPlan | null {
  const phantoms = entities.filter((e) => !map.has(e));
  if (phantoms.length === 0) return null;
  const evidence =
    `Target entit${phantoms.length === 1 ? "y" : "ies"} ` +
    `[${phantoms.join(", ")}] not present in data_model.json. ` +
    `These appear to be dream-only abstractions; no source-level fix is possible.`;
  return {
    approach: `wont_fix: phantom target${phantoms.length === 1 ? "" : "s"} ${phantoms.join(", ")}`,
    intervention_type: "wont_fix",
    steps: [
      {
        order: 1,
        description: evidence,
        files: [],
        tests_to_add: [],
        estimated_effort: "trivial",
        action: {
          tool: "resolve_tension",
          tension_id: t.id,
          resolved_by: "system",
          resolution_type: "wont_fix",
          evidence,
        },
      },
    ],
    resolution: {
      tool: "resolve_tension",
      tension_id: t.id,
      resolved_by: "system",
      resolution_type: "wont_fix",
      evidence,
    },
  };
}

function entitiesAlreadyConnected(a: EntitySummary, b: EntitySummary): boolean {
  const aRefsB =
    a.relationships.some((r) => r.target === b.id) ||
    a.links.some((l) => l.target === b.id);
  const bRefsA =
    b.relationships.some((r) => r.target === a.id) ||
    b.links.some((l) => l.target === a.id);
  return aRefsB || bRefsA;
}

function graphEnrichmentShortCircuit(
  t: TensionSignal,
  entities: string[],
  ctx: PlanContext
): DraftPlan | null {
  // Only meaningful for binary tensions (the dominant case).
  if (entities.length !== 2) return null;
  const [aId, bId] = entities;
  const a = ctx.dataModel.get(aId);
  const b = ctx.dataModel.get(bId);
  if (!a || !b) return null;
  if (entitiesAlreadyConnected(a, b)) return null;

  const rejected = findRecentRejectedDream(t, ctx.recentDreams);
  const relation = rejected?.relation ?? "related_to";
  const reason =
    rejected?.reason ??
    `The dreamer keeps proposing a "${relation}" connection (occurrences=${t.occurrences}).`;

  const enrichment: RemediationEnrichmentAction = {
    tool: "enrich_seed_data",
    target: "data_model",
    mode: "merge",
    entries: [
      {
        id: a.id,
        name: a.id,
        relationships: [{ target: b.id, type: relation, via: a.source_files[0] ?? "" }],
        links: [
          {
            target: b.id,
            type: "data_model",
            relationship: relation,
            description: reason,
            strength: "strong",
          },
        ],
      },
      {
        id: b.id,
        name: b.id,
        relationships: [{ target: a.id, type: `inverse_of(${relation})`, via: b.source_files[0] ?? "" }],
      },
    ],
  };

  const evidence =
    `Enriched data_model.json with explicit ${a.id} \u2194 ${b.id} relationship. ` +
    `Closes the recurring "${relation}" rejection.`;

  return {
    approach: `graph_enrichment: link ${a.id} \u2194 ${b.id} in data_model.json`,
    intervention_type: "graph_enrichment",
    steps: [
      {
        order: 1,
        description:
          `Both entities exist in data_model.json but neither lists the other in ` +
          `relationships/links. Add the explicit edge so the dreamer stops re-proposing it.`,
        files: [
          {
            file_path: "data/data_model.json",
            description: `Merge relationships into ${a.id} and ${b.id}`,
            change_type: "modify",
            rationale: reason,
          },
        ],
        tests_to_add: [],
        estimated_effort: "trivial",
        action: enrichment,
      },
      {
        order: 2,
        description:
          `Run a tension-directed dream cycle so the engine ingests the new edge.`,
        files: [],
        tests_to_add: [],
        estimated_effort: "trivial",
      },
    ],
    resolution: {
      tool: "resolve_tension",
      tension_id: t.id,
      resolved_by: "system",
      resolution_type: "confirmed_fixed",
      evidence,
    },
  };
}

// ---------------------------------------------------------------------------
// Per-type remediation strategies (use REAL source files from data_model.json)
// ---------------------------------------------------------------------------

function defaultResolutionCall(t: TensionSignal): RemediationResolutionCall {
  return {
    tool: "resolve_tension",
    tension_id: t.id,
    resolved_by: "human",
    resolution_type: "confirmed_fixed",
    evidence: `Apply the steps above, then close the tension.`,
  };
}

function missingLinkRemediation(
  t: TensionSignal,
  entities: string[],
  ctx: PlanContext
): DraftPlan {
  const { resolved, missing } = resolveFileChangesForEntities(
    entities,
    ctx.dataModel,
    `Add missing link between ${entities.join(" \u2194 ")}`,
    (e, f) => `Review ${e} (${f}) for the integration point with ${entities.filter((x) => x !== e).join(", ")}`
  );

  const steps: RemediationStep[] = [
    {
      order: 1,
      description: `Analyze why "${entities.join('" and "')}" lack a connection \u2014 is this intentional isolation or an oversight?`,
      files: resolved,
      tests_to_add: resolved.length > 0 ? [`test_${sanitize(entities.join("_"))}_integration`] : [],
      estimated_effort: "small",
    },
  ];

  if (missing.length > 0) {
    steps.push({
      order: 2,
      description:
        `Entities [${missing.join(", ")}] exist in the data model but have no source_files binding. ` +
        `Either map them to real files (re-run scan_project) or treat the link as graph-only.`,
      files: [],
      tests_to_add: [],
      estimated_effort: "trivial",
    });
  }

  return {
    approach: `Add missing link between ${entities.join(" \u2194 ")}`,
    intervention_type: resolved.length > 0 ? "source_change" : "graph_enrichment",
    steps,
    resolution: defaultResolutionCall(t),
  };
}

function weakConnectionRemediation(
  t: TensionSignal,
  entities: string[],
  ctx: PlanContext
): DraftPlan {
  const rejected = findRecentRejectedDream(t, ctx.recentDreams);
  const hypothesis = rejected
    ? `The dreamer keeps proposing: "${rejected.from} ${rejected.relation} ${rejected.to}" — ${rejected.reason}`
    : t.description;

  const { resolved, missing } = resolveFileChangesForEntities(
    entities,
    ctx.dataModel,
    hypothesis,
    (e, f) => `Add explicit reference / shared type / integration test in ${f} for ${e}`
  );

  const steps: RemediationStep[] = [
    {
      order: 1,
      description:
        `Recurring weak connection (${t.occurrences} occurrences). ${hypothesis} ` +
        `Either confirm by strengthening the link, or refute via an ADR.`,
      files: resolved,
      tests_to_add: resolved.length > 0 ? [`test_${sanitize(entities.join("_"))}_connection`] : [],
      estimated_effort: "small",
    },
  ];

  if (missing.length > 0) {
    steps.push({
      order: 2,
      description: `Entities [${missing.join(", ")}] have no source_files. Resolve via scan or graph enrichment.`,
      files: [],
      tests_to_add: [],
      estimated_effort: "trivial",
    });
  }

  return {
    approach: `Strengthen weak connection ${entities.join(" \u2194 ")} (${t.domain})`,
    intervention_type: resolved.length > 0 ? "source_change" : "graph_enrichment",
    steps,
    resolution: defaultResolutionCall(t),
  };
}

function hardQueryRemediation(
  t: TensionSignal,
  entities: string[],
  ctx: PlanContext
): DraftPlan {
  const { resolved } = resolveFileChangesForEntities(
    entities,
    ctx.dataModel,
    "Hard queries indicate missing or implicit knowledge that should be explicit",
    (e, f) => `Add clearer documentation or public API surface in ${f} for ${e}`
  );

  return {
    approach: `Resolve hard-to-answer query in ${t.domain} domain`,
    intervention_type: resolved.length > 0 ? "source_change" : "graph_enrichment",
    steps: [
      {
        order: 1,
        description: `Add explicit documentation or API surface for: ${t.description}`,
        files: resolved,
        tests_to_add: [],
        estimated_effort: "trivial",
      },
    ],
    resolution: defaultResolutionCall(t),
  };
}

function ungroundedDreamRemediation(
  t: TensionSignal,
  entities: string[],
  ctx: PlanContext
): DraftPlan {
  const { resolved } = resolveFileChangesForEntities(
    entities,
    ctx.dataModel,
    "Ungrounded dreams need evidence \u2014 either confirm and strengthen, or reject",
    (e, f) => `Read ${f} to confirm or deny the speculation about ${e}`
  );

  return {
    approach: `Ground unverified speculation about ${entities.join(", ")}`,
    intervention_type: resolved.length > 0 ? "source_change" : "wont_fix",
    steps: [
      {
        order: 1,
        description: `Verify through code reading: ${t.description}`,
        files: resolved,
        tests_to_add: resolved.length > 0 ? [`test_${sanitize(entities[0] ?? "unknown")}_behavior_matches_expectation`] : [],
        estimated_effort: "small",
      },
    ],
    resolution: {
      tool: "resolve_tension",
      tension_id: t.id,
      resolved_by: "human",
      resolution_type: resolved.length > 0 ? "confirmed_fixed" : "false_positive",
      evidence: resolved.length > 0
        ? `Verified against ${resolved.map((r) => r.file_path).join(", ")}`
        : `No source binding for entities [${entities.join(", ")}]; treat as ungroundable speculation.`,
    },
  };
}

function codeInsightRemediation(
  t: TensionSignal,
  entities: string[],
  ctx: PlanContext
): DraftPlan {
  const { resolved } = resolveFileChangesForEntities(
    entities,
    ctx.dataModel,
    t.description,
    (e, f) => `Apply targeted fix to ${e} in ${f} based on code analysis`
  );

  return {
    approach: `Act on code insight: ${t.description.slice(0, 80)}`,
    intervention_type: resolved.length > 0 ? "source_change" : "graph_enrichment",
    steps: [
      {
        order: 1,
        description: `Apply code-level improvement: ${t.description}`,
        files: resolved,
        tests_to_add: resolved.length > 0 ? [`test_${sanitize(entities[0] ?? "unknown")}_improved`] : [],
        estimated_effort: "medium",
      },
    ],
    resolution: defaultResolutionCall(t),
  };
}

function genericRemediation(
  t: TensionSignal,
  entities: string[],
  ctx: PlanContext
): DraftPlan {
  const { resolved } = resolveFileChangesForEntities(
    entities,
    ctx.dataModel,
    t.description,
    (e, f) => `Review and update ${e} (${f})`
  );

  return {
    approach: `Address "${t.type}" tension in ${t.domain} domain`,
    intervention_type: resolved.length > 0 ? "source_change" : "graph_enrichment",
    steps: [
      {
        order: 1,
        description: `Investigate and resolve: ${t.description}`,
        files: resolved,
        tests_to_add: resolved.length > 0 ? [`test_${sanitize(t.type)}_resolved`] : [],
        estimated_effort: "medium",
      },
    ],
    resolution: defaultResolutionCall(t),
  };
}

/** Sanitize a string for use in identifiers */
function sanitize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
}

/**
 * Check if a remediation plan conflicts with any existing ADRs.
 *
 * Replaces the old keyword-only matcher with an entity-overlap match:
 * an ADR conflicts iff its `context.affected_entities` overlaps the
 * tension's participating entities. The ADR's title and guard rail are
 * surfaced so the agent can read them before writing code.
 */
function findAdrConflicts(
  tension: TensionSignal,
  adrs: AdrSummary[]
): string[] {
  const tensionEntities = new Set(tension.entities);
  const conflicts: string[] = [];
  for (const adr of adrs) {
    const overlap = adr.affected_entities.filter((e) => tensionEntities.has(e));
    if (overlap.length === 0) continue;
    const railSummary = adr.guard_rails.length > 0 ? ` — guard: "${adr.guard_rails[0]}"` : "";
    conflicts.push(`${adr.id} (${adr.title}) overlaps on [${overlap.join(", ")}]${railSummary}`);
  }
  return [...new Set(conflicts)];
}

/**
 * Predict new tensions that a remediation might introduce.
 */
function predictNewTensions(
  tension: TensionSignal,
  steps: RemediationStep[]
): string[] {
  const predictions: string[] = [];

  const fileCount = steps.reduce((sum, s) => sum + s.files.length, 0);
  if (fileCount > 5) {
    predictions.push(
      "Large change footprint may introduce new structural coupling tensions"
    );
  }

  const hasNewFiles = steps.some((s) => s.files.some((f) => f.change_type === "create"));
  if (hasNewFiles) {
    predictions.push(
      "New files may need to be integrated into existing build/test pipelines"
    );
  }

  if (tension.type === "missing_link" && tension.entities.length > 2) {
    predictions.push(
      "Connecting multiple entities may create new dependency chains"
    );
  }

  return predictions;
}

/**
 * Compute a confidence score for the remediation plan.
 *
 * Reflects observable facts:
 *   + intervention_type (`wont_fix`/`graph_enrichment` are unambiguous)
 *   + real source files resolved
 *   + tension recency (recently re-observed tensions are more reliable)
 *   - ADR conflicts present (caller must read the ADR first)
 *   - very large change footprints
 */
function computeConfidence(
  tension: TensionSignal,
  draft: DraftPlan,
  adrConflicts: string[]
): number {
  // Anchor by intervention_type — graph and wont_fix plans are mechanically certain.
  let confidence: number;
  switch (draft.intervention_type) {
    case "wont_fix":
      confidence = 0.9;
      break;
    case "graph_enrichment":
      confidence = 0.85;
      break;
    case "merge":
    case "rescan":
      confidence = 0.7;
      break;
    case "source_change":
    default:
      confidence = 0.4;
      break;
  }

  // Real source files → confidence boost.
  const realFileCount = draft.steps.reduce((sum, s) => sum + s.files.length, 0);
  if (draft.intervention_type === "source_change" && realFileCount > 0) {
    confidence += Math.min(0.25, realFileCount * 0.08);
  }

  // Recency: tensions seen in the last 24h are more actionable.
  const ageHours = (Date.now() - Date.parse(tension.last_seen)) / 3_600_000;
  if (Number.isFinite(ageHours) && ageHours < 24) confidence += 0.05;

  // Repeated occurrences = real signal, not one-shot noise.
  if (tension.occurrences >= 3) confidence += 0.05;

  // ADR conflicts demand human review — lower confidence.
  if (adrConflicts.length > 0) confidence -= 0.15;

  // Oversized plans are harder to land cleanly.
  if (draft.steps.length > 5) confidence -= 0.1;

  return Math.max(0.1, Math.min(1.0, confidence));
}

function severityFromUrgency(urgency: number): "critical" | "high" | "medium" | "low" {
  if (urgency >= 0.8) return "critical";
  if (urgency >= 0.6) return "high";
  if (urgency >= 0.3) return "medium";
  return "low";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Append a structured `resolve_tension` step + populate `plan.resolution_call`.
 */
function withResolutionStep(plan: RemediationPlan, draft: DraftPlan): RemediationPlan {
  // Avoid duplicating the resolve_tension call if the strategy already added it
  // (phantom-entity short-circuit does this).
  const alreadyHasResolution = plan.steps.some(
    (s) => s.action && "tool" in s.action && s.action.tool === "resolve_tension"
  );
  if (!alreadyHasResolution) {
    plan.steps.push({
      order: plan.steps.length + 1,
      description: `Close the tension via resolve_tension once the steps above are applied.`,
      files: [],
      tests_to_add: [],
      estimated_effort: "trivial",
      action: draft.resolution,
    });
  }
  plan.resolution_call = draft.resolution;
  return plan;
}

function selectRemediationCandidates(
  tensions: TensionSignal[],
  maxPlans: number,
  minUrgency: number,
  now: number
): { allUnresolved: TensionSignal[]; fresh: TensionSignal[]; candidates: TensionSignal[]; skippedStale: number; skippedLowUrgency: number } {
  const allUnresolved = tensions.filter((t) => !t.resolved);
  const SEVEN_DAYS_MS = 7 * 24 * 3_600_000;
  const fresh = allUnresolved.filter((t) => {
    const tooOld = (now - Date.parse(t.last_seen)) > SEVEN_DAYS_MS;
    const dyingTtl = (t.ttl ?? 30) < 5;
    return !(tooOld && dyingTtl);
  });
  const candidates = fresh
    .filter((t) => t.urgency >= minUrgency)
    .sort((a, b) => b.urgency - a.urgency)
    .slice(0, maxPlans);

  return {
    allUnresolved,
    fresh,
    candidates,
    skippedStale: allUnresolved.length - fresh.length,
    skippedLowUrgency: fresh.length - candidates.length,
  };
}

const REMEDIATION_DRAFT_ALLOWED_GRAPH_TARGETS = new Set([
  "features",
  "workflows",
  "data_model",
  "capabilities",
  "system_overview",
  "ui_registry",
  "api_surface",
  "adr",
]);

function remediationDraftMessages(bundle: RemediationEvidenceBundle): LlmMessage[] {
  return [
    {
      role: "system",
      content:
        "Draft one to three remediation candidate futures as strict JSON. " +
        "Return {\"candidates\":[...]} only. Each candidate must include id, title, action_class, " +
        "evidence_anchor_ids, verification_steps, graph_sync_impact, future_fit_score, and objections. " +
        "Use only evidence_anchor ids and action classes present in the provided bundle. " +
        "Every candidate must cite ADR guard-rail anchors when guard rails are present and must score at least 0.35.",
    },
    {
      role: "user",
      content: JSON.stringify({ evidence_bundle: bundle }),
    },
  ];
}

function parseRemediationDraftJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
  return value;
}

export function validateCandidateFuture(raw: unknown, bundle: RemediationEvidenceBundle): CandidateFuture | undefined {
  if (!isRecord(raw)) return undefined;

  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const actionClass = raw.action_class;
  const evidenceAnchorIds = stringArray(raw.evidence_anchor_ids);
  const anchorIds = new Set(bundle.evidence_anchors.map((anchor) => anchor.id));

  if (!id || !title) return undefined;
  if (typeof actionClass !== "string" || !bundle.allowed_action_classes.includes(actionClass as RemediationInterventionType)) {
    return undefined;
  }
  if (!evidenceAnchorIds || evidenceAnchorIds.length === 0 || evidenceAnchorIds.some((anchor) => !anchorIds.has(anchor))) {
    return undefined;
  }

  const requiredAdrAnchorIds = new Set(
    bundle.adr_guard_rails
      .map((guardRail) => guardRail.adr_id)
      .filter((adrId) => anchorIds.has(adrId))
  );
  if ([...requiredAdrAnchorIds].some((adrId) => !evidenceAnchorIds.includes(adrId))) {
    return undefined;
  }

  const existingEntityIds = new Set(
    bundle.entity_summaries
      .filter((entity) => entity.exists)
      .map((entity) => entity.id)
  );
  const knownSourceFiles = new Set(bundle.entity_summaries.flatMap((entity) => entity.source_files));
  const selectedAnchors = bundle.evidence_anchors.filter((anchor) => evidenceAnchorIds.includes(anchor.id));
  if (selectedAnchors.some((anchor) => anchor.kind === "graph_entity" && !existingEntityIds.has(anchor.id))) {
    return undefined;
  }
  if (knownSourceFiles.size > 0 && selectedAnchors.some((anchor) => anchor.kind === "source_anchor" && !knownSourceFiles.has(anchor.id))) {
    return undefined;
  }

  const verificationStepsRaw = Array.isArray(raw.verification_steps) ? raw.verification_steps : [];
  const verificationSteps = verificationStepsRaw.flatMap((step): CandidateFuture["verification_steps"] => {
    if (!isRecord(step)) return [];
    const stepId = typeof step.id === "string" ? step.id.trim() : "";
    const description = typeof step.description === "string" ? step.description.trim() : "";
    const stepAnchors = stringArray(step.evidence_anchor_ids);
    if (!stepId || !description || !stepAnchors || stepAnchors.some((anchor) => !anchorIds.has(anchor))) return [];
    const command = typeof step.command === "string" ? step.command.trim() : "";
    return [{
      id: stepId,
      description,
      command: command || undefined,
      evidence_anchor_ids: stepAnchors,
    }];
  });
  if (verificationSteps.length === 0) return undefined;

  const graphSync = isRecord(raw.graph_sync_impact) ? raw.graph_sync_impact : undefined;
  const graphSyncTargets = stringArray(graphSync?.targets);
  if (!graphSync || typeof graphSync.required !== "boolean" || !graphSyncTargets) return undefined;
  if (graphSync.required && graphSyncTargets.length === 0) return undefined;
  if (graphSyncTargets.some((target) => !REMEDIATION_DRAFT_ALLOWED_GRAPH_TARGETS.has(target))) return undefined;

  const objectionsRaw = Array.isArray(raw.objections) ? raw.objections : [];
  const objections = objectionsRaw.flatMap((objection): CandidateFuture["objections"] => {
    if (!isRecord(objection)) return [];
    const objectionId = typeof objection.id === "string" ? objection.id.trim() : "";
    const description = typeof objection.description === "string" ? objection.description.trim() : "";
    const severity = objection.severity;
    const objectionAnchors = stringArray(objection.evidence_anchor_ids);
    if (
      !objectionId ||
      !description ||
      !objectionAnchors ||
      objectionAnchors.some((anchor) => !anchorIds.has(anchor)) ||
      (severity !== "low" && severity !== "medium" && severity !== "high")
    ) return [];
    return [{ id: objectionId, description, evidence_anchor_ids: objectionAnchors, severity }];
  });

  const score = typeof raw.future_fit_score === "number" && Number.isFinite(raw.future_fit_score)
    ? Math.max(0, Math.min(1, raw.future_fit_score))
    : undefined;
  if (score == null || score < 0.35) return undefined;

  return {
    id,
    title,
    action_class: actionClass as RemediationInterventionType,
    evidence_anchor_ids: evidenceAnchorIds,
    verification_steps: verificationSteps,
    graph_sync_impact: {
      required: graphSync.required,
      targets: graphSyncTargets as CandidateFuture["graph_sync_impact"]["targets"],
      rationale: typeof graphSync.rationale === "string" ? graphSync.rationale : "LLM-drafted remediation candidate requires graph sync review.",
    },
    future_fit_score: score,
    objections,
  };
}

export function validateRemediationDraft(raw: unknown, bundle: RemediationEvidenceBundle): CandidateFuture[] {
  if (!isRecord(raw) || !Array.isArray(raw.candidates)) return [];
  return raw.candidates
    .slice(0, 3)
    .map((candidate) => validateCandidateFuture(candidate, bundle))
    .filter((candidate): candidate is CandidateFuture => !!candidate);
}

export function harvestRemediationFutureSignals(
  bundle: RemediationEvidenceBundle,
  preferredActionClass: RemediationInterventionType
): FutureSignal[] {
  const now = new Date().toISOString();
  const knownAnchorIds = new Set(bundle.evidence_anchors.map((anchor) => anchor.id));
  const tensionAnchorId = `tension:${bundle.tension_id}`;
  const hasTensionAnchor = knownAnchorIds.has(tensionAnchorId);
  const currentAdrAnchorIds = bundle.adr_guard_rails
    .map((adr) => adr.adr_id)
    .filter((adrId) => knownAnchorIds.has(adrId));
  const defaultReviewAnchorIds = currentAdrAnchorIds.length > 0
    ? [currentAdrAnchorIds[0]]
    : hasTensionAnchor
      ? [tensionAnchorId]
      : bundle.evidence_anchors.slice(0, 1).map((anchor) => anchor.id);
  const signals: FutureSignal[] = [];
  const scopedAnchorIds = (anchorIds: string[]): boolean =>
    anchorIds.length > 0 && anchorIds.every((anchorId) => knownAnchorIds.has(anchorId));
  const pushSignal = (signal: FutureSignal): void => {
    if (scopedAnchorIds(signal.evidence_anchor_ids)) {
      signals.push(signal);
    }
  };
  const createSignal = (
    signal: Omit<FutureSignal, "observed_at">,
    observedAt: string = now
  ): void => {
    pushSignal({
      ...signal,
      confidence: Math.max(0, Math.min(1, signal.confidence)),
      observed_at: observedAt,
    });
  };

  for (const signal of bundle.prior_future_signals ?? []) {
    const missingAnchors = signal.evidence_anchor_ids.filter((anchorId) => !knownAnchorIds.has(anchorId));
    const missingAdrAnchors = missingAnchors.filter((anchorId) => ADR_ANCHOR_PATTERN.test(anchorId));
    if (missingAdrAnchors.length > 0 && defaultReviewAnchorIds.length > 0) {
      pushSignal({
        ...signal,
        source: "drift",
        evidence_anchor_ids: defaultReviewAnchorIds,
        status: "superseded",
        reviewed_at: now,
        superseded_by: defaultReviewAnchorIds[0],
        superseded_reason: `Newer accepted ADR state superseded missing anchors: ${missingAdrAnchors.join(", ")}.`,
      });
      continue;
    }
    if (!scopedAnchorIds(signal.evidence_anchor_ids)) {
      continue;
    }
    const observedAtMs = Date.parse(signal.observed_at);
    const isStale = Number.isFinite(observedAtMs) && (Date.now() - observedAtMs) > FUTURE_SIGNAL_STALE_WINDOW_MS;
    pushSignal({
      ...signal,
      status: signal.status ?? (isStale ? "stale" : "active"),
      reviewed_at: now,
      superseded_reason: signal.superseded_reason ?? (isStale
        ? "Signal aged past the remediation review window and now carries reduced weight."
        : undefined),
    });
  }

  const recurringNegativeGroups = new Map<string, FutureSignal[]>();
  for (const signal of signals) {
    if (!NEGATIVE_FUTURE_SIGNAL_SOURCES.has(signal.source)) continue;
    const key = [...signal.evidence_anchor_ids].sort().join("|");
    const group = recurringNegativeGroups.get(key);
    if (group) {
      group.push(signal);
    } else {
      recurringNegativeGroups.set(key, [signal]);
    }
  }
  for (const [key, group] of recurringNegativeGroups.entries()) {
    if (group.length < 2) continue;
    const anchors = key.split("|").filter(Boolean);
    const averageConfidence = group.reduce((sum, signal) => sum + signal.confidence, 0) / group.length;
    const reviewState = group.length >= 3 ? "superseded" : "stale";
    createSignal({
      id: `future_signal:${bundle.id}:review:${anchors.join("_") || "bundle"}`,
      description: "Repeated override, rejection, revert, or drift evidence weakens older remediation preferences.",
      source: "drift",
      evidence_anchor_ids: anchors.length > 0 ? anchors : defaultReviewAnchorIds,
      confidence: Math.min(1, averageConfidence + 0.1),
      status: reviewState,
      reviewed_at: now,
      superseded_reason: reviewState === "superseded"
        ? "Repeated negative evidence superseded older remediation preferences."
        : "Repeated negative evidence weakened older remediation preferences.",
    });
  }

  createSignal({
    id: `future_signal:${bundle.id}:preferred_action`,
    description: `Deterministic remediation strategy prefers ${preferredActionClass}.`,
    source: "explicit_preference",
    evidence_anchor_ids: hasTensionAnchor ? [tensionAnchorId] : bundle.evidence_anchors.slice(0, 1).map((anchor) => anchor.id),
    confidence: 0.72,
    status: "active",
    reviewed_at: now,
  });

  for (const adr of bundle.adr_guard_rails) {
    createSignal({
      id: `future_signal:${bundle.id}:adr:${adr.adr_id}`,
      description: `Accepted ADR guard rails favor candidates that preserve ${adr.title}.`,
      source: "accepted",
      evidence_anchor_ids: [adr.adr_id],
      confidence: 0.95,
      status: "active",
      reviewed_at: now,
    });
  }

  for (const entity of bundle.entity_summaries) {
    if (entity.exists && entity.source_files.length > 0) {
      createSignal({
        id: `future_signal:${bundle.id}:entity:${entity.id}`,
        description: `Existing source binding for ${entity.id} favors concrete, locally verifiable remediation.`,
        source: "recurring_pattern",
        evidence_anchor_ids: [entity.id, ...entity.source_files],
        confidence: 0.68,
        status: "active",
        reviewed_at: now,
      });
    }
  }

  for (const [index, hook] of (bundle.learning_hooks ?? []).entries()) {
    if (!Number.isFinite(hook.confidence)) continue;
    const missingAnchors = hook.evidence_anchor_ids.filter((anchorId) => !knownAnchorIds.has(anchorId));
    const missingAdrAnchors = missingAnchors.filter((anchorId) => ADR_ANCHOR_PATTERN.test(anchorId));
    if (missingAdrAnchors.length > 0 && defaultReviewAnchorIds.length > 0) {
      createSignal({
        id: `future_signal:${bundle.id}:learning_review:${index}`,
        description: `Older preference evidence was excluded because newer accepted ADR state superseded ${missingAdrAnchors.join(", ")}.`,
        source: "drift",
        evidence_anchor_ids: defaultReviewAnchorIds,
        confidence: hook.confidence,
        status: "superseded",
        reviewed_at: now,
        superseded_by: defaultReviewAnchorIds[0],
        superseded_reason: `Newer accepted ADR state superseded missing anchors: ${missingAdrAnchors.join(", ")}.`,
      });
      continue;
    }
    if (!scopedAnchorIds(hook.evidence_anchor_ids)) continue;
    createSignal({
      id: `future_signal:${bundle.id}:learning:${hook.source}:${index}`,
      description: `Scoped ${hook.source.replace(/_/g, " ")} evidence informs remediation future fit.`,
      source: hook.source,
      evidence_anchor_ids: hook.evidence_anchor_ids,
      confidence: hook.confidence,
      status: NEGATIVE_FUTURE_SIGNAL_SOURCES.has(hook.source) ? "stale" : "active",
      reviewed_at: now,
    });
  }

  return signals;
}

export function scoreCandidateFuture(
  candidate: CandidateFuture,
  bundle: RemediationEvidenceBundle,
  signals: FutureSignal[],
  preferredActionClass: RemediationInterventionType
): CandidateFuture {
  const candidateAnchors = new Set(candidate.evidence_anchor_ids);
  const matchingSignals = signals.filter((signal) =>
    signal.evidence_anchor_ids.some((anchorId) => candidateAnchors.has(anchorId))
  );
  const staleSignals = matchingSignals.filter((signal) => signal.status === "stale");
  const supersededSignals = matchingSignals.filter((signal) => signal.status === "superseded");
  const supportingSignals = matchingSignals.filter((signal) =>
    !NEGATIVE_FUTURE_SIGNAL_SOURCES.has(signal.source) && signal.status !== "superseded"
  );
  const cautionarySignals = matchingSignals.filter((signal) => NEGATIVE_FUTURE_SIGNAL_SOURCES.has(signal.source));
  const supportContributions = supportingSignals.map((signal) =>
    signal.confidence * (signal.status === "stale" ? 0.35 : 1)
  );
  const support = supportContributions.length === 0
    ? 0
    : supportContributions.reduce((sum, confidence) => sum + confidence, 0) / supportContributions.length;
  const caution = cautionarySignals.length === 0
    ? 0
    : cautionarySignals.reduce((sum, signal) => sum + signal.confidence, 0) / cautionarySignals.length;
  const averageConfidence = (items: FutureSignal[]): number => items.length === 0
    ? 0
    : items.reduce((sum, signal) => sum + signal.confidence, 0) / items.length;
  const objections = [...candidate.objections];
  let score = candidate.future_fit_score ?? 0.5;

  score += support * 0.25;
  if (staleSignals.length > 0) {
    const objectionAnchors = Array.from(new Set(
      staleSignals.flatMap((signal) => signal.evidence_anchor_ids).filter((anchorId) => candidateAnchors.has(anchorId))
    )).slice(0, 3);
    objections.push({
      id: `future_objection:${candidate.id}:stale_signal`,
      description: "Older remediation-memory evidence is still relevant but has weakened due to drift review.",
      evidence_anchor_ids: objectionAnchors.length > 0 ? objectionAnchors : candidate.evidence_anchor_ids.slice(0, 1),
      severity: averageConfidence(staleSignals) >= 0.75 ? "high" : "medium",
    });
    score -= averageConfidence(staleSignals) * 0.12;
  }
  if (supersededSignals.length > 0) {
    const objectionAnchors = Array.from(new Set(
      supersededSignals.flatMap((signal) => signal.evidence_anchor_ids).filter((anchorId) => candidateAnchors.has(anchorId))
    )).slice(0, 3);
    objections.push({
      id: `future_objection:${candidate.id}:superseded_signal`,
      description: "Some remediation-memory evidence was superseded by repeated drift or newer accepted ADR state.",
      evidence_anchor_ids: objectionAnchors.length > 0 ? objectionAnchors : candidate.evidence_anchor_ids.slice(0, 1),
      severity: averageConfidence(supersededSignals) >= 0.6 ? "high" : "medium",
    });
    score -= averageConfidence(supersededSignals) * 0.2;
  }
  if (caution > 0) {
    const objectionAnchors = Array.from(new Set(
      cautionarySignals.flatMap((signal) => signal.evidence_anchor_ids).filter((anchorId) => candidateAnchors.has(anchorId))
    )).slice(0, 3);
    objections.push({
      id: `future_objection:${candidate.id}:negative_signal`,
      description: "Prior rejection, override, revert, or drift evidence weakens this candidate's future fit.",
      evidence_anchor_ids: objectionAnchors.length > 0 ? objectionAnchors : candidate.evidence_anchor_ids.slice(0, 1),
      severity: caution >= 0.75 ? "high" : "medium",
    });
    score -= caution * 0.3;
  }

  if (candidate.action_class === preferredActionClass) {
    score += 0.2;
  } else {
    objections.push({
      id: `future_objection:${candidate.id}:strategy_mismatch`,
      description: `Candidate is valid but diverges from the deterministic ${preferredActionClass} remediation strategy.`,
      evidence_anchor_ids: candidate.evidence_anchor_ids.slice(0, 1),
      severity: "medium",
    });
    score -= 0.15;
  }

  if (candidate.action_class === "source_change") {
    const hasSourceAnchor = candidate.evidence_anchor_ids.some((anchorId) =>
      bundle.evidence_anchors.some((anchor) => anchor.id === anchorId && anchor.kind === "source_anchor")
    );
    if (!hasSourceAnchor) {
      objections.push({
        id: `future_objection:${candidate.id}:no_source_anchor`,
        description: "Source-change candidate is technically valid but lacks a direct source anchor in the evidence bundle.",
        evidence_anchor_ids: candidate.evidence_anchor_ids.slice(0, 1),
        severity: "high",
      });
      score -= 0.25;
    }
  }

  return {
    ...candidate,
    future_fit_score: Math.max(0, Math.min(1, score)),
    objections,
  };
}

export function buildAdaptiveFutureReview(
  candidate: CandidateFuture | undefined,
  signals: FutureSignal[]
): RemediationPlan["adaptive_future_review"] | undefined {
  if (!candidate) return undefined;

  const candidateAnchors = new Set(candidate.evidence_anchor_ids);
  const matchingSignals = signals.filter((signal) =>
    signal.evidence_anchor_ids.some((anchorId) => candidateAnchors.has(anchorId))
  );
  const weakenedSignalIds = matchingSignals
    .filter((signal) => signal.status === "stale" || NEGATIVE_FUTURE_SIGNAL_SOURCES.has(signal.source))
    .map((signal) => signal.id);
  const supersededSignalIds = matchingSignals
    .filter((signal) => signal.status === "superseded")
    .map((signal) => signal.id);

  if (weakenedSignalIds.length === 0 && supersededSignalIds.length === 0) {
    return undefined;
  }

  const evidenceAnchorIds = Array.from(new Set(
    matchingSignals
      .flatMap((signal) => signal.evidence_anchor_ids)
      .filter((anchorId) => candidateAnchors.has(anchorId))
  )).slice(0, 5);
  const summaryParts: string[] = [];
  if (weakenedSignalIds.length > 0) {
    summaryParts.push(`${weakenedSignalIds.length} prior signal(s) carried reduced weight during ranking.`);
  }
  if (supersededSignalIds.length > 0) {
    summaryParts.push(`${supersededSignalIds.length} signal(s) were superseded by drift review or newer accepted ADR state.`);
  }

  return {
    summary: summaryParts.join(" "),
    weakened_signal_ids: [...new Set(weakenedSignalIds)],
    superseded_signal_ids: [...new Set(supersededSignalIds)],
    evidence_anchor_ids: evidenceAnchorIds.length > 0 ? evidenceAnchorIds : candidate.evidence_anchor_ids.slice(0, 1),
  };
}

function rankCandidateFutures(
  candidates: CandidateFuture[],
  bundle: RemediationEvidenceBundle,
  preferredActionClass: RemediationInterventionType
): CandidateFuture[] {
  const signals = harvestRemediationFutureSignals(bundle, preferredActionClass);
  return candidates
    .map((candidate) => scoreCandidateFuture(candidate, bundle, signals, preferredActionClass))
    .sort((a, b) => (b.future_fit_score ?? 0) - (a.future_fit_score ?? 0));
}

async function draftRemediationCandidateFutures(
  evidenceBundles: RemediationEvidenceBundle[]
): Promise<Map<string, GeneratedRemediationPlanSet>> {
  const route = await selectLlmRoute({
    task: "remediation_drafting",
    daemon_component: "dreamer",
    max_tokens: 1800,
  });
  const completionOptions = {
    ...route.options,
    jsonSchema: {
      name: "remediation_candidate_future_set",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["candidates"],
        properties: {
          candidates: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "id",
                "title",
                "action_class",
                "evidence_anchor_ids",
                "verification_steps",
                "graph_sync_impact",
                "future_fit_score",
                "objections",
              ],
              properties: {
                id: { type: "string", minLength: 1 },
                title: { type: "string", minLength: 1 },
                action_class: { type: "string", minLength: 1 },
                evidence_anchor_ids: {
                  type: "array",
                  minItems: 1,
                  items: { type: "string", minLength: 1 },
                },
                verification_steps: {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["id", "description", "evidence_anchor_ids"],
                    properties: {
                      id: { type: "string", minLength: 1 },
                      description: { type: "string", minLength: 1 },
                      command: { type: "string" },
                      evidence_anchor_ids: {
                        type: "array",
                        minItems: 1,
                        items: { type: "string", minLength: 1 },
                      },
                    },
                  },
                },
                graph_sync_impact: {
                  type: "object",
                  additionalProperties: false,
                  required: ["required", "targets", "rationale"],
                  properties: {
                    required: { type: "boolean" },
                    targets: {
                      type: "array",
                      items: { type: "string", minLength: 1 },
                    },
                    rationale: { type: "string", minLength: 1 },
                  },
                },
                future_fit_score: { type: "number", minimum: 0, maximum: 1 },
                objections: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["id", "description", "evidence_anchor_ids", "severity"],
                    properties: {
                      id: { type: "string", minLength: 1 },
                      description: { type: "string", minLength: 1 },
                      evidence_anchor_ids: {
                        type: "array",
                        minItems: 1,
                        items: { type: "string", minLength: 1 },
                      },
                      severity: { type: "string", enum: ["low", "medium", "high"] },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  const drafts = new Map<string, GeneratedRemediationPlanSet>();
  for (const bundle of evidenceBundles) {
    if (route.layer === "deterministic_fallback" || !route.provider) {
      drafts.set(bundle.id, {
        evidence_bundle_id: bundle.id,
        candidates: [],
        model_layer: "deterministic_fallback",
        model_provenance: route.provenance,
        fallback_reason: route.provenance.fallback_reason,
        validation_failures: [],
      });
      continue;
    }

    try {
      const response = await route.provider.complete(remediationDraftMessages(bundle), completionOptions);
      const candidates = validateRemediationDraft(parseRemediationDraftJson(response.text), bundle);
      drafts.set(bundle.id, {
        evidence_bundle_id: bundle.id,
        candidates,
        model_layer: route.layer,
        model_provenance: route.provenance,
        fallback_reason: candidates.length === 0 ? llmRouteFailureReason("validation") : undefined,
        validation_failures: candidates.length === 0 ? ["No schema-valid remediation candidates returned."] : [],
      });
    } catch (err) {
      logger.warn(`remediation LLM drafting failed for ${bundle.tension_id}: ${(err as Error).message}`);
      drafts.set(bundle.id, {
        evidence_bundle_id: bundle.id,
        candidates: [],
        model_layer: "deterministic_fallback",
        model_provenance: route.provenance,
        fallback_reason: llmRouteFailureReason("provider"),
        validation_failures: [(err as Error).message],
      });
    }
  }
  return drafts;
}

/** Build remediation evidence bundles without drafting or invoking a model. */
export async function buildRemediationEvidenceBundles(
  maxPlans: number = 5,
  minUrgency: number = 0.3
): Promise<RemediationEvidenceBundle[]> {
  const [tensionFile, adrs, dataModel, dreamGraph, remediationLog] = await Promise.all([
    engine.loadTensions(),
    loadAdrLog(),
    loadDataModelMap(),
    engine.loadDreamGraph(),
    loadRemediationLog(),
  ]);
  const ctx: PlanContext = { dataModel, recentDreams: dreamGraph.edges };
  const { candidates } = selectRemediationCandidates(tensionFile.signals, maxPlans, minUrgency, Date.now());
  return candidates.map((tension) => attachAdaptiveFutureMemory(buildRemediationEvidenceBundle(tension, adrs, ctx), remediationLog));
}

/**
 * Generate remediation plans for the top N highest-urgency unresolved tensions.
 *
 * @param maxPlans Maximum number of plans to generate (default: 5)
 * @param minUrgency Minimum urgency threshold (default: 0.3)
 */
export async function generateRemediationPlans(
  maxPlans: number = 5,
  minUrgency: number = 0.3
): Promise<RemediationPlanOutput> {
  logger.info(`Generating remediation plans (max=${maxPlans}, minUrgency=${minUrgency})`);

  const [tensionFile, adrs, dataModel, dreamGraph, remediationLog] = await Promise.all([
    engine.loadTensions(),
    loadAdrLog(),
    loadDataModelMap(),
    engine.loadDreamGraph(),
    loadRemediationLog(),
  ]);

  logger.info(
    `Remediation planner loaded ${adrs.length} ADRs and ${dataModel.size} data_model entries.`
  );

  const ctx: PlanContext = { dataModel, recentDreams: dreamGraph.edges };
  const {
    allUnresolved,
    candidates,
    skippedStale,
    skippedLowUrgency,
  } = selectRemediationCandidates(tensionFile.signals, maxPlans, minUrgency, Date.now());

  if (candidates.length === 0) {
    logger.info("No tensions above urgency threshold — nothing to remediate");
    return {
      plans: [],
      total_tensions_analyzed: allUnresolved.length,
      plans_generated: 0,
      skipped_low_urgency: skippedLowUrgency,
      skipped_stale: skippedStale,
      timestamp: new Date().toISOString(),
    };
  }

  const plans: RemediationPlan[] = [];
  const planOutcomes: RemediationPlanOutcome[] = [];
  const futureSignalsForPersistence: FutureSignal[] = [];
  const candidateRunAudit: Array<{
    evidence_bundle_id: string;
    selected_candidate_id?: string;
    rejected_candidate_ids: string[];
    model_layer: GeneratedRemediationPlanSet["model_layer"];
    fallback_reason?: string;
    validation_failures: string[];
    future_fit_score?: number;
    objection_count: number;
    future_signal_ids: string[];
    recorded_at: string;
  }> = [];
  const evidenceBundles = candidates.map((tension) => attachAdaptiveFutureMemory(buildRemediationEvidenceBundle(tension, adrs, ctx), remediationLog));
  const llmEligibleEvidenceBundles = evidenceBundles.filter(
    (bundle) => bundle.deterministic_short_circuit === "none"
  );
  const llmDrafts = await draftRemediationCandidateFutures(llmEligibleEvidenceBundles);
  logger.info(
    `Remediation planner assembled ${evidenceBundles.length} evidence bundle(s) ` +
    `(${evidenceBundles.length - llmEligibleEvidenceBundles.length} deterministic short-circuit bypass(es)).`
  );

  for (let index = 0; index < candidates.length; index += 1) {
    const tension = candidates[index];
    const evidenceBundle = evidenceBundles[index];
    const generatedSet = llmDrafts.get(evidenceBundle.id);
    const draft = strategyForTension(tension, ctx);
    const futureSignals = harvestRemediationFutureSignals(evidenceBundle, draft.intervention_type);
    futureSignalsForPersistence.push(...futureSignals);
    const rankedCandidates = generatedSet
      ? generatedSet.candidates
        .map((candidate) => scoreCandidateFuture(candidate, evidenceBundle, futureSignals, draft.intervention_type))
        .sort((a, b) => (b.future_fit_score ?? 0) - (a.future_fit_score ?? 0))
      : [];
    const llmCandidate = rankedCandidates[0];
    const adrConflicts = findAdrConflicts(tension, adrs);
    const predictedTensions = predictNewTensions(tension, draft.steps);
    const deterministicConfidence = computeConfidence(tension, draft, adrConflicts);
    const confidence = llmCandidate?.future_fit_score == null
      ? deterministicConfidence
      : Math.max(0.1, Math.min(1.0, (deterministicConfidence + llmCandidate.future_fit_score) / 2));

    if (generatedSet?.fallback_reason) {
      logger.info(
        `Remediation drafting used deterministic fallback for ${tension.id}: ${generatedSet.fallback_reason}`
      );
    } else if (llmCandidate) {
      logger.info(
        `Selected remediation candidate ${llmCandidate.id} for ${tension.id} with future-fit score ${llmCandidate.future_fit_score ?? 0} ` +
        `and ${llmCandidate.objections.length} future objection(s).`
      );
    }

    const planBase: RemediationPlan = {
      id: `rem_${tension.id}_${Date.now().toString(36)}`,
      tension_id: tension.id,
      title: llmCandidate?.title ?? draft.approach,
      severity: severityFromUrgency(tension.urgency),
      intervention_type: draft.intervention_type,
      steps: draft.steps,
      adr_conflicts: adrConflicts,
      new_tensions_predicted: predictedTensions,
      confidence,
      adaptive_future_review: buildAdaptiveFutureReview(llmCandidate, futureSignals),
      generated_at: new Date().toISOString(),
    };
    const completedPlan = withResolutionStep(planBase, draft);
    plans.push(completedPlan);

    candidateRunAudit.push({
      evidence_bundle_id: evidenceBundle.id,
      selected_candidate_id: llmCandidate?.id,
      rejected_candidate_ids: rankedCandidates.slice(1).map((candidate) => candidate.id),
      model_layer: generatedSet?.model_layer ?? "deterministic_fallback",
      fallback_reason: generatedSet?.fallback_reason,
      validation_failures: generatedSet?.validation_failures ?? [],
      future_fit_score: llmCandidate?.future_fit_score,
      objection_count: llmCandidate?.objections.length ?? 0,
      future_signal_ids: futureSignals.map((signal) => signal.id),
      recorded_at: planBase.generated_at,
    });
    planOutcomes.push({
      tension_id: tension.id,
      evidence_bundle_id: evidenceBundle.id,
      selected_plan_id: completedPlan.id,
      model_layer: generatedSet?.model_layer ?? "deterministic_fallback",
      fallback_reason: generatedSet?.fallback_reason,
      graph_sync_impact: llmCandidate?.graph_sync_impact ?? {
        required: false,
        targets: [],
        rationale: "Deterministic remediation fallback did not require candidate graph-sync metadata.",
      },
      verification_steps: llmCandidate?.verification_steps ?? evidenceBundle.verification_obligations,
      recorded_at: planBase.generated_at,
    });
  }

  logger.info(
    `Recorded ${planOutcomes.length} remediation outcome(s) and ${candidateRunAudit.length} candidate-run audit item(s) for this planning run.`
  );

  // Persist for cross-session continuity (item 6 of FIX_REMEDIATION_PLAN_ENGINE).
  try {
    await persistRemediationPlans(plans, planOutcomes, candidateRunAudit, futureSignalsForPersistence);
  } catch (err) {
    logger.warn(`persistRemediationPlans: ${(err as Error).message}`);
  }

  const severityCounts = {
    critical: plans.filter((p) => p.severity === "critical").length,
    high: plans.filter((p) => p.severity === "high").length,
    medium: plans.filter((p) => p.severity === "medium").length,
    low: plans.filter((p) => p.severity === "low").length,
  };
  const typeCounts = {
    source_change: plans.filter((p) => p.intervention_type === "source_change").length,
    graph_enrichment: plans.filter((p) => p.intervention_type === "graph_enrichment").length,
    wont_fix: plans.filter((p) => p.intervention_type === "wont_fix").length,
  };

  logger.info(
    `Generated ${plans.length} remediation plans ` +
    `(${severityCounts.critical} critical / ${severityCounts.high} high / ` +
    `${severityCounts.medium} medium / ${severityCounts.low} low; ` +
    `${typeCounts.source_change} source / ${typeCounts.graph_enrichment} graph / ${typeCounts.wont_fix} wont_fix).`
  );

  return {
    plans,
    total_tensions_analyzed: allUnresolved.length,
    plans_generated: plans.length,
    skipped_low_urgency: skippedLowUrgency,
    skipped_stale: skippedStale,
    timestamp: new Date().toISOString(),
  };
}


// ===========================================================================
// Tension-resolver bridge (v8.2.6)
//
// Exposes a lightweight helper for `engine.runTensionResolverCycle` that
// reuses the planner's strategy decisions but returns a TensionResolution-
// Candidate (not a full RemediationPlan). Lets the resolver carry a
// concrete `proposed_action` payload without duplicating planning logic.
// ===========================================================================

export interface TensionPlanContext {
  dataModel: Map<string, EntitySummary>;
  recentDreams: DreamEdge[];
}

/**
 * Build the per-cycle context once and reuse across every tension. The
 * resolver loop calls this exactly once per `runTensionResolverCycle` to
 * avoid N+1 reads of `data_model.json` and `dream_graph.json`.
 */
export async function buildTensionPlanContext(): Promise<TensionPlanContext> {
  const [dataModel, dreamGraph] = await Promise.all([
    loadDataModelMap(),
    engine.loadDreamGraph(),
  ]);
  return { dataModel, recentDreams: dreamGraph.edges };
}

function strategyFromInterventionType(
  interventionType: RemediationInterventionType,
  tensionType: string,
): TensionResolutionStrategy {
  switch (interventionType) {
    case "wont_fix":
      return "wont_fix";
    case "graph_enrichment":
      // Adding an explicit edge is a "merge" of identity / connectivity.
      return "merge";
    case "merge":
      return "merge";
    case "rescan":
      return "reframe";
    case "source_change":
    default:
      // Source changes for missing_link / weak_connection are bridge work.
      // Other code-level signals look like "split" for over-coupled entities.
      if (tensionType === "missing_link" || tensionType === "weak_connection") return "mediator";
      if (tensionType === "code_insight") return "split";
      return "mediator";
  }
}

/**
 * Generate an action-bearing resolution candidate for a single tension by
 * reusing the planner's `strategyForTension`. Returns null only when the
 * tension produces no draft (should never happen in practice).
 */
export function proposeResolutionCandidateFromPlan(
  tension: TensionSignal,
  ctx: TensionPlanContext,
): Omit<TensionResolutionCandidate, "proposed_at"> | null {
  const draft = strategyForTension(tension, { dataModel: ctx.dataModel, recentDreams: ctx.recentDreams });
  if (!draft) return null;

  const strategy = strategyFromInterventionType(draft.intervention_type, tension.type);

  // First step often carries the structured action (graph_enrichment or wont_fix).
  // Fall back to the resolution call so wont_fix / source_change still expose
  // an executable closing call to the caller.
  const stepAction = draft.steps.find((s) => s.action)?.action;
  const proposedAction = stepAction ?? draft.resolution;

  return {
    strategy,
    rationale: draft.approach,
    validation_window: 3,
    source: "heuristic",
    proposed_action: proposedAction,
  };
}
