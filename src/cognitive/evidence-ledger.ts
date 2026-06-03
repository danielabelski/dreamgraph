import type { ValidatedEdge, ValidationEvidence, ValidationResult } from "./types.js";
import type { CognitiveTrustDescriptor } from "./trust-state.js";

export type EvidenceSourceClass =
  | "adr"
  | "source_entity"
  | "workflow"
  | "test"
  | "runtime_observation"
  | "model_output"
  | "human_review";

export interface EvidenceLedgerEntry {
  id: string;
  source_class: EvidenceSourceClass;
  summary: string;
  semantic_anchor: string;
  optional_hints: string[];
}

export interface EvidenceLedger {
  claim_id: string;
  claim_type: "candidate" | "validated_edge" | "tension" | "future" | "remediation_step";
  trust: CognitiveTrustDescriptor;
  semantic_anchors: string[];
  grouped_evidence: Record<EvidenceSourceClass, EvidenceLedgerEntry[]>;
  validation: {
    status: string;
    reason_code: string | null;
    reason: string | null;
    evidence_count: number;
  };
  provenance: {
    model: string | null;
    strategy: string | null;
    normalization_cycle: number | null;
    fallback_reason: string | null;
  };
  review: {
    reviewed: boolean;
    state: "unreviewed" | "human_reviewed" | "superseded" | "rejected" | "expired";
  };
}

const SOURCE_CLASSES: readonly EvidenceSourceClass[] = [
  "adr",
  "source_entity",
  "workflow",
  "test",
  "runtime_observation",
  "model_output",
  "human_review",
] as const;

export function emptyEvidenceGroups(): Record<EvidenceSourceClass, EvidenceLedgerEntry[]> {
  return {
    adr: [],
    source_entity: [],
    workflow: [],
    test: [],
    runtime_observation: [],
    model_output: [],
    human_review: [],
  };
}

function pushEntry(
  groups: Record<EvidenceSourceClass, EvidenceLedgerEntry[]>,
  entry: EvidenceLedgerEntry,
): void {
  groups[entry.source_class].push(entry);
}

function anchorsFromValidationEvidence(evidence: ValidationEvidence): string[] {
  return [
    ...evidence.shared_entities,
    ...evidence.shared_workflows.map((workflow) => `workflow:${workflow}`),
    ...evidence.domain_overlap.map((domain) => `domain:${domain}`),
    ...evidence.keyword_overlap.map((keyword) => `keyword:${keyword}`),
  ];
}

function reviewState(status: string): EvidenceLedger["review"]["state"] {
  if (status === "rejected") return "rejected";
  if (status === "expired") return "expired";
  return "unreviewed";
}

export function buildCandidateEvidenceLedger(args: {
  result: ValidationResult;
  trust: CognitiveTrustDescriptor;
  model?: string | null;
  fallbackReason?: string | null;
}): EvidenceLedger {
  const groups = emptyEvidenceGroups();
  const evidence = args.result.evidence;

  for (const entity of evidence.shared_entities) {
    pushEntry(groups, {
      id: `${args.result.dream_id}:entity:${entity}`,
      source_class: "source_entity",
      summary: "Shared fact-graph entity used as semantic validation evidence.",
      semantic_anchor: entity,
      optional_hints: [],
    });
  }
  for (const workflow of evidence.shared_workflows) {
    pushEntry(groups, {
      id: `${args.result.dream_id}:workflow:${workflow}`,
      source_class: "workflow",
      summary: "Workflow overlap used as semantic validation evidence.",
      semantic_anchor: workflow,
      optional_hints: [],
    });
  }
  if (evidence.source_repo_match) {
    pushEntry(groups, {
      id: `${args.result.dream_id}:runtime:source-repo-match`,
      source_class: "runtime_observation",
      summary: "Candidate endpoints share source repository provenance.",
      semantic_anchor: "validation.evidence.source_repo_match",
      optional_hints: [],
    });
  }
  pushEntry(groups, {
    id: `${args.result.dream_id}:model:${args.result.normalization_cycle}`,
    source_class: "model_output",
    summary: args.result.reason,
    semantic_anchor: args.result.reason_code,
    optional_hints: [
      `confidence:${args.result.confidence}`,
      `plausibility:${args.result.plausibility}`,
      `evidence_score:${args.result.evidence_score}`,
      `contradiction_score:${args.result.contradiction_score}`,
    ],
  });

  return {
    claim_id: args.result.dream_id,
    claim_type: "candidate",
    trust: args.trust,
    semantic_anchors: anchorsFromValidationEvidence(evidence),
    grouped_evidence: groups,
    validation: {
      status: args.result.status,
      reason_code: args.result.reason_code,
      reason: args.result.reason,
      evidence_count: args.result.evidence_count,
    },
    provenance: {
      model: args.model ?? null,
      strategy: args.result.strategy ?? null,
      normalization_cycle: args.result.normalization_cycle,
      fallback_reason: args.fallbackReason ?? null,
    },
    review: {
      reviewed: false,
      state: reviewState(args.result.status),
    },
  };
}

export function buildValidatedEdgeEvidenceLedger(args: {
  edge: ValidatedEdge;
  trust: CognitiveTrustDescriptor;
  model?: string | null;
}): EvidenceLedger {
  const groups = emptyEvidenceGroups();
  pushEntry(groups, {
    id: `${args.edge.id}:model:${args.edge.normalization_cycle}`,
    source_class: "model_output",
    summary: args.edge.evidence_summary,
    semantic_anchor: args.edge.relation,
    optional_hints: [
      `from:${args.edge.from}`,
      `to:${args.edge.to}`,
      `confidence:${args.edge.confidence}`,
      `evidence_score:${args.edge.evidence_score}`,
    ],
  });
  pushEntry(groups, {
    id: `${args.edge.id}:runtime:normalization-cycle`,
    source_class: "runtime_observation",
    summary: "Validated during normalization and promoted to fact-adjacent cognitive space.",
    semantic_anchor: `normalization_cycle:${args.edge.normalization_cycle}`,
    optional_hints: [`dream_cycle:${args.edge.dream_cycle}`],
  });

  return {
    claim_id: args.edge.id,
    claim_type: "validated_edge",
    trust: args.trust,
    semantic_anchors: [args.edge.from, args.edge.to, args.edge.relation],
    grouped_evidence: groups,
    validation: {
      status: args.edge.status,
      reason_code: null,
      reason: args.edge.evidence_summary,
      evidence_count: args.edge.evidence_count,
    },
    provenance: {
      model: args.model ?? null,
      strategy: args.edge.strategy ?? null,
      normalization_cycle: args.edge.normalization_cycle,
      fallback_reason: null,
    },
    review: {
      reviewed: false,
      state: "unreviewed",
    },
  };
}

export function evidenceGroupsWithEntries(ledger: EvidenceLedger): EvidenceSourceClass[] {
  return SOURCE_CLASSES.filter((sourceClass) => ledger.grouped_evidence[sourceClass].length > 0);
}
