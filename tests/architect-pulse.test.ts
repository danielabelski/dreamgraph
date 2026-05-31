import { describe, expect, it } from "vitest";
import type { CognitiveState } from "../src/cognitive/types.js";
import { buildArchitectPulseSnapshot, deriveCognitiveWeather, formatArchitectPulseLine } from "../src/architect/pulse.js";
import type { ArchitectOperationalPlanState } from "../src/architect/plan-registry.js";

function cognitive(overrides: Partial<CognitiveState> = {}): CognitiveState {
  return {
    current_state: "awake",
    last_state_change: "2026-05-31T00:00:00.000Z",
    total_dream_cycles: 1,
    total_normalization_cycles: 1,
    dream_graph_stats: {
      total_nodes: 4,
      total_edges: 3,
      latent_edges: 0,
      latent_nodes: 0,
      expiring_next_cycle: 0,
      avg_confidence: 0.8,
      avg_reinforcement: 2,
      avg_activation: 0,
    },
    validated_stats: { validated: 10, latent: 0, rejected: 1 },
    tension_stats: { total: 0, unresolved: 0, top_urgency: null },
    last_dream_cycle: null,
    last_normalization: null,
    promotion_config: {
      promotion_confidence: 0.55,
      promotion_plausibility: 0.4,
      promotion_evidence: 0.35,
      promotion_evidence_count: 1,
      retention_plausibility: 0.3,
      max_contradiction: 0.35,
    },
    decay_config: { ttl: 8, decay_rate: 0.05 },
    llm: { provider: "openai", model: "test", available: true },
    ...overrides,
  };
}

const runtime = {
  pass_state: { status: "idle" },
  provenance_authority: "dreamgraph_mcp",
};

function plan(execution: ArchitectOperationalPlanState["execution_state"] = "idle"): { id: string; title: string; operational_state: ArchitectOperationalPlanState } {
  return {
    id: "living-dreamgraph",
    title: "Living DreamGraph",
    operational_state: {
      source: "implementation_log_projection",
      phase: null,
      active_phase: null,
      current_slice_id: "slice-a",
      current_slice_title: "Slice A",
      current_status: null,
      plan_lifecycle: execution === "failed" ? "blocked" : "implementing",
      execution_state: execution,
      partial: false,
      active_slice: { id: "slice-a", title: "Slice A", status: null },
      last_completed_slice: null,
      next_slice: { id: "slice-b", title: "Slice B", status: null },
      last_checkpoint_at: null,
      checkpoint_count: 0,
      verified_checkpoint_count: 0,
      completed_checkpoint_count: 0,
      resume_hint: null,
      task_memory_binding: {
        authority: "dreamgraph",
        source: "implementation_log_projection",
        binding_status: "projected",
        plan_state_owner: "daemon",
        current_slice_id: "slice-a",
        current_checkpoint_id: null,
        current_status: null,
        last_event_at: null,
        resume_hint: null,
        plan_lifecycle: execution === "failed" ? "blocked" : "implementing",
        execution_state: execution,
        active_slice_id: "slice-a",
        last_completed_slice_id: null,
        next_slice_id: "slice-b",
      },
    },
  };
}

describe("Architect pulse weather", () => {
  it("returns blocked for failed execution or unavailable readiness", () => {
    expect(deriveCognitiveWeather({ cognitive: cognitive(), runtime: { ...runtime, pass_state: { status: "failed" } }, plan: plan("failed") }).kind).toBe("blocked");
    expect(deriveCognitiveWeather({ cognitive: cognitive({ llm: { provider: "openai", model: "test", available: false } }), runtime, plan: null }).kind).toBe("blocked");
  });

  it("returns strained for high unresolved tension and rejection pressure", () => {
    const weather = deriveCognitiveWeather({
      cognitive: cognitive({
        dream_graph_stats: { ...cognitive().dream_graph_stats, expiring_next_cycle: 19 },
        validated_stats: { validated: 10, latent: 5, rejected: 40 },
        tension_stats: {
          total: 135,
          unresolved: 135,
          top_urgency: {
            id: "tension-high",
            type: "weak_connection",
            domain: "general",
            entities: [],
            description: "high pressure",
            occurrences: 34,
            urgency: 0.99,
            first_seen: "2026-05-31T00:00:00.000Z",
            last_seen: "2026-05-31T00:00:00.000Z",
            attempted: true,
            resolved: false,
            ttl: 29,
          },
          resolution_pipeline: {
            pending_candidates: 10,
            awaiting_validation: 10,
            by_strategy: { merge: 0, mediator: 0, split: 0, reframe: 10, wont_fix: 0 },
          },
        },
      }),
      runtime,
      plan: plan(),
    });

    expect(weather.kind).toBe("strained");
    expect(weather.reasons.map((reason) => reason.id)).toContain("unresolved_tension_pressure");
  });

  it("returns uncertain for low confidence churn without stronger pressure", () => {
    expect(deriveCognitiveWeather({
      cognitive: cognitive({
        dream_graph_stats: { ...cognitive().dream_graph_stats, avg_confidence: 0.3 },
        validated_stats: { validated: 10, latent: 8, rejected: 8 },
      }),
      runtime,
      plan: null,
    }).kind).toBe("uncertain");
  });

  it("returns recovering for recent bootstrap recovery", () => {
    expect(deriveCognitiveWeather({
      cognitive: cognitive({ bootstrap_history: { total: 1, recent: [{ success: true, outcome: "failure recovered to ready" }] } }),
      runtime,
      plan: null,
    }).kind).toBe("recovering");
  });

  it("returns curious for active speculation without blockers", () => {
    expect(deriveCognitiveWeather({
      cognitive: cognitive({ dream_graph_stats: { ...cognitive().dream_graph_stats, latent_edges: 2 } }),
      runtime,
      plan: null,
    }).kind).toBe("curious");
  });

  it("returns calm for awake ready low pressure", () => {
    expect(deriveCognitiveWeather({ cognitive: cognitive(), runtime, plan: null }).kind).toBe("calm");
  });

  it("builds a stable pulse hash and prompt line", () => {
    const pulse = buildArchitectPulseSnapshot({ cognitive: cognitive(), runtime, plan: plan(), generatedAt: "2026-05-31T00:00:00.000Z" });

    expect(pulse.pulse_hash).toMatch(/^[a-f0-9]{16}$/);
    expect(pulse.plan.lifecycle).toBe("implementing");
    expect(formatArchitectPulseLine(pulse)).toContain("Architect pulse: weather=calm");
    expect(formatArchitectPulseLine(pulse)).toContain("plan=living-dreamgraph implementing/idle");
  });
});
