import { describe, expect, it } from "vitest";
import { buildArchitectDesireLedger } from "../src/architect/desire-ledger.js";
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
  it("clusters duplicate-edge, UI registry, and derived-hub pressure separately", () => {
    const clusters = buildTensionClusters([
      tension("duplicate", "duplicate context fetcher versus webview prompt pressure"),
      tension("ui", "UI registry versus extension management pressure"),
      tension("hub", "cognitive security introspection derived hub pressure"),
    ]);

    expect(clusters.map((cluster) => cluster.cause)).toEqual(expect.arrayContaining([
      "duplicate_edge_pressure", "ui_registry_extension_pressure", "derived_hub_pressure",
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
      }] },
      validated: { metadata: { description: "", schema_version: "1", last_validation: null, total_validated: 1, created_at: "" }, edges: [{
        id: "promoted", from: "a", to: "b", type: "feature", relation: "supports", description: "", confidence: 0.9, plausibility: 0.9, evidence_score: 0.9,
        origin: "rem", status: "validated", evidence_summary: "", evidence_count: 2, reinforcement_count: 1, dream_cycle: 3, normalization_cycle: 3, validated_at: "",
      }] },
      tensions: { metadata: { description: "", schema_version: "1", total_signals: 1, total_resolved: 0, last_updated: null }, signals: [tension("new-tension", "evidence gap")], resolved_tensions: [] },
    });

    expect(playback.cycle_id).toBe("cycle-3");
    expect(playback.promoted_edges).toHaveLength(1);
    expect(playback.rejected_by_reason.insufficient_evidence).toBe(1);
    expect(playback.frames.map((frame) => frame.stage)).toEqual(["seed", "hypotheses", "validation", "promotions_rejections", "tensions_story_delta"]);
  });
});
