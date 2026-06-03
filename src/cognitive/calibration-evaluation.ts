import { buildCognitiveLifecycleProjection } from "./lifecycle-visibility.js";
import { buildTensionClusters } from "./tension-clustering.js";
import { emptyTrustStateDistribution, addTrustStateCount, trustStateFromDreamStatus, type TrustStateDistribution } from "./trust-state.js";
import type { CandidateEdgesFile, DreamGraphFile, DreamHistoryFile, TensionFile, ValidatedEdgesFile } from "./types.js";

export interface CognitiveCalibrationEvaluation {
  generated_at: string;
  metrics: {
    trust_state_distribution: TrustStateDistribution;
    evidence_completeness: {
      candidates_with_evidence: number;
      candidates_total: number;
      promoted_edges_with_evidence: number;
      promoted_edges_total: number;
    };
    stale_expired_artifact_rate: number;
    uncertainty_labeling: {
      latent_candidates: number;
      rejected_candidates: number;
      unresolved_tensions: number;
    };
    lifecycle_transition_explainability: {
      explained_transitions: number;
      transitions_total: number;
    };
    operator_review_outcomes: {
      human_reviewed_tensions: number;
      system_reviewed_tensions: number;
      superseded_futures: number;
    };
    speculative_reviewability: {
      latent_candidates_reviewable: number;
      rejected_candidates_reviewable: number;
    };
  };
  interpretation: string;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

export function buildCalibrationEvaluation(input: {
  candidates: CandidateEdgesFile;
  validated: ValidatedEdgesFile;
  tensions: TensionFile;
  dreamGraph: DreamGraphFile;
  history: DreamHistoryFile;
  generatedAt?: string;
}): CognitiveCalibrationEvaluation {
  const distribution = emptyTrustStateDistribution();
  for (const result of input.candidates.results) {
    addTrustStateCount(distribution, trustStateFromDreamStatus(result.status));
  }
  addTrustStateCount(distribution, "validated_insight", input.validated.edges.length);
  addTrustStateCount(distribution, "latent_speculative_link", input.dreamGraph.edges.filter((edge) => edge.status === "latent").length);
  addTrustStateCount(distribution, "expired_artifact", input.history.sessions.reduce((sum, session) => sum + session.tensions_expired + session.decayed_edges + session.decayed_nodes, 0));
  addTrustStateCount(distribution, "human_reviewed_decision", input.tensions.resolved_tensions.filter((entry) => entry.resolved_by === "human").length);

  const clusters = buildTensionClusters(input.tensions.signals);
  const lifecycle = buildCognitiveLifecycleProjection({ resolvedTensions: input.tensions.resolved_tensions, dreamHistory: input.history.sessions });
  const explainedTransitions = lifecycle.transitions.filter((transition) => transition.triggering_evidence.length > 0 && transition.source.length > 0).length;
  const candidateEvidence = input.candidates.results.filter((result) => result.evidence_count > 0 || result.reason.length > 0).length;
  const promotedEvidence = input.validated.edges.filter((edge) => edge.evidence_count > 0 || edge.evidence_summary.length > 0).length;
  const expiredCount = distribution.expired_artifact;
  const totalArtifacts = input.candidates.results.length + input.validated.edges.length + input.dreamGraph.edges.length + input.dreamGraph.nodes.length + expiredCount;

  return {
    generated_at: input.generatedAt ?? new Date().toISOString(),
    metrics: {
      trust_state_distribution: distribution,
      evidence_completeness: {
        candidates_with_evidence: candidateEvidence,
        candidates_total: input.candidates.results.length,
        promoted_edges_with_evidence: promotedEvidence,
        promoted_edges_total: input.validated.edges.length,
      },
      stale_expired_artifact_rate: ratio(expiredCount, totalArtifacts),
      uncertainty_labeling: {
        latent_candidates: input.candidates.results.filter((result) => result.status === "latent").length,
        rejected_candidates: input.candidates.results.filter((result) => result.status === "rejected").length,
        unresolved_tensions: input.tensions.signals.filter((signal) => !signal.resolved).length,
      },
      lifecycle_transition_explainability: {
        explained_transitions: explainedTransitions,
        transitions_total: lifecycle.transitions.length,
      },
      operator_review_outcomes: {
        human_reviewed_tensions: input.tensions.resolved_tensions.filter((entry) => entry.resolved_by === "human").length,
        system_reviewed_tensions: input.tensions.resolved_tensions.filter((entry) => entry.resolved_by === "system").length,
        superseded_futures: 0,
      },
      speculative_reviewability: {
        latent_candidates_reviewable: distribution.latent_speculative_link,
        rejected_candidates_reviewable: distribution.rejected_link,
      },
    },
    interpretation: clusters.some((cluster) => cluster.inspectable_noise)
      ? "Calibration preserves inspectable uncertainty while separating actionable tension clusters from noise categories."
      : "Calibration currently has little recorded noise pressure; uncertainty remains visible through trust-state distribution.",
  };
}
