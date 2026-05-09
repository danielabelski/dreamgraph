/**
 * §4.6 — Policies seam (propose-only).
 *
 * Plugins may propose discipline rules; the host stores each proposal in
 * `data/plugin_policy_proposals.json` tagged `source: "plugin:<id>"`. The
 * proposal merge / weakening-detection model is not yet specified in the
 * SDK roadmap (see §4.6 REFACTOR-REQUIRED), so for now the host simply
 * journals proposals and rejects any proposal whose author marks itself
 * as weakening an existing rule (`weakens: true`) — that is the minimum
 * monotonicity guarantee the seam can enforce without a merge engine.
 */
import type { PhasePermission } from "../manifest.js";

/**
 * Discipline rule a plugin proposes. The shape is intentionally narrow:
 * the proposal records intent, not host-side merge state.
 */
export interface PolicyProposal {
  /** Stable id within the plugin's namespace. The host prefixes the
   * stored proposal with `<plugin-id>:` for global uniqueness. */
  id: string;
  /** Short, human-readable summary of what the rule constrains. */
  title: string;
  /** Long-form rationale; surfaced in the discipline manifest UI. */
  rationale: string;
  /** Tools / resources / patterns the rule targets (free-form strings). */
  applies_to: string[];
  /** Phase(s) in which the rule binds. */
  phases: PhasePermission[];
  /** Severity level. The host treats `block` as deny, `warn` as advisory. */
  severity: "block" | "warn" | "info";
  /**
   * MUST be `false`. A proposal that admits to weakening an existing rule
   * is rejected with `policy_weakening_rejected`. Reserved for future
   * merge-engine semantics.
   */
  weakens?: boolean;
}

/** Identity helper for IDE inference. */
export function definePolicyProposal(proposal: PolicyProposal): PolicyProposal {
  return proposal;
}
