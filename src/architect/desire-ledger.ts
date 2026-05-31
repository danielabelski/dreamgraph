import type { CognitiveState } from "../cognitive/types.js";
import type { TensionCluster } from "../cognitive/tension-clustering.js";
import type { LivingPlanState } from "./plan-registry.js";

export type ArchitectDesireSource = "governance" | "cognitive_status" | "tension_cluster" | "active_plan";

export interface ArchitectDesire {
  id: string;
  title: string;
  statement: string;
  strength: number;
  source: ArchitectDesireSource;
  evidence: string[];
  conflicts: string[];
  last_reinforced: string | null;
}

export interface ArchitectDesireLedger {
  source: "daemon_governed_projection";
  mutation_controls_enabled: false;
  authority_constraint: string;
  desires: ArchitectDesire[];
}

export function buildArchitectDesireLedger(input: {
  cognitive: CognitiveState;
  clusters: TensionCluster[];
  plan: { id: string; living_state: LivingPlanState } | null;
  generatedAt?: string;
}): ArchitectDesireLedger {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const desires: ArchitectDesire[] = [
    {
      id: "preserve-governed-authority",
      title: "Preserve governed authority",
      statement: "Keep repository facts and mutations behind DreamGraph MCP authority and explicit verification gates.",
      strength: 1,
      source: "governance",
      evidence: ["authority:dreamgraph_mcp", "mutation_mode:governed_tools_only"],
      conflicts: [],
      last_reinforced: generatedAt,
    },
    {
      id: "keep-plans-honest",
      title: "Keep plans honest",
      statement: "Keep lifecycle, execution state, evidence, and verification visible as separate plan facts.",
      strength: input.plan ? 0.9 : 0.7,
      source: "active_plan",
      evidence: input.plan ? [`plan:${input.plan.id}`, `review_state:${input.plan.living_state.review_state}`] : ["plan:none-selected"],
      conflicts: [],
      last_reinforced: generatedAt,
    },
  ];

  if (input.cognitive.tension_stats.unresolved > 0) {
    desires.push({
      id: "reduce-unresolved-tension",
      title: "Reduce unresolved tension",
      statement: "Reduce recurring unresolved tension by distinguishing source defects from graph-pressure noise.",
      strength: Math.min(1, 0.55 + input.cognitive.tension_stats.unresolved / 250),
      source: "cognitive_status",
      evidence: [`unresolved_tensions:${input.cognitive.tension_stats.unresolved}`],
      conflicts: ["Do not mutate source until evidence identifies a source-backed defect."],
      last_reinforced: generatedAt,
    });
  }

  for (const cluster of input.clusters.slice(0, 4)) {
    desires.push({
      id: `resolve-${cluster.cause}`,
      title: cluster.cause.replace(/_/g, " "),
      statement: cluster.interpretation,
      strength: Math.min(1, 0.45 + cluster.urgency_range.max * 0.4 + Math.min(cluster.recurrence, 50) / 500),
      source: "tension_cluster",
      evidence: [cluster.id, ...cluster.tension_ids.slice(0, 3)],
      conflicts: cluster.cause === "source_defect_candidate" ? [] : ["Treat graph pressure as a hypothesis until source inspection confirms a defect."],
      last_reinforced: generatedAt,
    });
  }

  if (input.cognitive.dream_graph_stats.expiring_next_cycle > 0) {
    desires.push({
      id: "make-forgetting-visible",
      title: "Make forgetting visible",
      statement: "Expose speculative items nearing expiry so decay is legible and evidence can be added deliberately.",
      strength: Math.min(0.9, 0.5 + input.cognitive.dream_graph_stats.expiring_next_cycle / 100),
      source: "cognitive_status",
      evidence: [`expiring_next_cycle:${input.cognitive.dream_graph_stats.expiring_next_cycle}`],
      conflicts: ["Do not preserve speculation without evidence."],
      last_reinforced: generatedAt,
    });
  }

  return {
    source: "daemon_governed_projection",
    mutation_controls_enabled: false,
    authority_constraint: "Desires influence ranking and explanation only; they never override ADRs, tool authority, user consent, or verification gates.",
    desires: desires.sort((left, right) => right.strength - left.strength || left.id.localeCompare(right.id)).slice(0, 7),
  };
}
