"use strict";
// STRICT ISOLATION (ADR-140 + ADR-171): no import from v1.
// No import of mcp_dreamgraph_* anywhere in this file or anywhere it is
// consumed. DreamGraph is one *adapter* behind these ports (8A.3 / 8A.4);
// the orchestrator binds only to the abstractions defined here.
//
// Slice 8A.1 — Project graph ports.
//
// `ProjectGraphReader` and `ProjectGraphRecorder` are the *only* graph
// surfaces the Architect orchestrator and its sub-slices may consume.
// They are deliberately narrower than DreamGraph's internal model so
// that LSP-only, filesystem-only, or remote-graph backends can be
// implemented without stub returns.
//
// Sparse / no-graph projects are first-class:
//   - `ProjectGraphReader.getRichnessSignal` returns 'absent' / 'sparse'
//     and the orchestrator transparently degrades to filesystem +
//     runtime + LSP context reconstruction (Slice 6 sparse-mode).
//   - `ProjectGraphRecorder` may be a no-op `NullProjectGraphRecorder`;
//     cognition is still produced, just not durably indexed.
Object.defineProperty(exports, "__esModule", { value: true });
exports.NullProjectGraphRecorder = exports.NullProjectGraphReader = exports.NULL_RICHNESS_SIGNAL = exports.NULL_PROJECT_SUBGRAPH = void 0;
// ---------------------------------------------------------------------------
// Null implementations — used when no backend is wired.
// They are *not* stubs in the bad sense: they implement the contract
// faithfully for an empty / no-graph project.
// ---------------------------------------------------------------------------
exports.NULL_PROJECT_SUBGRAPH = Object.freeze({
    nodes: Object.freeze([]),
    edges: Object.freeze([]),
    truncated: false,
    provenance: "null-reader",
});
exports.NULL_RICHNESS_SIGNAL = Object.freeze({
    richness: "absent",
    confidence: 1,
    note: "No project-graph reader wired.",
});
exports.NullProjectGraphReader = Object.freeze({
    async getRichnessSignal(_scope) {
        return exports.NULL_RICHNESS_SIGNAL;
    },
    async retrieveSubgraph(_query) {
        return exports.NULL_PROJECT_SUBGRAPH;
    },
    async getNeighbors(_nodeId, _options) {
        return [];
    },
});
exports.NullProjectGraphRecorder = Object.freeze({
    async recordCards(_cards) {
        /* no-op */
    },
    async recordDecision(_decision) {
        /* no-op */
    },
    async recordOutcome(_outcome) {
        /* no-op */
    },
    async recordContinuation(_continuation) {
        /* no-op */
    },
});
//# sourceMappingURL=project-graph.js.map