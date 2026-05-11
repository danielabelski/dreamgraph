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

import type { ContextRequirementKind } from "../prompts/requirements.js";

/**
 * One incidental finding the assembler made while building a context
 * envelope. The builder emits these when a fallback section was
 * produced from concrete file URIs (so a future graph build knows the
 * task touched those files), or when graph retrieval surfaced a node
 * the orchestrator's TaskState had not previously referenced.
 */
export interface ContextDiscovery {
  readonly taskId: string;
  /**
   * Which composer requirement kind produced this discovery. Provides
   * the "why was this surfaced" trail for audit.
   */
  readonly sourceRequirementKind: ContextRequirementKind;
  /**
   * Whether the discovery came from the graph reader or a fallback
   * source. Lets adapters decide whether to record a candidate edge
   * (fallback → graph promotion) or a touch counter (already in graph).
   */
  readonly via: "project_graph" | "fallback";
  /**
   * Concrete artifacts this section referenced. Strings are opaque
   * (file URI, MCP entity id, ADR id, etc.); the adapter knows how to
   * dereference them in its backend.
   */
  readonly artifactRefs: readonly string[];
}

export interface ContextDiscoveryRecorder {
  /**
   * MUST NOT throw. Implementations buffer or batch as they see fit.
   * The builder calls this fire-and-forget at the end of assembly.
   */
  recordDiscoveries(discoveries: readonly ContextDiscovery[]): Promise<void>;
}

export const NullContextDiscoveryRecorder: ContextDiscoveryRecorder =
  Object.freeze({
    async recordDiscoveries(_d: readonly ContextDiscovery[]): Promise<void> {
      /* no-op */
    },
  });
