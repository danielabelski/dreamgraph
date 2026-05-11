// STRICT ISOLATION (ADR-140): no import from v1.
// Slice 6 — Graph density probe.
//
// Density is a per-capability runtime measure of how much the graph can
// answer for THIS capability on THIS task. It is the input to the
// two-mode contract (Slice 6 plan §7):
//   - 'rich'    => graph-amplified mode is mandatory; fallback forbidden
//   - 'partial' => graph-amplified attempted first; fallback allowed
//   - 'sparse'  => sparse-mode by default; graph attempt only opportunistic
//   - 'absent'  => sparse-mode mandatory; enrichment queued
//
// The probe is a *pure* function of a `DensityProbe` snapshot. The
// orchestrator is responsible for collecting the snapshot once per pass
// (typically by reading `system://overview` + `system://capabilities`).
// Slice 6 does no I/O of its own.

import type { CapabilityId } from "./matrix.js";

export type GraphDensity = "rich" | "partial" | "sparse" | "absent";

/**
 * Snapshot of graph state used to compute density per capability. The
 * fields are deliberately small and provider-neutral; richer probes can
 * be added without breaking the contract.
 */
export interface DensityProbe {
  /** True when `system://overview` reports a non-empty index. */
  readonly hasIndex: boolean;
  /** Number of source-code entities known to the graph. */
  readonly sourceEntityCount: number;
  /** Number of API-surface entries (functions/classes with signatures). */
  readonly apiEntityCount: number;
  /** Number of recorded ADRs. */
  readonly adrCount: number;
  /** Number of validated edges. */
  readonly validatedEdgeCount: number;
  /** Number of UI elements registered. */
  readonly uiElementCount: number;
  /** Number of rows/tables in the data-model index. */
  readonly dataModelEntityCount: number;
  /** Number of recent dream insights (last cycle window). */
  readonly recentDreamInsightCount: number;
  /** Number of resolved tensions (provenance for memory.recall). */
  readonly resolvedTensionCount: number;
}

/** Empty probe — the day-zero install state. Drives sparse-mode everywhere. */
export const EMPTY_DENSITY_PROBE: DensityProbe = Object.freeze({
  hasIndex: false,
  sourceEntityCount: 0,
  apiEntityCount: 0,
  adrCount: 0,
  validatedEdgeCount: 0,
  uiElementCount: 0,
  dataModelEntityCount: 0,
  recentDreamInsightCount: 0,
  resolvedTensionCount: 0,
});

/**
 * Map a numeric count to a density bucket using the standard threshold
 * curve (absent = 0, sparse = 1..9, partial = 10..49, rich = 50+). The
 * thresholds are intentionally low: a project with 50 entities of a
 * given kind is rich enough that the graph-first path will outperform
 * generic search/grep on typical queries.
 */
function bucketByCount(n: number): GraphDensity {
  if (n <= 0) return "absent";
  if (n < 10) return "sparse";
  if (n < 50) return "partial";
  return "rich";
}

/**
 * Pure mapping from `(probe, capabilityId)` to a density bucket. The
 * mapping picks the *most relevant* count for each capability — e.g.
 * `search.api` reads `apiEntityCount`, `search.ui` reads
 * `uiElementCount`, mutation capabilities read `sourceEntityCount`.
 */
export function measureDensity(
  probe: DensityProbe,
  capabilityId: CapabilityId,
): GraphDensity {
  if (!probe.hasIndex) return "absent";

  switch (capabilityId) {
    // --- Navigation & search ---
    case "navigate.symbol":
    case "navigate.references":
    case "search.api":
      return bucketByCount(probe.apiEntityCount);
    case "read.file":
    case "read.dir":
    case "read.markdown.chapter":
    case "search.text":
      return bucketByCount(probe.sourceEntityCount);
    case "search.semantic":
      return bucketByCount(
        probe.apiEntityCount + probe.recentDreamInsightCount + probe.adrCount,
      );
    case "search.data_model":
      return bucketByCount(probe.dataModelEntityCount);
    case "search.ui":
      return bucketByCount(probe.uiElementCount);

    // --- History & rationale ---
    case "read.history.git":
      return bucketByCount(probe.sourceEntityCount);
    case "read.adr":
      return bucketByCount(probe.adrCount);
    case "read.workflow":
      return bucketByCount(probe.adrCount);
    case "read.narrative":
      return probe.recentDreamInsightCount > 0 ? "partial" : "absent";
    case "explain.causal":
    case "explain.temporal":
      return bucketByCount(probe.validatedEdgeCount);
    case "plan.remediation":
      return bucketByCount(probe.recentDreamInsightCount);
    case "memory.recall":
      return bucketByCount(
        probe.recentDreamInsightCount + probe.resolvedTensionCount,
      );

    // --- Mutation ---
    case "mutate.file.create":
    case "mutate.file.edit":
    case "mutate.file.patch":
    case "mutate.file.append":
    case "mutate.file.delete_rename":
    case "mutate.markdown.chapter":
    case "mutate.api.surface":
      return bucketByCount(probe.sourceEntityCount);
    case "mutate.graph.wire":
    case "mutate.entity.edit":
      return bucketByCount(probe.sourceEntityCount + probe.apiEntityCount);

    // --- Verification ---
    case "verify.build":
    case "verify.test":
    case "verify.type":
    case "verify.lint":
      return bucketByCount(probe.sourceEntityCount);
    case "verify.discipline":
    case "verify.invariant":
      return bucketByCount(probe.adrCount + probe.validatedEdgeCount);

    // --- Cognition ---
    case "memory.persist":
      return bucketByCount(probe.adrCount);
    case "cognition.dream":
    case "cognition.tension.resolve":
      return bucketByCount(probe.recentDreamInsightCount);
    case "task.create_continuation":
      return "rich"; // Slice 3 contract; not graph-density bound

    // --- Environment ---
    case "env.web.fetch":
    case "env.terminal.run":
      return bucketByCount(probe.adrCount);
    case "env.clipboard":
    case "env.diagnostics.live":
    case "env.lm.invoke_tool":
      return "absent"; // pure environment IO; sparse-mode by nature
  }
}
