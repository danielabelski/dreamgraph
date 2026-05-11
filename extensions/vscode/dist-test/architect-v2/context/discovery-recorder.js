"use strict";
// STRICT ISOLATION (ADR-140 + ADR-171 + ADR-176): no v1 imports; no
// mcp_dreamgraph_* imports; no vscode/fs/http imports. The discovery
// recorder is a NARROW port the ContextBuilder calls when assembly
// surfaces concrete artifacts (file URIs, ADR ids) the graph does not
// yet know about. Adapters translate this into candidate edges or
// equivalent backend writes.
//
// Slice 8A.4 — ContextDiscoveryRecorder port.
//
// Why a separate port from ProjectGraphRecorder:
//   - ProjectGraphRecorder is owned by the orchestrator finalize() step
//     and writes deliberate cognition (cards, decisions, outcomes,
//     continuations).
//   - ContextDiscoveryRecorder is owned by the *assembler* and writes
//     incidental cognition discovered while *reading* (the user
//     invariant: "all discovered cognition is still recorded back to
//     graph"). Keeping the two ports separate means the builder cannot
//     accidentally write decisions, and the recorder cannot accidentally
//     write incidental data without the orchestrator's consent.
//   - ADR-177.
Object.defineProperty(exports, "__esModule", { value: true });
exports.NullContextDiscoveryRecorder = void 0;
exports.NullContextDiscoveryRecorder = Object.freeze({
    async recordDiscoveries(_d) {
        /* no-op */
    },
});
//# sourceMappingURL=discovery-recorder.js.map