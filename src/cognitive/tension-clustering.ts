import type { TensionSignal } from "./types.js";

export type TensionClusterCause =
  | "duplicate_edge_pressure"
  | "ui_registry_extension_pressure"
  | "derived_hub_pressure"
  | "evidence_gap"
  | "source_defect_candidate";

export type TensionReasonCategory =
  | "duplicate_edge"
  | "insufficient_evidence"
  | "missing_fact_graph_entity"
  | "stale_expired_artifact"
  | "actionable_architecture_gap";

export interface TensionCluster {
  id: string;
  cause: TensionClusterCause;
  reason_category: TensionReasonCategory;
  inspectable_noise: boolean;
  tension_ids: string[];
  entities: string[];
  urgency_range: { min: number; max: number };
  recurrence: number;
  interpretation: string;
  suggested_next_inspection: string;
  resolution_path_candidates: string[];
}

function clusterCause(tension: TensionSignal): TensionClusterCause {
  const text = `${tension.description} ${tension.entities.join(" ")}`.toLowerCase();
  if (/ui[_ -]?registry|extension[_ -]?management|vscode[_ -]?extension/.test(text)) return "ui_registry_extension_pressure";
  if (/derived[_ -]?hub|introspection|security/.test(text)) return "derived_hub_pressure";
  if (/duplicate|already exists|context[_ -]?fetch|webview|prompt/.test(text)) return "duplicate_edge_pressure";
  if (/ungrounded|evidence|unknown entity|missing link|missing entity|not found/.test(text)) return "evidence_gap";
  return "source_defect_candidate";
}

function reasonCategory(tension: TensionSignal, cause: TensionClusterCause): TensionReasonCategory {
  const text = `${tension.description} ${tension.entities.join(" ")}`.toLowerCase();
  if (cause === "duplicate_edge_pressure" || /duplicate|already exists/.test(text)) return "duplicate_edge";
  if (/unknown entity|missing entity|missing fact|not found|invalid endpoint/.test(text)) return "missing_fact_graph_entity";
  if (/expired|stale|ttl|decay|retired/.test(text) || tension.ttl <= 0) return "stale_expired_artifact";
  if (cause === "evidence_gap" || /insufficient|ungrounded|evidence|weak connection|promotion gate/.test(text)) return "insufficient_evidence";
  return "actionable_architecture_gap";
}

function categoryPriority(category: TensionReasonCategory): number {
  return category === "actionable_architecture_gap" ? 0 : 1;
}

function clusterReasonCategory(signals: TensionSignal[], cause: TensionClusterCause): TensionReasonCategory {
  const categories = signals.map((signal) => reasonCategory(signal, cause));
  return categories.includes("actionable_architecture_gap")
    ? "actionable_architecture_gap"
    : categories[0] ?? "insufficient_evidence";
}

const CLUSTER_GUIDANCE: Record<TensionClusterCause, Pick<TensionCluster, "interpretation" | "suggested_next_inspection" | "resolution_path_candidates">> = {
  duplicate_edge_pressure: {
    interpretation: "Repeated graph pressure may be duplicate-edge churn around related semantic anchors rather than a source defect.",
    suggested_next_inspection: "Inspect the highest-recurrence edge pair and confirm whether the entities need a clearer semantic contract or a wont-fix resolution.",
    resolution_path_candidates: ["inspect_evidence", "reframe", "wont_fix"],
  },
  ui_registry_extension_pressure: {
    interpretation: "UI registry and extension-management concepts are repeatedly co-activated and may need a clearer ownership boundary.",
    suggested_next_inspection: "Inspect UI registry anchors and extension-management routes before proposing a source change.",
    resolution_path_candidates: ["inspect_evidence", "mediator", "create_plan_question"],
  },
  derived_hub_pressure: {
    interpretation: "The graph is applying pressure around introspection or derived-hub concepts where provenance must stay explicit.",
    suggested_next_inspection: "Inspect grounded provenance paths and separate derived hubs from source-backed defects.",
    resolution_path_candidates: ["inspect_evidence", "reframe", "propose_adr"],
  },
  evidence_gap: {
    interpretation: "The graph has insufficient grounding for a recurring hypothesis.",
    suggested_next_inspection: "Inspect source evidence and semantic anchors before reinforcing the hypothesis.",
    resolution_path_candidates: ["inspect_evidence", "focused_dream_cycle", "mark_false_positive"],
  },
  source_defect_candidate: {
    interpretation: "This cluster may represent a source-level defect, but requires inspection before mutation.",
    suggested_next_inspection: "Inspect the referenced entities and source-backed evidence before creating a remediation item.",
    resolution_path_candidates: ["inspect_evidence", "create_plan_question", "propose_adr"],
  },
};

export function buildTensionClusters(tensions: TensionSignal[]): TensionCluster[] {
  const grouped = new Map<string, { cause: TensionClusterCause; category: TensionReasonCategory; signals: TensionSignal[] }>();
  for (const tension of tensions.filter((candidate) => !candidate.resolved)) {
    const cause = clusterCause(tension);
    const category = reasonCategory(tension, cause);
    const key = `${cause}:${category}`;
    const existing = grouped.get(key);
    grouped.set(key, { cause, category, signals: [...(existing?.signals ?? []), tension] });
  }

  return [...grouped.values()]
    .map(({ cause, category, signals }) => {
      const urgencies = signals.map((signal) => signal.urgency);
      const guidance = CLUSTER_GUIDANCE[cause];
      return {
        id: `tension-cluster:${cause}:${category}`,
        cause,
        reason_category: category,
        inspectable_noise: category !== "actionable_architecture_gap",
        tension_ids: signals.map((signal) => signal.id).sort(),
        entities: [...new Set(signals.flatMap((signal) => signal.entities))].sort(),
        urgency_range: { min: Math.min(...urgencies), max: Math.max(...urgencies) },
        recurrence: signals.reduce((sum, signal) => sum + Math.max(1, signal.occurrences), 0),
        ...guidance,
      };
    })
    .sort((left, right) => categoryPriority(left.reason_category) - categoryPriority(right.reason_category)
      || right.urgency_range.max - left.urgency_range.max
      || right.recurrence - left.recurrence
      || left.id.localeCompare(right.id));
}
