/**
 * DreamGraph MCP Server — solidify_cognitive_insight tool.
 *
 * Allows the AI agent to write subjective insights (discovered by
 * reading source code) back into the cognitive memory system.
 *
 * Three insight types:
 *   EDGE    → Speculative relationship between two entities.
 *             Written as a DreamEdge into dream_graph.json with
 *             strategy "reflective". Enters the normal decay →
 *             normalize → promote pipeline.
 *
 *   TENSION → Something the agent noticed is wrong / missing / risky.
 *             Written via engine.recordTension() and feeds back into
 *             tension_directed dreaming on future cycles.
 *
 *   ENTITY  → Hypothetical entity the agent believes should exist.
 *             Written as a DreamNode into dream_graph.json.
 *
 * The tool briefly transitions to REM state (if needed) to satisfy
 * the engine's state guards, then returns to AWAKE.
 *
 * Safety: Only writes to dream / tension data.
 *         The Fact Graph is never modified.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { engine } from "../cognitive/engine.js";
import { success, error, safeExecute } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { DEFAULT_DECAY } from "../cognitive/types.js";
import { selectLlmRoute } from "../cognitive/llm.js";
import { buildAdaptiveFutureAuditTrail } from "../cognitive/adaptive-future-scaffold.js";
import type { LlmMessage } from "../cognitive/llm.js";
import type { AdaptiveFutureAnchor, AdaptiveFutureAuditTrail } from "../cognitive/adaptive-future-scaffold.js";
import { loadJsonArray, loadJsonData } from "../utils/cache.js";
import type {
  ADRLogFile,
  CapabilityEntity,
  DataModelEntity,
  DreamEdge,
  DreamNode,
  Feature,
  TensionSignal,
  ToolResponse,
  ValidatedEdge,
  Workflow,
} from "../types/index.js";

// ---------------------------------------------------------------------------
// Output type
// ---------------------------------------------------------------------------

type SolidifyInsightType = "EDGE" | "TENSION" | "ENTITY";
type SolidifyDurableTargetType =
  | "feature"
  | "workflow"
  | "data_model_relation"
  | "adr_candidate"
  | "noop"
  | "rejected";

type SolidifyPlanningOutcome = "accepted" | "rejected" | "noop" | "fallback";

export interface SolidifyDurableCandidate {
  target_type: SolidifyDurableTargetType;
  target_id?: string;
  relation?: string;
  source_ids: string[];
  target_ids: string[];
  evidence_anchors: string[];
  confidence: number;
  rationale: string;
  risks: string[];
  required_validation: string[];
  adr_guard_rail_review: string[];
  contradictions: string[];
  duplicate_of?: string;
}

export interface SolidifyPlanningMetadata {
  route_layer: string;
  provider: string | null;
  model: string | null;
  temperature?: number;
  llm_calls: number;
  tokens_used: number;
  accepted: boolean;
  outcome: SolidifyPlanningOutcome;
  evidence_anchors: string[];
  validation_errors: string[];
  rejected_reasons: string[];
  fallback_reason?: string;
  adaptive_future_audit: AdaptiveFutureAuditTrail;
}

interface SolidifyResult {
  /** What was written */
  insightType: SolidifyInsightType;
  /** ID of the created artifact */
  id: string;
  /** Where it was persisted */
  target_file: string;
  /** Current confidence / urgency */
  confidence: number;
  /** Whether it was merged with an existing item */
  merged: boolean;
  /** Validated advisory durable target, when ADR-203 routing produced one */
  adaptive_candidate?: SolidifyDurableCandidate | null;
  /** Model-routing and validation provenance for the advisory layer */
  planning_metadata?: SolidifyPlanningMetadata;
  /** Brief confirmation message */
  message: string;
}

interface SolidifyExplicitInput {
  insightType: SolidifyInsightType;
  sourceNodeId: string;
  targetNodeId?: string;
  relation?: string;
  rationale: string;
  confidence: number;
  codeReferences?: string[];
  tensionLevel?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  entityName?: string;
  entityDescription?: string;
}

interface SolidifyEntitySummary {
  id: string;
  name?: string;
  source_repo?: string;
  source_files?: string[];
}

interface SolidifyRelationSummary {
  id: string;
  from: string;
  to: string;
  relation: string;
  status?: string;
}

interface SolidifyAdrSummary {
  id: string;
  title: string;
  affected_entities: string[];
  guard_rails: string[];
}

export interface SolidifyValidationContext {
  knownIds: Set<string>;
  existingFeatureIds: Set<string>;
  existingWorkflowIds: Set<string>;
  existingDataModelIds: Set<string>;
  existingAdrIds: Set<string>;
  existingRelations: SolidifyRelationSummary[];
  acceptedAdrGuardRails: SolidifyAdrSummary[];
  codeReferences: string[];
  sourceRepo: string;
}

const SOLIDIFY_TARGET_TYPES = new Set<SolidifyDurableTargetType>([
  "feature",
  "workflow",
  "data_model_relation",
  "adr_candidate",
  "noop",
  "rejected",
]);

const SOLIDIFY_CLASSIFICATION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "target_type",
    "source_ids",
    "target_ids",
    "evidence_anchors",
    "confidence",
    "rationale",
    "risks",
    "required_validation",
    "adr_guard_rail_review",
    "contradictions",
  ],
  properties: {
    target_type: {
      type: "string",
      enum: ["feature", "workflow", "data_model_relation", "adr_candidate", "noop", "rejected"],
    },
    target_id: { type: "string" },
    relation: { type: "string" },
    source_ids: { type: "array", items: { type: "string" } },
    target_ids: { type: "array", items: { type: "string" } },
    evidence_anchors: { type: "array", items: { type: "string" } },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    rationale: { type: "string" },
    risks: { type: "array", items: { type: "string" } },
    required_validation: { type: "array", items: { type: "string" } },
    adr_guard_rail_review: { type: "array", items: { type: "string" } },
    contradictions: { type: "array", items: { type: "string" } },
    duplicate_of: { type: "string" },
  },
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idSeq = 0;
function insightId(prefix: string): string {
  idSeq++;
  return `insight_${prefix}_${Date.now()}_${idSeq}`;
}

/**
 * Ensure the engine is in REM state so we can write to the dream graph.
 * Returns a cleanup function that restores the previous state.
 */
async function ensureRem(): Promise<() => Promise<void>> {
  const prev = engine.getState();
  if (prev === "rem") {
    // Already in REM — nothing to restore
    return async () => {};
  }

  // Force to AWAKE first if in an intermediate state
  if (prev !== "awake") {
    await engine.interrupt();
  }

  engine.enterRem();

  return async () => {
    // Return to AWAKE via interrupt (safe from any state)
    if (engine.getState() !== "awake") {
      await engine.interrupt();
    }
  };
}

function parseJsonPayload(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced) return JSON.parse(fenced[1]);
    const objectMatch = text.match(/\{[\s\S]*\}/);
    if (!objectMatch) throw new Error("LLM did not return parseable JSON");
    return JSON.parse(objectMatch[0]);
  }
}

function readString(
  obj: Record<string, unknown>,
  key: string,
  errors: string[],
  path: string,
): string {
  const value = obj[key];
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  errors.push(`${path}.${key} must be a non-empty string`);
  return "";
}

function readOptionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumber(
  obj: Record<string, unknown>,
  key: string,
  errors: string[],
  path: string,
): number {
  const value = obj[key];
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) {
    return value;
  }
  errors.push(`${path}.${key} must be a number between 0 and 1`);
  return 0;
}

function readStringArray(
  obj: Record<string, unknown>,
  key: string,
  errors: string[],
  path: string,
): string[] {
  const value = obj[key];
  if (!Array.isArray(value)) {
    errors.push(`${path}.${key} must be an array`);
    return [];
  }
  const strings = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (strings.length !== value.length) {
    errors.push(`${path}.${key} must contain only non-empty strings`);
  }
  return [...new Set(strings)];
}

export function parseSolidifyClassificationDraft(text: string): {
  candidate: SolidifyDurableCandidate | null;
  errors: string[];
} {
  const errors: string[] = [];
  let payload: unknown;
  try {
    payload = parseJsonPayload(text);
  } catch (err) {
    return { candidate: null, errors: [err instanceof Error ? err.message : String(err)] };
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { candidate: null, errors: ["LLM response must be a JSON object"] };
  }

  const root = payload as Record<string, unknown>;
  const rawTargetType = readString(root, "target_type", errors, "candidate");
  const target_type = SOLIDIFY_TARGET_TYPES.has(rawTargetType as SolidifyDurableTargetType)
    ? rawTargetType as SolidifyDurableTargetType
    : "rejected";
  if (rawTargetType && target_type === "rejected" && rawTargetType !== "rejected") {
    errors.push(`candidate.target_type is not supported: ${rawTargetType}`);
  }

  const candidate: SolidifyDurableCandidate = {
    target_type,
    ...(readOptionalString(root, "target_id") ? { target_id: readOptionalString(root, "target_id") } : {}),
    ...(readOptionalString(root, "relation") ? { relation: readOptionalString(root, "relation") } : {}),
    source_ids: readStringArray(root, "source_ids", errors, "candidate"),
    target_ids: readStringArray(root, "target_ids", errors, "candidate"),
    evidence_anchors: readStringArray(root, "evidence_anchors", errors, "candidate"),
    confidence: readNumber(root, "confidence", errors, "candidate"),
    rationale: readString(root, "rationale", errors, "candidate"),
    risks: readStringArray(root, "risks", errors, "candidate"),
    required_validation: readStringArray(root, "required_validation", errors, "candidate"),
    adr_guard_rail_review: readStringArray(root, "adr_guard_rail_review", errors, "candidate"),
    contradictions: readStringArray(root, "contradictions", errors, "candidate"),
    ...(readOptionalString(root, "duplicate_of") ? { duplicate_of: readOptionalString(root, "duplicate_of") } : {}),
  };

  return errors.length > 0 ? { candidate: null, errors } : { candidate, errors: [] };
}

function isOwnedSourceReference(anchor: string): boolean {
  const normalized = anchor.replace(/\\/g, "/").replace(/:\d+(?::\d+)?$/, "");
  if (/^[a-z]+:\/\//i.test(normalized)) return false;
  if (/^[a-z]:\//i.test(normalized)) return false;
  if (normalized.startsWith("/") || normalized.includes("../") || normalized.includes("/..")) return false;
  return /^(src|tests|plans|data|docs)\//.test(normalized);
}

function containsGuardRailBypass(texts: string[]): boolean {
  const text = texts.join("\n").toLowerCase();
  return /\b(ignore|bypass|override|skip|disable)\b[\s\S]{0,80}\b(adr|guard|governance|validation|constraint|ownership|evidence)\b/.test(text);
}

function relationKey(from: string, to: string, relation?: string): string {
  return `${from}::${to}::${relation ?? ""}`.toLowerCase();
}

export function validateSolidifyClassificationCandidate(
  candidate: SolidifyDurableCandidate,
  context: SolidifyValidationContext,
): string[] {
  const errors: string[] = [];
  const terminal = candidate.target_type === "noop" || candidate.target_type === "rejected";
  const candidateIds = new Set([
    ...candidate.source_ids,
    ...candidate.target_ids,
  ].filter(Boolean));

  if (!terminal && candidate.source_ids.length === 0) {
    errors.push("candidate.source_ids must include at least one existing graph id");
  }
  for (const id of candidateIds) {
    if (!context.knownIds.has(id)) {
      errors.push(`candidate references unknown graph id ${id}`);
    }
  }

  if (candidate.evidence_anchors.length === 0) {
    errors.push("candidate.evidence_anchors must include source evidence");
  }
  if (context.codeReferences.length > 0) {
    const citesProvidedAnchor = candidate.evidence_anchors.some((anchor) =>
      context.codeReferences.includes(anchor)
    );
    if (!citesProvidedAnchor) {
      errors.push("candidate.evidence_anchors must cite at least one supplied code reference");
    }
  }
  for (const anchor of candidate.evidence_anchors) {
    if (!context.knownIds.has(anchor) && !isOwnedSourceReference(anchor)) {
      errors.push(`candidate.evidence_anchors contains unowned or unknown anchor ${anchor}`);
    }
  }

  if (candidate.duplicate_of) {
    errors.push(`candidate duplicates existing graph entry ${candidate.duplicate_of}`);
  }
  if (candidate.contradictions.length > 0) {
    errors.push(`candidate reports contradictions: ${candidate.contradictions.join("; ")}`);
  }

  if (candidate.target_type === "feature") {
    if (!candidate.target_id) errors.push("feature candidate requires target_id");
    else if (!candidate.target_id.startsWith("feature_")) {
      errors.push("feature candidate target_id must start with feature_");
    } else if (context.existingFeatureIds.has(candidate.target_id)) {
      errors.push(`feature candidate duplicates existing feature id ${candidate.target_id}`);
    }
  }

  if (candidate.target_type === "workflow") {
    if (!candidate.target_id) errors.push("workflow candidate requires target_id");
    else if (!candidate.target_id.startsWith("workflow_")) {
      errors.push("workflow candidate target_id must start with workflow_");
    } else if (context.existingWorkflowIds.has(candidate.target_id)) {
      errors.push(`workflow candidate duplicates existing workflow id ${candidate.target_id}`);
    }
  }

  if (candidate.target_type === "data_model_relation") {
    if (!candidate.relation) errors.push("data_model_relation candidate requires relation");
    if (candidate.source_ids.length === 0 || candidate.target_ids.length === 0) {
      errors.push("data_model_relation candidate requires source_ids and target_ids");
    }
    for (const source of candidate.source_ids) {
      for (const target of candidate.target_ids) {
        const key = relationKey(source, target, candidate.relation);
        const duplicate = context.existingRelations.find((edge) =>
          relationKey(edge.from, edge.to, edge.relation) === key
        );
        if (duplicate) {
          errors.push(`data_model_relation duplicates existing relation ${duplicate.id}`);
        }
      }
    }
  }

  if (candidate.target_type === "adr_candidate") {
    if (!candidate.target_id) errors.push("adr_candidate requires target_id");
    else if (!/^ADR-\d+$/i.test(candidate.target_id) && !candidate.target_id.startsWith("adr_candidate_")) {
      errors.push("adr_candidate target_id must be ADR-NNN or adr_candidate_* until recorded");
    } else if (context.existingAdrIds.has(candidate.target_id)) {
      errors.push(`adr_candidate duplicates existing ADR id ${candidate.target_id}`);
    }
  }

  const governanceText = [
    candidate.target_type,
    candidate.target_id ?? "",
    candidate.relation ?? "",
    candidate.rationale,
    ...candidate.risks,
    ...candidate.required_validation,
    ...candidate.adr_guard_rail_review,
  ];
  if (containsGuardRailBypass(governanceText)) {
    errors.push("candidate attempts to bypass ADR guard rails, validation, source ownership, or evidence constraints");
  }
  if (!terminal && context.acceptedAdrGuardRails.length > 0 && candidate.adr_guard_rail_review.length === 0) {
    errors.push("candidate.adr_guard_rail_review must cite accepted ADR guard rails");
  }

  return errors;
}

function toEntitySummary(entry: Feature | Workflow | DataModelEntity | CapabilityEntity): SolidifyEntitySummary {
  return {
    id: entry.id,
    name: entry.name,
    source_repo: entry.source_repo,
    source_files: entry.source_files,
  };
}

function relationFromDreamEdge(edge: DreamEdge): SolidifyRelationSummary {
  return {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    relation: edge.relation,
    status: edge.status,
  };
}

function relationFromValidatedEdge(edge: ValidatedEdge): SolidifyRelationSummary {
  return {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    relation: edge.relation,
    status: edge.status,
  };
}

async function loadAdrLog(): Promise<ADRLogFile> {
  try {
    const log = await loadJsonData<ADRLogFile>("adr_log.json");
    return {
      metadata: log.metadata,
      decisions: Array.isArray(log.decisions) ? log.decisions : [],
    };
  } catch {
    return {
      metadata: {
        description: "Architecture Decision Records — why things were built this way.",
        schema_version: "1.0.0",
        total_decisions: 0,
        last_updated: null,
      },
      decisions: [],
    };
  }
}

async function loadSolidifyValidationContext(
  input: SolidifyExplicitInput,
): Promise<SolidifyValidationContext & { entitySummaries: SolidifyEntitySummary[] }> {
  const [features, workflows, dataModel, capabilities, dreamGraph, validatedEdges, adrLog] = await Promise.all([
    loadJsonArray<Feature>("features.json"),
    loadJsonArray<Workflow>("workflows.json"),
    loadJsonArray<DataModelEntity>("data_model.json"),
    loadJsonArray<CapabilityEntity>("capabilities.json"),
    engine.loadDreamGraph(),
    engine.loadValidatedEdges(),
    loadAdrLog(),
  ]);

  const entitySummaries = [
    ...features.map(toEntitySummary),
    ...workflows.map(toEntitySummary),
    ...dataModel.map(toEntitySummary),
    ...capabilities.map(toEntitySummary),
    ...dreamGraph.nodes.map((node) => ({ id: node.id, name: node.name, source_repo: "dreamgraph", source_files: [] })),
  ];
  const knownIds = new Set(entitySummaries.map((entry) => entry.id));
  for (const edge of dreamGraph.edges) {
    knownIds.add(edge.id);
    knownIds.add(edge.from);
    knownIds.add(edge.to);
  }
  knownIds.add(input.sourceNodeId);
  if (input.targetNodeId) knownIds.add(input.targetNodeId);

  const relevantIds = new Set([input.sourceNodeId, input.targetNodeId].filter((id): id is string => Boolean(id)));
  const acceptedAdrGuardRails = adrLog.decisions
    .filter((adr) => adr.status === "accepted")
    .filter((adr) =>
      ["ADR-126", "ADR-203", "ADR-204"].includes(adr.id) ||
      adr.context.affected_entities.some((entityId) => relevantIds.has(entityId))
    )
    .slice(-8)
    .map((adr) => ({
      id: adr.id,
      title: adr.title,
      affected_entities: adr.context.affected_entities,
      guard_rails: adr.guard_rails,
    }));

  return {
    knownIds,
    existingFeatureIds: new Set(features.map((entry) => entry.id)),
    existingWorkflowIds: new Set(workflows.map((entry) => entry.id)),
    existingDataModelIds: new Set(dataModel.map((entry) => entry.id)),
    existingAdrIds: new Set(adrLog.decisions.map((entry) => entry.id)),
    existingRelations: [
      ...dreamGraph.edges.map(relationFromDreamEdge),
      ...validatedEdges.edges.map(relationFromValidatedEdge),
    ],
    acceptedAdrGuardRails,
    codeReferences: input.codeReferences ?? [],
    sourceRepo: "dreamgraph",
    entitySummaries,
  };
}

function buildSolidifyClassificationPrompt(
  input: SolidifyExplicitInput,
  context: SolidifyValidationContext & { entitySummaries: SolidifyEntitySummary[] },
): LlmMessage[] {
  const payload = {
    explicit_request: input,
    known_entities: context.entitySummaries.slice(0, 80),
    existing_relations: context.existingRelations.slice(0, 80),
    accepted_adr_guard_rails: context.acceptedAdrGuardRails,
    required_output: {
      target_type: "feature | workflow | data_model_relation | adr_candidate | noop | rejected",
      source_ids: "existing graph ids only",
      target_ids: "existing graph ids only, except target_id for new feature/workflow/ADR candidate",
      evidence_anchors: "provided codeReferences or repo-relative source anchors only",
      contradictions: "must be empty for accepted mutation candidates",
    },
  };

  return [
    {
      role: "system",
      content:
        "Classify a speculative DreamGraph cognitive insight before durable mutation. " +
        "Return strict JSON only. Do not invent graph ids, source files, ADR ids, or validation evidence. " +
        "If evidence is weak, duplicate, contradictory, or conflicts with ADR guard rails, return target_type='noop' or 'rejected'.",
    },
    {
      role: "user",
      content: JSON.stringify(payload, null, 2),
    },
  ];
}

function planningMetadata(
  route: Awaited<ReturnType<typeof selectLlmRoute>>,
  llmCalls: number,
  tokensUsed: number,
  candidate: SolidifyDurableCandidate | null,
  validationErrors: string[],
  rejectedReasons: string[],
): SolidifyPlanningMetadata {
  const provenance = route.provenance as Record<string, unknown>;
  const fallbackReason = typeof provenance.fallback_reason === "string" ? provenance.fallback_reason : undefined;
  const temperature = typeof provenance.temperature === "number" ? provenance.temperature : undefined;
  const outcome: SolidifyPlanningOutcome = candidate
    ? candidate.target_type === "noop" || candidate.target_type === "rejected"
      ? "noop"
      : "accepted"
    : rejectedReasons.length > 0 || validationErrors.length > 0
      ? "rejected"
      : "fallback";
  const auditCandidateId = solidifyAuditCandidateId(candidate, outcome);
  const adaptiveFutureAudit = buildAdaptiveFutureAuditTrail({
    task_class: "cognitive_workflow_change",
    selected_candidate_id: auditCandidateId,
    route: route.layer === "deterministic_fallback" ? "deterministic" : "llm",
    fallback: route.layer === "deterministic_fallback" || outcome === "fallback"
      ? "deterministic_fallback"
      : validationErrors.length > 0
        ? "schema_repair"
        : "none",
    candidates: [
      {
        id: auditCandidateId,
        task_class: "cognitive_workflow_change",
        selected: true,
        score_factors: {
          adr_alignment: candidate && candidate.adr_guard_rail_review.length > 0 && candidate.contradictions.length === 0 ? 0.9 : 0.55,
          workflow_fit: outcome === "accepted" || outcome === "noop" ? 0.85 : 0.45,
          verification_path: candidate && candidate.required_validation.length > 0 ? 0.85 : 0.45,
          graph_sync_impact: candidate && candidate.target_type !== "noop" && candidate.target_type !== "rejected" ? 0.9 : 0.35,
          blast_radius: candidate?.target_type === "adr_candidate" ? 0.65 : candidate ? 0.4 : 0.2,
          evidence_strength: candidate?.confidence ?? 0.35,
        },
        anchors: solidifyAuditAnchors(candidate),
        objections: [
          ...(candidate?.risks ?? []),
          ...(candidate?.contradictions ?? []),
          ...rejectedReasons,
        ],
        validation_failures: validationErrors,
      },
    ],
    notes: [
      `solidify_cognitive_insight outcome=${outcome}`,
      `route_layer=${route.layer}`,
    ],
  });
  return {
    route_layer: route.layer,
    provider: typeof provenance.provider === "string" ? provenance.provider : null,
    model: route.model ?? null,
    ...(temperature !== undefined ? { temperature } : {}),
    llm_calls: llmCalls,
    tokens_used: tokensUsed,
    accepted: outcome === "accepted" || outcome === "noop",
    outcome,
    evidence_anchors: candidate?.evidence_anchors ?? [],
    validation_errors: validationErrors,
    rejected_reasons: rejectedReasons,
    ...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
    adaptive_future_audit: adaptiveFutureAudit,
  };
}

function solidifyAuditCandidateId(
  candidate: SolidifyDurableCandidate | null,
  outcome: SolidifyPlanningOutcome,
): string {
  if (!candidate) {
    return `solidify:${outcome}:deterministic`;
  }
  const suffix = candidate.target_id ?? candidate.relation ?? candidate.target_type;
  return `solidify:${candidate.target_type}:${suffix}`;
}

function solidifyAuditAnchors(candidate: SolidifyDurableCandidate | null): AdaptiveFutureAnchor[] {
  if (!candidate) {
    return [];
  }
  const graphKind: AdaptiveFutureAnchor["kind"] = candidate.target_type === "workflow"
    ? "workflow"
    : candidate.target_type === "data_model_relation"
      ? "data_model"
      : candidate.target_type === "adr_candidate"
        ? "adr"
        : "feature";
  return [
    ...candidate.evidence_anchors.map((id) => ({
      kind: id.includes("/") || id.includes("\\") ? "source" as const : graphKind,
      id,
    })),
    ...candidate.source_ids.map((id) => ({ kind: "feature" as const, id })),
    ...candidate.target_ids.map((id) => ({ kind: graphKind, id })),
  ];
}

async function classifyInsightBeforeMutation(input: SolidifyExplicitInput): Promise<{
  candidate: SolidifyDurableCandidate | null;
  metadata: SolidifyPlanningMetadata;
}> {
  const route = await selectLlmRoute({
    task: "generic",
    daemon_component: "normalizer",
    daemon_temperature: 0.05,
    max_tokens: 1600,
  });
  const rejectedReasons: string[] = [];
  let llmCalls = 0;
  let tokensUsed = 0;

  if (route.layer === "deterministic_fallback" || !route.provider) {
    rejectedReasons.push(
      `ADR-203 route=${route.layer} reason=${route.provenance.fallback_reason ?? "provider_unavailable"}; using explicit deterministic solidification fallback.`,
    );
    return {
      candidate: null,
      metadata: planningMetadata(route, llmCalls, tokensUsed, null, [], rejectedReasons),
    };
  }

  try {
    const context = await loadSolidifyValidationContext(input);
    const response = await route.provider.complete(buildSolidifyClassificationPrompt(input, context), {
      ...route.options,
      maxTokens: Math.min(route.options.maxTokens ?? 1600, 1600),
      jsonSchema: {
        name: "solidify_cognitive_insight_candidate",
        schema: SOLIDIFY_CLASSIFICATION_JSON_SCHEMA,
      },
    });
    llmCalls++;
    tokensUsed += response.tokensUsed ?? 0;

    const parsed = parseSolidifyClassificationDraft(response.text);
    if (parsed.errors.length > 0 || !parsed.candidate) {
      rejectedReasons.push(`Rejected invalid solidification draft: ${parsed.errors.join("; ")}`);
      return {
        candidate: null,
        metadata: planningMetadata(route, llmCalls, tokensUsed, null, parsed.errors, rejectedReasons),
      };
    }

    const validationErrors = validateSolidifyClassificationCandidate(parsed.candidate, context);
    if (validationErrors.length > 0) {
      rejectedReasons.push(`Rejected invalid solidification candidate: ${validationErrors.join("; ")}`);
      return {
        candidate: null,
        metadata: planningMetadata(route, llmCalls, tokensUsed, null, validationErrors, rejectedReasons),
      };
    }

    return {
      candidate: parsed.candidate,
      metadata: planningMetadata(route, llmCalls, tokensUsed, parsed.candidate, [], []),
    };
  } catch (err) {
    rejectedReasons.push(`LLM solidification classification failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      candidate: null,
      metadata: planningMetadata(route, llmCalls, tokensUsed, null, [], rejectedReasons),
    };
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSolidifyInsightTool(server: McpServer): void {
  server.tool(
    "solidify_cognitive_insight",
    "Tallentaa AI:n subjektiivisen oivalluksen koodista kognitiiviseen muistiin. " +
      "Käytä tätä, kun olet lukenut koodia (read_source_code) ja löytänyt uusia " +
      "yhteyksiä, puuttuvia linkkejä tai jännitteitä. Oivallus kulkee normaalin " +
      "unisyklin läpi (decay → normalize → promote). " +
      "EDGE: spekulatiivinen yhteys kahden entiteetin välillä. " +
      "TENSION: riski, puute tai ristiriita koodissa. " +
      "ENTITY: hypoteettinen entiteetti, joka puuttuu tietomallista.",
    {
      insightType: z
        .enum(["EDGE", "TENSION", "ENTITY"])
        .describe(
          "Oivalluksen tyyppi: EDGE (yhteys), TENSION (jännite/riski), ENTITY (puuttuva entiteetti)."
        ),
      sourceNodeId: z
        .string()
        .describe(
          "Lähdesolmun ID faktaverkosta tai unigraafista (esim. 'feature_resend_email', 'data_model_invoice')."
        ),
      targetNodeId: z
        .string()
        .optional()
        .describe(
          "Kohdesolmun ID. Pakollinen EDGE-tyypille, valinnainen muille."
        ),
      relation: z
        .string()
        .optional()
        .describe(
          "Suhteen nimi EDGE-tyypille (esim. 'should_track_delivery_status'). " +
            "Jos ei annettu, generoidaan automaattisesti."
        ),
      rationale: z
        .string()
        .describe(
          "Subjektiivinen perustelu: miksi ja miten koet tämän yhteyden tai jännitteen olevan olemassa? " +
            "Kerro omin sanoin, mitä huomasit koodissa."
        ),
      confidence: z
        .number()
        .min(0)
        .max(1)
        .describe(
          "Luottamustaso (0.0–1.0). Kuinka varma olet oivalluksesta? " +
            "0.3 = spekulatiivinen, 0.6 = todennäköinen, 0.9 = lähes varma."
        ),
      codeReferences: z
        .array(z.string())
        .optional()
        .describe(
          "Polut kooditiedostoihin tai tiettyihin riveihin, joihin oivallus perustuu " +
            "(esim. ['src/server/email/resend_handler.ts:45', 'src/types/delivery.ts'])."
        ),
      tensionLevel: z
        .enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"])
        .optional()
        .describe(
          "Jännitteen vakavuus (vain TENSION-tyypille). HIGH = async-tila epätasapainossa, " +
            "CRITICAL = datahäviön riski."
        ),
      entityName: z
        .string()
        .optional()
        .describe(
          "Hypoteettisen entiteetin nimi (vain ENTITY-tyypille, esim. 'Unified Delivery Status Tracker')."
        ),
      entityDescription: z
        .string()
        .optional()
        .describe(
          "Kuvaus hypoteettisesta entiteetistä (vain ENTITY-tyypille)."
        ),
    },
    async (args) => {
      const {
        insightType,
        sourceNodeId,
        targetNodeId,
        relation,
        rationale,
        confidence,
        codeReferences,
        tensionLevel,
        entityName,
        entityDescription,
      } = args;

      logger.info(
        `solidify_cognitive_insight called: type=${insightType}, ` +
          `source=${sourceNodeId}, target=${targetNodeId ?? "(none)"}, ` +
          `confidence=${confidence}`
      );

      const explicitInput: SolidifyExplicitInput = {
        insightType,
        sourceNodeId,
        targetNodeId,
        relation,
        rationale,
        confidence,
        codeReferences,
        tensionLevel,
        entityName,
        entityDescription,
      };

      const result = await safeExecute<SolidifyResult>(
        async (): Promise<ToolResponse<SolidifyResult>> => {
          const now = new Date().toISOString();
          const cycle = engine.getCurrentDreamCycle();
          const classification = await classifyInsightBeforeMutation(explicitInput);
          const adaptiveCandidate = classification.candidate;
          const planning = classification.metadata;
          const planningFields = {
            adaptive_candidate: adaptiveCandidate,
            planning_metadata: planning,
          };

          if (adaptiveCandidate?.target_type === "noop" || adaptiveCandidate?.target_type === "rejected") {
            return success<SolidifyResult>({
              insightType,
              id: `(adaptive ${adaptiveCandidate.target_type})`,
              target_file: "(none)",
              confidence: adaptiveCandidate.confidence,
              merged: false,
              ...planningFields,
              message:
                `Durable insight solidification skipped: adaptive classifier returned ${adaptiveCandidate.target_type}. ` +
                adaptiveCandidate.rationale,
            });
          }

          // ---------------------------------------------------------------
          // EDGE — Write a DreamEdge to dream_graph.json
          // ---------------------------------------------------------------
          if (insightType === "EDGE") {
            if (!targetNodeId) {
              return error(
                "MISSING_TARGET",
                "EDGE-tyyppi vaatii targetNodeId-parametrin."
              );
            }

            const edgeRelation =
              relation ??
              (adaptiveCandidate?.target_type === "data_model_relation" ? adaptiveCandidate.relation : undefined) ??
              `reflective_${sourceNodeId.replace(/\W+/g, "_")}_${targetNodeId.replace(/\W+/g, "_")}`;

            const edge: DreamEdge = {
              id: insightId("edge"),
              from: sourceNodeId,
              to: targetNodeId,
              type: "hypothetical",
              relation: edgeRelation,
              reason: rationale,
              confidence,
              origin: "rem",
              created_at: now,
              dream_cycle: cycle,
              strategy: "reflective",
              meta: {
                insight_type: "REFLECTIVE_ASSUMPTION",
                code_refs: codeReferences ?? [],
                agent_rationale: rationale,
                ...(adaptiveCandidate ? { solidification_candidate: adaptiveCandidate } : {}),
                ...(tensionLevel
                  ? {
                      triggers_tension: {
                        level: tensionLevel,
                        description: rationale,
                      },
                    }
                  : {}),
              },
              ttl: DEFAULT_DECAY.ttl + 4, // Reflective insights get +4 bonus TTL
              decay_rate: DEFAULT_DECAY.decay_rate,
              reinforcement_count: 0,
              last_reinforced_cycle: cycle,
              status: "candidate",
              activation_score: Math.min(confidence * 0.8, 1.0),
              plausibility: 0,
              evidence_score: 0,
              contradiction_score: 0,
            };

            // Enter REM, write, leave
            const restore = await ensureRem();
            try {
              const { appended, merged } =
                await engine.deduplicateAndAppendEdges([edge]);
              await restore();

              const wasNew = appended.length > 0;
              return success<SolidifyResult>({
                insightType: "EDGE",
                id: wasNew ? edge.id : `(merged into existing)`,
                target_file: "dream_graph.json",
                confidence,
                merged: merged > 0,
                ...planningFields,
                message: wasNew
                  ? `Uusi spekulatiivinen yhteys ${sourceNodeId} → ${targetNodeId} tallennettu unigraafiin. ` +
                    `Se kulkee seuraavan normalisointisyklin läpi.`
                  : `Yhteys ${sourceNodeId} → ${targetNodeId} yhdistetty olemassa olevaan — vahvistus #${merged}.`,
              });
            } catch (err) {
              await restore();
              throw err;
            }
          }

          // ---------------------------------------------------------------
          // TENSION — Write via engine.recordTension()
          // ---------------------------------------------------------------
          if (insightType === "TENSION") {
            const urgencyMap: Record<string, number> = {
              LOW: 0.3,
              MEDIUM: 0.5,
              HIGH: 0.75,
              CRITICAL: 0.95,
            };
            const urgency = urgencyMap[tensionLevel ?? "MEDIUM"] ?? 0.5;

            const entities = targetNodeId
              ? [sourceNodeId, targetNodeId]
              : [sourceNodeId];

            const codeRefStr =
              codeReferences && codeReferences.length > 0
                ? ` (refs: ${codeReferences.join(", ")})`
                : "";

            const tension = await engine.recordTension({
              type: "code_insight",
              entities,
              description: `${rationale}${codeRefStr}`,
              urgency,
            });

            return success<SolidifyResult>({
              insightType: "TENSION",
              id: tension.id,
              target_file: "tension_log.json",
              confidence: urgency,
              merged: tension.occurrences > 1,
              ...planningFields,
              message:
                tension.occurrences > 1
                  ? `Jännite päivitetty: "${tension.id}" (havainto #${tension.occurrences}, urgency ${tension.urgency}).`
                  : `Uusi jännite tallennettu: "${tension.id}" — urgency ${urgency}. ` +
                    `Tension-directed-strategia käsittelee tämän seuraavalla unisyklillä.`,
            });
          }

          // ---------------------------------------------------------------
          // ENTITY — Write a DreamNode to dream_graph.json
          // ---------------------------------------------------------------
          if (insightType === "ENTITY") {
            if (!entityName) {
              return error(
                "MISSING_NAME",
                "ENTITY-tyyppi vaatii entityName-parametrin."
              );
            }

            const node: DreamNode = {
              id: insightId("entity"),
              type: "hypothetical_feature",
              name: entityName,
              description:
                entityDescription ?? rationale,
              ...(adaptiveCandidate ? { intent: adaptiveCandidate.rationale } : {}),
              ...(adaptiveCandidate?.target_type === "feature" ? { category: "feature" as const } : {}),
              ...(adaptiveCandidate?.target_type === "workflow" ? { category: "workflow" as const } : {}),
              ...(adaptiveCandidate?.target_type === "data_model_relation" ? { category: "data_model" as const } : {}),
              inspiration: targetNodeId
                ? [sourceNodeId, targetNodeId]
                : [sourceNodeId],
              confidence,
              origin: "rem",
              created_at: now,
              dream_cycle: cycle,
              ttl: DEFAULT_DECAY.ttl + 4,
              decay_rate: DEFAULT_DECAY.decay_rate,
              reinforcement_count: 0,
              last_reinforced_cycle: cycle,
              status: "candidate",
              activation_score: Math.min(confidence * 0.8, 1.0),
            };

            const restore = await ensureRem();
            try {
              const { appended, merged } =
                await engine.deduplicateAndAppendNodes([node]);
              await restore();

              const wasNew = appended.length > 0;
              return success<SolidifyResult>({
                insightType: "ENTITY",
                id: wasNew ? node.id : `(merged into existing)`,
                target_file: "dream_graph.json",
                confidence,
                merged: merged > 0,
                ...planningFields,
                message: wasNew
                  ? `Hypoteettinen entiteetti "${entityName}" tallennettu unigraafiin.`
                  : `Entiteetti "${entityName}" yhdistetty olemassa olevaan — vahvistus.`,
              });
            } catch (err) {
              await restore();
              throw err;
            }
          }

          return error("INVALID_TYPE", `Tuntematon insightType: ${insightType}`);
        }
      );

      // Safety: always return to AWAKE
      if (engine.getState() !== "awake") {
        await engine.interrupt();
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  logger.info("Registered 1 solidify tool (solidify_cognitive_insight)");
}
