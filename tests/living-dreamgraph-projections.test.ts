import { describe, expect, it } from "vitest";
import { buildArchitectDesireLedger } from "../src/architect/desire-ledger.js";
import { buildCalibrationEvaluation } from "../src/cognitive/calibration-evaluation.js";
import { buildCognitiveLifecycleProjection } from "../src/cognitive/lifecycle-visibility.js";
import { buildDreamPlayback } from "../src/cognitive/playback.js";
import { buildTensionClusters } from "../src/cognitive/tension-clustering.js";

const tension = (id: string, description: string, entities: string[] = [], urgency = 0.8, occurrences = 2) => ({
  id, type: "weak_connection" as const, domain: "general" as const, entities, description, occurrences, urgency,
  first_seen: "2026-05-31T00:00:00.000Z", last_seen: "2026-05-31T00:00:00.000Z", attempted: false, resolved: false, ttl: 3,
});

const cognitive = {
  current_state: "awake" as const,
  last_state_change: "2026-05-31T00:00:00.000Z",
  total_dream_cycles: 3,
  total_normalization_cycles: 3,
  dream_graph_stats: { total_nodes: 1, total_edges: 1, latent_edges: 1, latent_nodes: 0, expiring_next_cycle: 2, avg_confidence: 0.5, avg_reinforcement: 1, avg_activation: 0.2 },
  validated_stats: { validated: 1, latent: 1, rejected: 1 },
  tension_stats: { total: 1, unresolved: 1, top_urgency: tension("t1", "duplicate context fetcher webview pressure") },
  last_dream_cycle: null,
  last_normalization: null,
  promotion_config: { promotion_confidence: 0.7, promotion_plausibility: 0.4, promotion_evidence: 0.35, promotion_evidence_count: 2, retention_plausibility: 0.3, max_contradiction: 0.35 },
  decay_config: { ttl: 3, decay_rate: 0.1 },
};

describe("Living DreamGraph projections", () => {
  it("clusters duplicate-edge, noise categories, and actionable architecture gaps separately", () => {
    const clusters = buildTensionClusters([
      tension("duplicate", "duplicate context fetcher versus webview prompt pressure", [], 0.99),
      tension("missing", "unknown entity missing fact graph anchor", [], 0.98),
      tension("stale", "expired artifact ttl decay pressure", [], 0.97, 2),
      tension("evidence", "insufficient evidence weak connection", [], 0.96),
      tension("actionable", "source route boundary lacks governed review gate", ["src/architect/routes.ts"], 0.70),
      tension("ui", "UI registry versus extension management pressure"),
      tension("hub", "cognitive security introspection derived hub pressure"),
    ]);

    expect(clusters[0]?.reason_category).toBe("actionable_architecture_gap");
    expect(clusters[0]?.inspectable_noise).toBe(false);
    expect(clusters.map((cluster) => cluster.cause)).toEqual(expect.arrayContaining([
      "duplicate_edge_pressure", "ui_registry_extension_pressure", "derived_hub_pressure",
    ]));
    expect(clusters.map((cluster) => cluster.reason_category)).toEqual(expect.arrayContaining([
      "duplicate_edge", "insufficient_evidence", "missing_fact_graph_entity", "stale_expired_artifact", "actionable_architecture_gap",
    ]));
  });

  it("projects inspectable desires without enabling mutation controls", () => {
    const clusters = buildTensionClusters([tension("duplicate", "duplicate context fetcher versus webview prompt pressure")]);
    const ledger = buildArchitectDesireLedger({ cognitive, clusters, plan: null, generatedAt: "2026-05-31T00:00:00.000Z" });

    expect(ledger.mutation_controls_enabled).toBe(false);
    expect(ledger.authority_constraint).toContain("never override ADRs");
    expect(ledger.desires.map((desire) => desire.id)).toContain("preserve-governed-authority");
    expect(ledger.desires.map((desire) => desire.id)).toContain("resolve-duplicate_edge_pressure");
  });

  it("reports calibration metrics without treating uncertainty as failure", () => {
    const evaluation = buildCalibrationEvaluation({
      generatedAt: "2026-06-03T00:00:00.000Z",
      history: { metadata: { description: "", schema_version: "1", total_sessions: 1, created_at: "" }, sessions: [{
        session_id: "cycle-3", cycle_number: 3, timestamp: "2026-05-31T00:00:00.000Z", strategy: "all", duration_ms: 10,
        generated_edges: 0, generated_nodes: 0, duplicates_merged: 0, decayed_edges: 1, decayed_nodes: 0,
        normalization: { validated: 0, latent: 1, rejected: 1, promoted: 0, blocked_by_gate: 0 },
        tension_signals_created: 0, tension_signals_resolved: 0, tensions_expired: 1, tensions_decayed: 0,
      }] },
      dreamGraph: { metadata: { description: "", schema_version: "1", last_dream_cycle: null, total_cycles: 3, last_normalization: null, total_normalization_cycles: 3, created_at: "" }, nodes: [], edges: [] },
      candidates: { metadata: { description: "", schema_version: "1", last_normalization: null, total_cycles: 3, created_at: "" }, results: [{
        dream_id: "latent", dream_type: "edge", status: "latent", confidence: 0.5, plausibility: 0.5, evidence_score: 0.2, contradiction_score: 0,
        evidence: { shared_entities: ["feature:a"], shared_workflows: [], domain_overlap: [], keyword_overlap: [], source_repo_match: false, contradictions: [] }, evidence_count: 1,
        reason_code: "insufficient_evidence", reason: "retained for review", validated_at: "", normalization_cycle: 3,
      }, {
        dream_id: "rejected", dream_type: "edge", status: "rejected", confidence: 0.1, plausibility: 0.1, evidence_score: 0, contradiction_score: 0,
        evidence: { shared_entities: [], shared_workflows: [], domain_overlap: [], keyword_overlap: [], source_repo_match: false, contradictions: [] }, evidence_count: 0,
        reason_code: "low_signal", reason: "too weak", validated_at: "", normalization_cycle: 3,
      }] },
      validated: { metadata: { description: "", schema_version: "1", last_validation: null, total_validated: 0, created_at: "" }, edges: [] },
      tensions: { metadata: { description: "", schema_version: "1", total_signals: 1, total_resolved: 1, last_updated: null }, signals: [tension("duplicate", "duplicate edge pressure")], resolved_tensions: [{
        tension_id: "reviewed", resolved_at: "2026-06-01T00:00:00.000Z", resolved_by: "human", resolution_type: "false_positive", evidence: "reviewed", original: tension("reviewed", "old"),
      }] },
    });

    expect(evaluation.metrics.trust_state_distribution.latent_speculative_link).toBe(1);
    expect(evaluation.metrics.trust_state_distribution.rejected_link).toBe(1);
    expect(evaluation.metrics.speculative_reviewability.latent_candidates_reviewable).toBe(1);
    expect(evaluation.metrics.operator_review_outcomes.human_reviewed_tensions).toBe(1);
  });

  it("explains superseded futures, retired tensions, and expired cognitive artifacts", () => {
    const projection = buildCognitiveLifecycleProjection({
      generatedAt: "2026-06-03T00:00:00.000Z",
      remediationHistory: [{
        id: "future-old", tension_id: "tension-old", title: "Old future", severity: "medium", intervention_type: "graph_enrichment",
        steps: [], adr_conflicts: [], new_tensions_predicted: [], confidence: 0.5,
        adaptive_future_review: { summary: "newer ADR state superseded the old path", weakened_signal_ids: [], superseded_signal_ids: ["signal-old"], evidence_anchor_ids: ["ADR-214"] },
        generated_at: "2026-06-01T00:00:00.000Z", superseded_by: "future-new",
      }],
      resolvedTensions: [{
        tension_id: "retired-tension", resolved_at: "2026-06-02T00:00:00.000Z", resolved_by: "human", resolution_type: "wont_fix",
        evidence: "Operator retired this as non-actionable after review.", original: tension("retired-tension", "old pressure"),
      }],
      dreamHistory: [{
        session_id: "cycle-expiry", cycle_number: 7, timestamp: "2026-06-03T00:00:00.000Z", strategy: "all", duration_ms: 1,
        generated_edges: 0, generated_nodes: 0, duplicates_merged: 0, decayed_edges: 1, decayed_nodes: 1,
        normalization: { validated: 0, latent: 0, rejected: 0, promoted: 0, blocked_by_gate: 0 },
        tension_signals_created: 0, tension_signals_resolved: 0, tensions_expired: 1, tensions_decayed: 0,
      }],
    });

    expect(projection.transitions.map((entry) => `${entry.artifact_kind}:${entry.new_state}`)).toEqual(expect.arrayContaining([
      "future:superseded", "tension:retired", "insight:expired", "narrative:expired",
    ]));
    expect(projection.transitions.find((entry) => entry.artifact_id === "future-old")?.superseding_artifact).toBe("future-new");
    expect(projection.transitions.find((entry) => entry.artifact_id === "retired-tension")?.authority).toBe("human");
  });

  it("builds recent dream playback and groups rejected hypotheses by reason", () => {
    const playback = buildDreamPlayback({
      history: { metadata: { description: "", schema_version: "1", total_sessions: 1, created_at: "" }, sessions: [{
        session_id: "cycle-3", cycle_number: 3, timestamp: "2026-05-31T00:00:00.000Z", strategy: "all", duration_ms: 10,
        generated_edges: 2, generated_nodes: 0, duplicates_merged: 1, decayed_edges: 0, decayed_nodes: 0,
        normalization: { validated: 1, latent: 0, rejected: 1, promoted: 1, blocked_by_gate: 0 },
        tension_signals_created: 1, tension_signals_resolved: 0, tensions_expired: 0, tensions_decayed: 0,
      }] },
      dreamGraph: { metadata: { description: "", schema_version: "1", last_dream_cycle: null, total_cycles: 3, last_normalization: null, total_normalization_cycles: 3, created_at: "" }, nodes: [], edges: [] },
      candidates: { metadata: { description: "", schema_version: "1", last_normalization: null, total_cycles: 3, created_at: "" }, results: [{
        dream_id: "rejected", dream_type: "edge", status: "rejected", confidence: 0.2, plausibility: 0.2, evidence_score: 0.1, contradiction_score: 0,
        evidence: { shared_entities: [], shared_workflows: [], domain_overlap: [], keyword_overlap: [], source_repo_match: false, contradictions: [] }, evidence_count: 0,
        reason_code: "insufficient_evidence", reason: "promotion gate lacks evidence", validated_at: "", normalization_cycle: 3,
      }, {
        dream_id: "latent", dream_type: "edge", status: "latent", confidence: 0.5, plausibility: 0.5, evidence_score: 0.2, contradiction_score: 0,
        evidence: { shared_entities: [], shared_workflows: [], domain_overlap: [], keyword_overlap: [], source_repo_match: false, contradictions: [] }, evidence_count: 1,
        reason_code: "insufficient_evidence", reason: "retained as plausible but not grounded", validated_at: "", normalization_cycle: 3,
      }] },
      validated: { metadata: { description: "", schema_version: "1", last_validation: null, total_validated: 1, created_at: "" }, edges: [{
        id: "promoted", from: "a", to: "b", type: "feature", relation: "supports", description: "", confidence: 0.9, plausibility: 0.9, evidence_score: 0.9,
        origin: "rem", status: "validated", evidence_summary: "", evidence_count: 2, reinforcement_count: 1, dream_cycle: 3, normalization_cycle: 3, validated_at: "",
      }] },
      tensions: { metadata: { description: "", schema_version: "1", total_signals: 1, total_resolved: 0, last_updated: null }, signals: [tension("new-tension", "evidence gap")], resolved_tensions: [] },
    });

    expect(playback.cycle_id).toBe("cycle-3");
    expect(playback.promoted_edges).toHaveLength(1);
    expect(playback.promoted_edges[0]?.trust.state).toBe("validated_insight");
    expect(playback.promoted_edges[0]?.evidence_ledger.grouped_evidence.model_output).toHaveLength(1);
    expect(playback.promoted_edges[0]?.evidence_ledger.semantic_anchors).toEqual(["a", "b", "supports"]);
    expect(playback.rejected_by_reason.insufficient_evidence).toBe(1);
    expect(playback.hypothesis_trust.map((entry) => entry.trust.state)).toEqual(expect.arrayContaining([
      "rejected_link", "latent_speculative_link",
    ]));
    expect(playback.hypothesis_trust[0]?.evidence_ledger.grouped_evidence.model_output[0]?.semantic_anchor).toBe("insufficient_evidence");
    expect(playback.frames.map((frame) => frame.stage)).toEqual(["seed", "hypotheses", "validation", "promotions_rejections", "tensions_story_delta"]);
  });
});
