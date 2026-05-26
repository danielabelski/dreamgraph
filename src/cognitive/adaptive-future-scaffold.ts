export const ADAPTIVE_FUTURE_SLICE12_AUDIT_VERSION = "slice12-scaffold-v1" as const;

export const ADAPTIVE_FUTURE_TASK_CLASSES = [
  "remediation",
  "planning_doc",
  "adapter_change",
  "graph_tool_change",
  "cognitive_workflow_change",
] as const;

export type AdaptiveFutureTaskClass = (typeof ADAPTIVE_FUTURE_TASK_CLASSES)[number];

export type AdaptiveFutureAnchorKind =
  | "adr"
  | "workflow"
  | "feature"
  | "data_model"
  | "api_surface"
  | "source"
  | "test"
  | "plan";

export type AdaptiveFutureRoute = "llm" | "deterministic" | "graph" | "manual_review";

export type AdaptiveFutureFallback =
  | "none"
  | "deterministic_fallback"
  | "schema_repair"
  | "manual_hold";

export interface AdaptiveFutureAnchor {
  kind: AdaptiveFutureAnchorKind;
  id: string;
  label?: string;
  source_file?: string;
  excerpt?: string;
}

export interface AdaptiveFutureScoreFactors {
  adr_alignment: number;
  workflow_fit: number;
  verification_path: number;
  graph_sync_impact: number;
  blast_radius: number;
  evidence_strength: number;
}

export interface AdaptiveFutureCandidateAudit {
  id: string;
  task_class: AdaptiveFutureTaskClass;
  score: number;
  score_factors: AdaptiveFutureScoreFactors;
  anchors: readonly AdaptiveFutureAnchor[];
  objections: readonly string[];
  validation_failures: readonly string[];
  selected: boolean;
}

export interface AdaptiveFutureCandidateAuditInput {
  id: string;
  task_class: AdaptiveFutureTaskClass;
  score?: number;
  score_factors?: Partial<AdaptiveFutureScoreFactors>;
  anchors?: readonly AdaptiveFutureAnchor[];
  objections?: readonly string[];
  validation_failures?: readonly string[];
  selected?: boolean;
}

export interface AdaptiveFutureAuditTrail {
  audit_version: typeof ADAPTIVE_FUTURE_SLICE12_AUDIT_VERSION;
  task_class: AdaptiveFutureTaskClass;
  selected_candidate_id?: string;
  rejected_candidate_ids: readonly string[];
  candidates: readonly AdaptiveFutureCandidateAudit[];
  route: AdaptiveFutureRoute;
  fallback: AdaptiveFutureFallback;
  notes: readonly string[];
}

export interface AdaptiveFutureAuditTrailInput {
  task_class: AdaptiveFutureTaskClass;
  candidates: readonly AdaptiveFutureCandidateAuditInput[];
  selected_candidate_id?: string;
  route?: AdaptiveFutureRoute;
  fallback?: AdaptiveFutureFallback;
  notes?: readonly string[];
}

export interface AdaptiveFutureTaskContext {
  task_summary?: string;
  file_path?: string;
  tool_name?: string;
}

export function inferAdaptiveFutureTaskClass(context: AdaptiveFutureTaskContext): AdaptiveFutureTaskClass {
  const path = (context.file_path ?? "").replace(/\\/g, "/").toLowerCase();
  const task = `${context.task_summary ?? ""} ${context.tool_name ?? ""}`.toLowerCase();
  const combined = `${path} ${task}`;
  if (path.endsWith(".md") || path.startsWith("plans/") || path.startsWith("docs/") || /planning|markdown|release notes/.test(task)) {
    return "planning_doc";
  }
  if (/adapter|provider|copilot|architect-cli/.test(combined) || path.includes("/adapters/")) {
    return "adapter_change";
  }
  if (/graph[-_ ]?tool|mcp tool|enrich_parser_nodes|wire_links|query_resource/.test(combined) || path.startsWith("src/tools/")) {
    return "graph_tool_change";
  }
  if (/cognitive workflow|dream_cycle|solidify_cognitive_insight|normaliz|rem\b/.test(combined) || path.startsWith("src/cognitive/")) {
    return "cognitive_workflow_change";
  }
  return "remediation";
}

export function isAdaptiveFutureTaskClass(value: string): value is AdaptiveFutureTaskClass {
  return (ADAPTIVE_FUTURE_TASK_CLASSES as readonly string[]).includes(value);
}

export function normalizeAdaptiveFutureScoreFactors(
  factors: Partial<AdaptiveFutureScoreFactors> = {},
): AdaptiveFutureScoreFactors {
  return {
    adr_alignment: clampScore(factors.adr_alignment ?? 0),
    workflow_fit: clampScore(factors.workflow_fit ?? 0),
    verification_path: clampScore(factors.verification_path ?? 0),
    graph_sync_impact: clampScore(factors.graph_sync_impact ?? 0),
    blast_radius: clampScore(factors.blast_radius ?? 0.5),
    evidence_strength: clampScore(factors.evidence_strength ?? 0),
  };
}

export function scoreAdaptiveFutureAuditFactors(
  factors: Partial<AdaptiveFutureScoreFactors> = {},
): number {
  const normalized = normalizeAdaptiveFutureScoreFactors(factors);
  return clampScore(
    normalized.adr_alignment * 0.25 +
      normalized.workflow_fit * 0.18 +
      normalized.verification_path * 0.18 +
      normalized.graph_sync_impact * 0.16 +
      normalized.evidence_strength * 0.18 +
      (1 - normalized.blast_radius) * 0.05,
  );
}

export function createAdaptiveFutureAuditCandidate(
  input: AdaptiveFutureCandidateAuditInput,
): AdaptiveFutureCandidateAudit {
  const scoreFactors = normalizeAdaptiveFutureScoreFactors(input.score_factors);
  return {
    id: input.id,
    task_class: input.task_class,
    score: clampScore(input.score ?? scoreAdaptiveFutureAuditFactors(scoreFactors)),
    score_factors: scoreFactors,
    anchors: compactAnchors(input.anchors),
    objections: compactStringList(input.objections),
    validation_failures: compactStringList(input.validation_failures),
    selected: input.selected ?? false,
  };
}

export function buildAdaptiveFutureAuditTrail(
  input: AdaptiveFutureAuditTrailInput,
): AdaptiveFutureAuditTrail {
  const candidates = input.candidates
    .map(createAdaptiveFutureAuditCandidate)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  const selectedCandidateId =
    input.selected_candidate_id ?? candidates.find((candidate) => candidate.selected)?.id ?? candidates[0]?.id;
  const markedCandidates = candidates.map((candidate) => ({
    ...candidate,
    selected: selectedCandidateId === candidate.id,
  }));
  const trail: AdaptiveFutureAuditTrail = {
    audit_version: ADAPTIVE_FUTURE_SLICE12_AUDIT_VERSION,
    task_class: input.task_class,
    rejected_candidate_ids: markedCandidates
      .filter((candidate) => candidate.id !== selectedCandidateId)
      .map((candidate) => candidate.id),
    candidates: markedCandidates,
    route: input.route ?? "deterministic",
    fallback: input.fallback ?? "none",
    notes: compactStringList(input.notes, 6),
  };
  if (selectedCandidateId) {
    trail.selected_candidate_id = selectedCandidateId;
  }
  return trail;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}

function compactStringList(values: readonly string[] = [], maxItems = 8): string[] {
  const seen = new Set<string>();
  const compacted: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    compacted.push(normalized);
    seen.add(normalized);
    if (compacted.length >= maxItems) {
      break;
    }
  }
  return compacted;
}

function compactAnchors(anchors: readonly AdaptiveFutureAnchor[] = []): AdaptiveFutureAnchor[] {
  const seen = new Set<string>();
  const compacted: AdaptiveFutureAnchor[] = [];
  for (const anchor of anchors) {
    const key = `${anchor.kind}:${anchor.id}`;
    if (!anchor.id.trim() || seen.has(key)) {
      continue;
    }
    compacted.push(anchor);
    seen.add(key);
    if (compacted.length >= 12) {
      break;
    }
  }
  return compacted;
}
