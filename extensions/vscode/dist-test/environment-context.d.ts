/**
 * Stable Environment Context — compact, cache-friendly runtime/package facts
 * derived from workspace structure and package manifests.
 */
export interface EnvironmentContextEntry {
    scope: string;
    runtime: string;
    moduleSystem: string;
    role: string;
    framework?: string;
    boundaries: string[];
    keyDependencies: string[];
}
export interface EnvironmentContextSnapshot {
    workspaceRuntime?: string;
    workspacePackageManager?: string;
    entries: EnvironmentContextEntry[];
}
export interface EnvironmentContextRenderMetrics {
    matchedScopes: string[];
    renderedScopeCount: number;
    tokenEstimate: number;
    bytes: number;
    hash: string;
    stablePrefixHash: string;
    stablePrefixBytes: number;
    stablePrefixTokenEstimate: number;
    stableReuseRatio?: number;
    volatilityKey: string;
}
export interface EnvironmentContextRenderResult {
    text: string | null;
    metrics: EnvironmentContextRenderMetrics;
}
export declare function buildEnvironmentContextSnapshot(workspaceRoot: string): Promise<EnvironmentContextSnapshot | null>;
export declare function selectEnvironmentContextForFile(snapshot: EnvironmentContextSnapshot | null, relativeFilePath?: string | null): EnvironmentContextEntry[];
export declare function renderEnvironmentContextBlock(snapshot: EnvironmentContextSnapshot | null, relativeFilePath?: string | null): string | null;
export declare function renderEnvironmentContextBlockWithMetrics(snapshot: EnvironmentContextSnapshot | null, relativeFilePath?: string | null, previousMetrics?: Pick<EnvironmentContextRenderMetrics, "hash" | "stablePrefixHash"> | null): EnvironmentContextRenderResult;
//# sourceMappingURL=environment-context.d.ts.map