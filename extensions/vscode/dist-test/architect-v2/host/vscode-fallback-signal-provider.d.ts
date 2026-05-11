import type { DiagnosticSnapshot, EnvironmentSnapshot, FallbackSignalProvider, FileExcerpt, ProjectEntry, ReadFileExcerptsInput, RecentHistorySnapshot } from "../context/index.js";
export interface VSCodeFallbackProviderOptions {
    /**
     * Reader for prior pass deltas. The host wires this against the same
     * MemoryPort used by the orchestrator so 'recent_history' actually
     * reflects what the task did. Optional; when omitted, history is empty.
     */
    readonly readPassDeltas?: (taskId: string, maxItems: number) => Promise<readonly string[]>;
}
export declare class VSCodeFallbackSignalProvider implements FallbackSignalProvider {
    private readonly options;
    constructor(options?: VSCodeFallbackProviderOptions);
    readEnvironment(): Promise<EnvironmentSnapshot>;
    readRecentDiagnostics(maxItems?: number): Promise<readonly DiagnosticSnapshot[]>;
    readFileExcerpts(input: ReadFileExcerptsInput): Promise<readonly FileExcerpt[]>;
    walkProjectShallow(maxEntries?: number): Promise<readonly ProjectEntry[]>;
    readRecentHistory(taskId: string, maxItems?: number): Promise<RecentHistorySnapshot>;
}
//# sourceMappingURL=vscode-fallback-signal-provider.d.ts.map