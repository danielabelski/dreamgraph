import { createHash } from "node:crypto";
import type { CognitiveState } from "../cognitive/types.js";
import { addTrustStateCount, emptyTrustStateDistribution, type TrustStateDistribution } from "../cognitive/trust-state.js";
import type { ArchitectOperationalPlanState } from "./plan-registry.js";

export type CognitiveWeatherKind = "blocked" | "strained" | "uncertain" | "recovering" | "curious" | "calm";

export interface CognitiveWeatherReason {
  id: string;
  label: string;
  severity: "info" | "warn" | "critical";
  anchor: string | null;
}

export interface ArchitectPulsePlanInput {
  id: string;
  title: string;
  operational_state: ArchitectOperationalPlanState;
}

export interface ArchitectPulseRuntimeInput {
  pass_state: { status: string };
  provenance_authority: string;
}

export interface ArchitectPulseSnapshot {
  generated_at: string;
  pulse_hash: string;
  plan: {
    id: string | null;
    title: string | null;
    lifecycle: string | null;
    execution: string | null;
    active_slice: string | null;
    next_slice: string | null;
  };
  cognitive: {
    state: string;
    llm_ready: boolean | null;
    unresolved_tensions: number;
    top_tension_id: string | null;
    top_tension_urgency: number | null;
    expiring_next_cycle: number;
    validation: { validated: number; latent: number; rejected: number };
    trust_states: TrustStateDistribution;
  };
  weather: {
    kind: CognitiveWeatherKind;
    label: string;
    reasons: CognitiveWeatherReason[];
  };
  authority_boundary: {
    repository_authority: "dreamgraph_mcp";
    mutation_mode: "governed_tools_only";
    direct_filesystem_claims: false;
  };
}

function readinessState(status: CognitiveState): string | null {
  const readiness = status.llm_readiness;
  return readiness && typeof readiness === "object" && "state" in readiness
    ? String((readiness as { state?: unknown }).state ?? "") || null
    : null;
}

function llmReady(status: CognitiveState): boolean | null {
  const state = readinessState(status);
  if (state) return state === "ready";
  return typeof status.llm?.available === "boolean" ? status.llm.available : null;
}

function addReason(reasons: CognitiveWeatherReason[], reason: CognitiveWeatherReason): void {
  if (!reasons.some((candidate) => candidate.id === reason.id)) {
    reasons.push(reason);
  }
}

export function deriveCognitiveWeather(input: {
  cognitive: CognitiveState;
  runtime: ArchitectPulseRuntimeInput;
  plan: ArchitectPulsePlanInput | null;
}): ArchitectPulseSnapshot["weather"] {
  const reasons: CognitiveWeatherReason[] = [];
  const cognitive = input.cognitive;
  const planState = input.plan?.operational_state;
  const execution = planState?.execution_state ?? input.runtime.pass_state.status ?? "idle";
  const lifecycle = planState?.plan_lifecycle ?? null;
  const ready = llmReady(cognitive);
  const tensions = cognitive.tension_stats;
  const topUrgency = tensions.top_urgency?.urgency ?? null;
  const validation = cognitive.validated_stats;
  const graph = cognitive.dream_graph_stats;
  const pending = tensions.resolution_pipeline?.pending_candidates ?? 0;
  const awaiting = tensions.resolution_pipeline?.awaiting_validation ?? 0;

  if (["blocked", "failed", "timed_out", "cancelled"].includes(execution)) {
    addReason(reasons, { id: "execution_blocked", label: `execution=${execution}`, severity: "critical", anchor: input.plan?.id ?? null });
  }
  if (lifecycle === "blocked") {
    addReason(reasons, { id: "plan_blocked", label: "plan lifecycle is blocked", severity: "critical", anchor: input.plan?.id ?? null });
  }
  if (ready === false) {
    addReason(reasons, { id: "llm_not_ready", label: "LLM readiness is not ready", severity: "critical", anchor: "cognitive_status.llm_readiness" });
  }
  if (input.runtime.provenance_authority !== "dreamgraph_mcp") {
    addReason(reasons, { id: "authority_unavailable", label: "DreamGraph MCP authority unavailable", severity: "critical", anchor: "runtime.provenance_authority" });
  }
  if (reasons.some((reason) => reason.severity === "critical")) {
    return { kind: "blocked", label: "Blocked", reasons: reasons.slice(0, 3) };
  }

  if (tensions.unresolved >= 100) {
    addReason(reasons, { id: "unresolved_tension_pressure", label: `${tensions.unresolved} unresolved tensions`, severity: "warn", anchor: "dream://tensions" });
  }
  if (topUrgency != null && topUrgency >= 0.8) {
    addReason(reasons, { id: "top_tension_urgency", label: `top urgency ${topUrgency.toFixed(2)}`, severity: "warn", anchor: tensions.top_urgency?.id ?? null });
  }
  if (validation.rejected > Math.max(validation.validated, 1) * 2) {
    addReason(reasons, { id: "rejection_pressure", label: `${validation.rejected} rejected vs ${validation.validated} validated`, severity: "warn", anchor: "dream://validated" });
  }
  if (pending + awaiting > 0) {
    addReason(reasons, { id: "resolution_backlog", label: `${pending + awaiting} resolution candidates pending`, severity: "warn", anchor: "tension_stats.resolution_pipeline" });
  }
  if (graph.expiring_next_cycle >= 10) {
    addReason(reasons, { id: "memory_expiry_pressure", label: `${graph.expiring_next_cycle} items expiring next cycle`, severity: "warn", anchor: "dream_graph_stats.expiring_next_cycle" });
  }
  if (reasons.length > 0) {
    return { kind: "strained", label: "Strained", reasons: reasons.slice(0, 3) };
  }

  if (graph.avg_confidence < 0.45 && validation.rejected + validation.latent > validation.validated) {
    addReason(reasons, { id: "low_confidence_churn", label: `avg confidence ${graph.avg_confidence.toFixed(2)} with active churn`, severity: "warn", anchor: "dream_graph_stats.avg_confidence" });
  }
  if (tensions.top_urgency?.attempted && tensions.top_urgency.occurrences >= 3) {
    addReason(reasons, { id: "repeated_unresolved_attempt", label: `attempted tension repeated ${tensions.top_urgency.occurrences} times`, severity: "warn", anchor: tensions.top_urgency.id });
  }
  if (reasons.length > 0) {
    return { kind: "uncertain", label: "Uncertain", reasons: reasons.slice(0, 3) };
  }

  const recentBootstrap = cognitive.bootstrap_history?.recent ?? [];
  if (recentBootstrap.some((entry) => {
    const record = entry && typeof entry === "object" ? entry as { success?: unknown; outcome?: unknown } : {};
    return record.success === true && /failure|failed|rotated|recovery|ready/i.test(String(record.outcome ?? ""));
  })) {
    return {
      kind: "recovering",
      label: "Recovering",
      reasons: [{ id: "recent_readiness_recovery", label: "recent readiness/bootstrap recovery", severity: "info", anchor: "bootstrap_history.recent" }],
    };
  }

  if (ready !== false && (graph.latent_edges + graph.latent_nodes > 0 || tensions.unresolved > 0)) {
    return {
      kind: "curious",
      label: "Curious",
      reasons: [{ id: "active_speculation", label: "active speculation with ready runtime", severity: "info", anchor: "dream://graph" }],
    };
  }

  return {
    kind: "calm",
    label: "Calm",
    reasons: [{ id: "awake_ready_low_pressure", label: "awake/ready with low pressure", severity: "info", anchor: "cognitive_status" }],
  };
}

function summarizePulseTrustStates(cognitive: CognitiveState): TrustStateDistribution {
  const distribution = emptyTrustStateDistribution();
  addTrustStateCount(distribution, "validated_insight", cognitive.validated_stats.validated);
  addTrustStateCount(distribution, "latent_speculative_link", cognitive.validated_stats.latent + cognitive.dream_graph_stats.latent_edges + cognitive.dream_graph_stats.latent_nodes);
  addTrustStateCount(distribution, "rejected_link", cognitive.validated_stats.rejected);
  const pipeline = cognitive.tension_stats.resolution_pipeline;
  addTrustStateCount(distribution, "advisory_candidate", (pipeline?.pending_candidates ?? 0) + (pipeline?.awaiting_validation ?? 0));
  return distribution;
}

export function buildArchitectPulseSnapshot(input: {
  cognitive: CognitiveState;
  runtime: ArchitectPulseRuntimeInput;
  plan: ArchitectPulsePlanInput | null;
  generatedAt?: string;
}): ArchitectPulseSnapshot {
  const planState = input.plan?.operational_state ?? null;
  const topTension = input.cognitive.tension_stats.top_urgency;
  const snapshotWithoutHash = {
    generated_at: input.generatedAt ?? new Date().toISOString(),
    pulse_hash: "",
    plan: {
      id: input.plan?.id ?? null,
      title: input.plan?.title ?? null,
      lifecycle: planState?.plan_lifecycle ?? null,
      execution: planState?.execution_state ?? null,
      active_slice: planState?.active_slice?.title ?? planState?.current_slice_title ?? null,
      next_slice: planState?.next_slice?.title ?? null,
    },
    cognitive: {
      state: input.cognitive.current_state,
      llm_ready: llmReady(input.cognitive),
      unresolved_tensions: input.cognitive.tension_stats.unresolved,
      top_tension_id: topTension?.id ?? null,
      top_tension_urgency: topTension?.urgency ?? null,
      expiring_next_cycle: input.cognitive.dream_graph_stats.expiring_next_cycle,
      validation: {
        validated: input.cognitive.validated_stats.validated,
        latent: input.cognitive.validated_stats.latent,
        rejected: input.cognitive.validated_stats.rejected,
      },
      trust_states: summarizePulseTrustStates(input.cognitive),
    },
    weather: deriveCognitiveWeather(input),
    authority_boundary: {
      repository_authority: "dreamgraph_mcp" as const,
      mutation_mode: "governed_tools_only" as const,
      direct_filesystem_claims: false as const,
    },
  };
  const hashInput = JSON.stringify({ ...snapshotWithoutHash, generated_at: undefined, pulse_hash: undefined });
  return {
    ...snapshotWithoutHash,
    pulse_hash: createHash("sha256").update(hashInput).digest("hex").slice(0, 16),
  };
}

export function formatArchitectPulseLine(pulse: ArchitectPulseSnapshot): string {
  const readiness = pulse.cognitive.llm_ready == null ? "unknown" : pulse.cognitive.llm_ready ? "ready" : "not-ready";
  const plan = pulse.plan.id
    ? `${pulse.plan.id} ${pulse.plan.lifecycle ?? "unknown"}/${pulse.plan.execution ?? "unknown"}`
    : "none";
  return `Architect pulse: weather=${pulse.weather.kind}; cognitive=${pulse.cognitive.state}/${readiness}; tensions=${pulse.cognitive.unresolved_tensions} unresolved; trust=validated:${pulse.cognitive.trust_states.validated_insight}/latent:${pulse.cognitive.trust_states.latent_speculative_link}/rejected:${pulse.cognitive.trust_states.rejected_link}; plan=${plan}; authority=dreamgraph_mcp governed tools only.`;
}
