import type { BuildContextInput, ContextBuilderPort } from "../orchestrator/ports.js";
import type { ContextEnvelope } from "../orchestrator/types.js";
import type { ProjectGraphReader } from "../orchestrator/project-graph.js";
import type { ContextRequirement, ContextRequirementManifest } from "../prompts/index.js";
import type { FallbackSignalProvider } from "./fallback-signals.js";
import { type ContextDiscoveryRecorder } from "./discovery-recorder.js";
export interface DefaultContextBuilderDeps {
    readonly graphReader: ProjectGraphReader;
    readonly fallback: FallbackSignalProvider;
    /**
     * ADR-177: optional sink for incidental cognition discovered during
     * assembly (file URIs surfaced via fallback, graph nodes the task did
     * not previously reference). Defaults to no-op so single-source
     * deployments and tests do not have to wire a recorder. The builder
     * never blocks on this; failures are swallowed.
     */
    readonly discoveryRecorder?: ContextDiscoveryRecorder;
}
export declare class DefaultContextBuilder implements ContextBuilderPort {
    private readonly deps;
    constructor(deps: DefaultContextBuilderDeps);
    buildContext(input: BuildContextInput): Promise<ContextEnvelope>;
}
interface Allocation {
    readonly requirement: ContextRequirement;
    readonly tokenBudget: number;
}
/**
 * Pure budget allocator. Splits the window proportionally by
 * (priority + 1) * BUDGET_WEIGHT[budget]. Reserves ~25% of the window
 * for the prompt frame (system text, headers); the rest is split.
 */
export declare function allocateBudget(manifest: ContextRequirementManifest, windowTokens: number): readonly Allocation[];
export {};
//# sourceMappingURL=builder.d.ts.map