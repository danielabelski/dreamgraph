"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.chooseCapabilityPath = chooseCapabilityPath;
exports.isGraphAmplified = isGraphAmplified;
exports.isSparseMode = isSparseMode;
exports.isGap = isGap;
const enrichment_js_1 = require("./enrichment.js");
const matrix_js_1 = require("./matrix.js");
/**
 * Pure selection function. Same `(capabilityId, density)` always returns
 * the same plan (Slice 6 verification §9.6).
 */
function chooseCapabilityPath(capabilityId, density) {
    const cap = (0, matrix_js_1.getCapability)(capabilityId);
    // Graph-only capability with no baseline => declared gap (not a failure).
    if (cap.graphOnly && (density === "absent" || density === "sparse")) {
        return Object.freeze({
            kind: "gap",
            capabilityId,
            density,
            reason: "graph_only_capability_without_baseline",
            enrichmentQueued: (0, enrichment_js_1.enrichmentForFallback)(capabilityId) ?? null,
        });
    }
    // Rich graph for a capability that has a graph-first path: mandatory
    // graph-amplified mode, fallback forbidden.
    if (density === "rich" && cap.graphFirst.length > 0) {
        return Object.freeze({
            kind: "graph-amplified",
            capabilityId,
            density,
            intents: Object.freeze([...cap.graphFirst]),
            allowedFallback: Object.freeze([]),
            graphBound: "yes",
            enrichmentQueued: null,
            winRationale: cap.winRationale,
        });
    }
    // Partial density with a graph-first path: try graph first, allow
    // fallback. Still graph-amplified mode (we expect a graph hit), but
    // selectExecutor may walk down to T4/T5.
    if (density === "partial" && cap.graphFirst.length > 0) {
        return Object.freeze({
            kind: "graph-amplified",
            capabilityId,
            density,
            intents: Object.freeze([...cap.graphFirst]),
            allowedFallback: Object.freeze([...cap.fallback]),
            graphBound: "yes",
            enrichmentQueued: null,
            winRationale: cap.winRationale,
        });
    }
    // Sparse-mode (the never-failing secondary mode): use fallback
    // immediately, queue enrichment so the next pass moves toward
    // graph-amplified.
    const enrichment = (0, enrichment_js_1.enrichmentForFallback)(capabilityId);
    return Object.freeze({
        kind: "sparse-mode",
        capabilityId,
        density,
        intents: Object.freeze([...cap.fallback]),
        allowedFallback: Object.freeze([...cap.fallback]),
        graphBound: density === "sparse" ? "partial" : "no",
        enrichmentQueued: enrichment ?? null,
        winRationale: cap.winRationale,
    });
}
function isGraphAmplified(plan) {
    return plan.kind === "graph-amplified";
}
function isSparseMode(plan) {
    return plan.kind === "sparse-mode";
}
function isGap(plan) {
    return plan.kind === "gap";
}
//# sourceMappingURL=selection.js.map