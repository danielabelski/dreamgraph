// STRICT ISOLATION (ADR-140): no import from v1.
// Slice 6 — Capability path selection.
//
// `chooseCapabilityPath` is a *pure* function that turns
// `(capabilityId, density)` into a `CapabilityPlan`. It encodes the
// two-mode contract (Slice 6 plan §7):
//
//   density === 'rich'     => graph-amplified mode mandatory; fallback []
//   density === 'partial'  => graph-amplified attempted; fallback allowed
//   density === 'sparse'   => sparse-mode by default; graph attempt is optional
//   density === 'absent'   => sparse-mode mandatory; enrichment queued
//                             (or `gap` for graph-only capabilities)
//
// Slice 4's `selectExecutor` does the actual T1->T5 walk over the
// returned `intents`. Slice 6 only narrows the per-capability constraint
// set; it never executes a tool itself.

import type { Intent } from "../execution/index.js";
import type { GraphDensity } from "./density.js";
import { enrichmentForFallback } from "./enrichment.js";
import { type CapabilityId, type CapabilityRecord, getCapability } from "./matrix.js";

/** What the orchestrator should do for a capability on this pass. */
export type CapabilityPlan =
  | {
      readonly kind: "graph-amplified";
      readonly capabilityId: CapabilityId;
      readonly density: GraphDensity;
      /** The Intent set to hand to `selectExecutor`. Fallback forbidden when rich. */
      readonly intents: readonly Intent[];
      /** Empty when density is 'rich'; carries fallback intents when 'partial'. */
      readonly allowedFallback: readonly Intent[];
      readonly graphBound: "yes";
      readonly enrichmentQueued: null;
      readonly winRationale: string;
    }
  | {
      readonly kind: "sparse-mode";
      readonly capabilityId: CapabilityId;
      readonly density: GraphDensity;
      /** Fallback intents — used immediately, no waiting on graph. */
      readonly intents: readonly Intent[];
      readonly allowedFallback: readonly Intent[];
      readonly graphBound: "no" | "partial";
      /** Enrichment Intent queued for the next pass (may be undefined). */
      readonly enrichmentQueued: Intent | null;
      readonly winRationale: string;
    }
  | {
      readonly kind: "gap";
      readonly capabilityId: CapabilityId;
      readonly density: GraphDensity;
      readonly reason: "graph_only_capability_without_baseline";
      readonly enrichmentQueued: Intent | null;
    };

/**
 * Pure selection function. Same `(capabilityId, density)` always returns
 * the same plan (Slice 6 verification §9.6).
 */
export function chooseCapabilityPath(
  capabilityId: CapabilityId,
  density: GraphDensity,
): CapabilityPlan {
  const cap: CapabilityRecord = getCapability(capabilityId);

  // Graph-only capability with no baseline => declared gap (not a failure).
  if (cap.graphOnly && (density === "absent" || density === "sparse")) {
    return Object.freeze({
      kind: "gap" as const,
      capabilityId,
      density,
      reason: "graph_only_capability_without_baseline" as const,
      enrichmentQueued: enrichmentForFallback(capabilityId) ?? null,
    });
  }

  // Rich graph for a capability that has a graph-first path: mandatory
  // graph-amplified mode, fallback forbidden.
  if (density === "rich" && cap.graphFirst.length > 0) {
    return Object.freeze({
      kind: "graph-amplified" as const,
      capabilityId,
      density,
      intents: Object.freeze([...cap.graphFirst]) as readonly Intent[],
      allowedFallback: Object.freeze([]) as readonly Intent[],
      graphBound: "yes" as const,
      enrichmentQueued: null,
      winRationale: cap.winRationale,
    });
  }

  // Partial density with a graph-first path: try graph first, allow
  // fallback. Still graph-amplified mode (we expect a graph hit), but
  // selectExecutor may walk down to T4/T5.
  if (density === "partial" && cap.graphFirst.length > 0) {
    return Object.freeze({
      kind: "graph-amplified" as const,
      capabilityId,
      density,
      intents: Object.freeze([...cap.graphFirst]) as readonly Intent[],
      allowedFallback: Object.freeze([...cap.fallback]) as readonly Intent[],
      graphBound: "yes" as const,
      enrichmentQueued: null,
      winRationale: cap.winRationale,
    });
  }

  // Sparse-mode (the never-failing secondary mode): use fallback
  // immediately, queue enrichment so the next pass moves toward
  // graph-amplified.
  const enrichment = enrichmentForFallback(capabilityId);
  return Object.freeze({
    kind: "sparse-mode" as const,
    capabilityId,
    density,
    intents: Object.freeze([...cap.fallback]) as readonly Intent[],
    allowedFallback: Object.freeze([...cap.fallback]) as readonly Intent[],
    graphBound: density === "sparse" ? "partial" : "no",
    enrichmentQueued: enrichment ?? null,
    winRationale: cap.winRationale,
  });
}

export function isGraphAmplified(
  plan: CapabilityPlan,
): plan is Extract<CapabilityPlan, { kind: "graph-amplified" }> {
  return plan.kind === "graph-amplified";
}

export function isSparseMode(
  plan: CapabilityPlan,
): plan is Extract<CapabilityPlan, { kind: "sparse-mode" }> {
  return plan.kind === "sparse-mode";
}

export function isGap(
  plan: CapabilityPlan,
): plan is Extract<CapabilityPlan, { kind: "gap" }> {
  return plan.kind === "gap";
}
