// STRICT ISOLATION (ADR-140): no import from v1.
// Slice 6 — Enrichment scheduling.
//
// When a capability runs in sparse-mode (or fills a gap), we queue an
// `Intent` for the next pass that moves the graph toward 'rich' density
// for that capability. This is the engine of the long-arc benefit
// promised in Slice 6 plan §8: a project that has been worked on for a
// week is measurably better instrumented than one worked on for a day.
//
// `enrichmentForFallback` is a pure lookup over `CAPABILITY_MATRIX`. The
// orchestrator (post-cutover) is responsible for actually executing the
// queued intents — Slice 6 only declares them.

import type { Intent } from "../execution/index.js";
import { type CapabilityId, getCapability } from "./matrix.js";

/**
 * Returns the Intent the orchestrator should queue for the next pass
 * when this capability ran in sparse-mode (or was a graph-only gap). May
 * be `undefined` when no enrichment is meaningful — e.g. pure
 * environment IO like `env.clipboard`.
 */
export function enrichmentForFallback(
  capabilityId: CapabilityId,
): Intent | undefined {
  const cap = getCapability(capabilityId);
  return cap.enrichOnFallback;
}

/** Describes a queued enrichment task — emitted on `TaskState.enrichmentQueue`. */
export interface EnrichmentTask {
  readonly capabilityId: CapabilityId;
  readonly intent: Intent;
  /** Why this enrichment was queued (debug/audit; rendered on cards). */
  readonly reason: "sparse_mode_used" | "graph_only_gap";
}

/**
 * Build an `EnrichmentTask` for a capability that just ran in sparse-mode
 * or was declared a gap. Returns `undefined` when the capability has no
 * enrichOnFallback intent (nothing useful to schedule).
 */
export function buildEnrichmentTask(
  capabilityId: CapabilityId,
  reason: EnrichmentTask["reason"],
): EnrichmentTask | undefined {
  const intent = enrichmentForFallback(capabilityId);
  if (!intent) return undefined;
  return Object.freeze({ capabilityId, intent, reason });
}
