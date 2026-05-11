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
export declare const NullContextDiscoveryRecorder: ContextDiscoveryRecorder;
//# sourceMappingURL=discovery-recorder.d.ts.map