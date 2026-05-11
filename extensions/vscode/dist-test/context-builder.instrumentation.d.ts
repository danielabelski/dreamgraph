import type { ContextEnvironmentMetrics, ContextEvidenceKind, ContextInstrumentation, EvidenceItem } from "./types.js";
export declare function buildContextInstrumentation(included: EvidenceItem[], omitted: Array<{
    title: string;
    reason: string;
    required: boolean;
    kind?: ContextEvidenceKind;
}>, environment?: ContextEnvironmentMetrics | null, previousStablePrefixHash?: string | null): {
    instrumentation: ContextInstrumentation;
    stablePrefixHash: string;
};
//# sourceMappingURL=context-builder.instrumentation.d.ts.map