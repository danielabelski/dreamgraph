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
  RemediationResolutionCall,
  RemediationEnrichmentAction,
  FileChange,
  DreamEdge,
} from "./types.js";

// ---------------------------------------------------------------------------
// File constants
// ---------------------------------------------------------------------------

const REMEDIATION_LOG_FILENAME = "remediation_log.json";
const SCHEMA_VERSION = "1.0";

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

async function persistRemediationPlans(plans: RemediationPlan[]): Promise<void> {
  if (plans.length === 0) return;
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

  const [tensionFile, adrs, dataModel, dreamGraph] = await Promise.all([
    engine.loadTensions(),
    loadAdrLog(),
    loadDataModelMap(),
    engine.loadDreamGraph(),
  ]);

  logger.info(
    `Remediation planner loaded ${adrs.length} ADRs and ${dataModel.size} data_model entries.`
  );

  const ctx: PlanContext = { dataModel, recentDreams: dreamGraph.edges };
  const allUnresolved = tensionFile.signals.filter((t) => !t.resolved);

  // Recency filter: drop tensions whose TTL has decayed below 5 cycles AND
  // whose last_seen is older than 7 days. These are dying signals.
  const now = Date.now();
  const SEVEN_DAYS_MS = 7 * 24 * 3_600_000;
  const fresh = allUnresolved.filter((t) => {
    const tooOld = (now - Date.parse(t.last_seen)) > SEVEN_DAYS_MS;
    const dyingTtl = (t.ttl ?? 30) < 5;
    return !(tooOld && dyingTtl);
  });
  const skippedStale = allUnresolved.length - fresh.length;

  const candidates = fresh
    .filter((t) => t.urgency >= minUrgency)
    .sort((a, b) => b.urgency - a.urgency)
    .slice(0, maxPlans);

  const skippedLowUrgency = fresh.length - candidates.length;

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
  for (const tension of candidates) {
    const draft = strategyForTension(tension, ctx);
    const adrConflicts = findAdrConflicts(tension, adrs);
    const predictedTensions = predictNewTensions(tension, draft.steps);
    const confidence = computeConfidence(tension, draft, adrConflicts);

    const planBase: RemediationPlan = {
      id: `rem_${tension.id}_${Date.now().toString(36)}`,
      tension_id: tension.id,
      title: draft.approach,
      severity: severityFromUrgency(tension.urgency),
      intervention_type: draft.intervention_type,
      steps: draft.steps,
      adr_conflicts: adrConflicts,
      new_tensions_predicted: predictedTensions,
      confidence,
      generated_at: new Date().toISOString(),
    };
    plans.push(withResolutionStep(planBase, draft));
  }

  // Persist for cross-session continuity (item 6 of FIX_REMEDIATION_PLAN_ENGINE).
  try {
    await persistRemediationPlans(plans);
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
