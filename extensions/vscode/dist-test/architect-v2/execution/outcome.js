"use strict";
// architect-v2/execution/outcome.ts
// Slice 4 — Provider-neutral ToolOutcome event (ADR-157).
//
// STRICT ISOLATION (ADR-140): no import from v1.
//
// Every tool result — MCP, VS Code, shell — is normalized into one of three
// `ToolOutcome` shapes before any later slice sees it. Cards, the verification
// harness, and the autonomy decision engine all read this exact union.
Object.defineProperty(exports, "__esModule", { value: true });
exports.success = success;
exports.failure = failure;
exports.partial = partial;
exports.outcomeProducedArtifacts = outcomeProducedArtifacts;
// ---------------------------------------------------------------------------
// Constructors — small, but they exist so callers can't accidentally drift
// from the canonical shape.
// ---------------------------------------------------------------------------
function success(args) {
    validateBase(args);
    return { kind: "success", ...args };
}
function failure(args) {
    validateBase(args);
    return { kind: "failure", ...args };
}
function partial(args) {
    validateBase(args);
    return { kind: "partial", ...args };
}
function validateBase(args) {
    if (!args.tool)
        throw new Error("ToolOutcome.tool must be a non-empty string");
    if (args.durationMs < 0) {
        throw new Error("ToolOutcome.durationMs must be >= 0");
    }
    if (args.executedAtEpochMs <= 0) {
        throw new Error("ToolOutcome.executedAtEpochMs must be > 0");
    }
}
/**
 * True if the outcome modified observable state (an artifact was produced
 * or changed). Used by Slice 3 no-progress detection at the orchestrator
 * boundary.
 */
function outcomeProducedArtifacts(o) {
    if (o.kind === "failure")
        return false;
    return o.artifacts.length > 0;
}
//# sourceMappingURL=outcome.js.map