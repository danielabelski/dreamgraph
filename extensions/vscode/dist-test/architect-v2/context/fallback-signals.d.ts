export interface EnvironmentSnapshot {
    readonly osPlatform: string;
    readonly editorHostName: string;
    readonly workspaceName?: string;
    readonly openFolderUris: readonly string[];
    readonly activeFileUri?: string;
    readonly extras?: Readonly<Record<string, string>>;
}
export interface DiagnosticSnapshot {
    readonly fileUri: string;
    readonly severity: "error" | "warning" | "info" | "hint";
    readonly message: string;
    readonly source?: string;
    readonly line?: number;
    readonly column?: number;
}
export interface FileExcerpt {
    readonly uri: string;
    readonly content: string;
    /** Byte/char offset of the excerpt's start in the source file, if known. */
    readonly offset?: number;
    /** Whether `content` is the full file or only a slice. */
    readonly truncated: boolean;
}
export interface ProjectEntry {
    readonly uri: string;
    readonly kind: "file" | "directory";
    /** Optional relative path from the workspace root for display. */
    readonly relPath?: string;
}
export interface RecentHistorySnapshot {
    /** Compact one-line summaries of prior passes for THIS task. */
    readonly priorPassDeltas: readonly string[];
    /** Optional compact summary of the active task's intent so far. */
    readonly taskIntentDigest?: string;
}
export interface ReadFileExcerptsInput {
    readonly uris: readonly string[];
    /** Soft cap on chars per excerpt; the provider may return less. */
    readonly maxCharsPerFile?: number;
}
/**
 * Non-graph signal source. Every method MUST be safe to call when no
 * workspace is open or when the underlying source is unavailable —
 * return empty arrays / empty snapshots, never throw.
 */
export interface FallbackSignalProvider {
    readEnvironment(): Promise<EnvironmentSnapshot>;
    readRecentDiagnostics(maxItems?: number): Promise<readonly DiagnosticSnapshot[]>;
    readFileExcerpts(input: ReadFileExcerptsInput): Promise<readonly FileExcerpt[]>;
    /**
     * Shallow project walk for graph-absent mode. Implementations should
     * cap depth and total entries; this is for orientation, not indexing.
     */
    walkProjectShallow(maxEntries?: number): Promise<readonly ProjectEntry[]>;
    readRecentHistory(taskId: string, maxItems?: number): Promise<RecentHistorySnapshot>;
}
export declare const NULL_ENVIRONMENT: EnvironmentSnapshot;
export declare const NULL_RECENT_HISTORY: RecentHistorySnapshot;
export declare class NullFallbackSignalProvider implements FallbackSignalProvider {
    readEnvironment(): Promise<EnvironmentSnapshot>;
    readRecentDiagnostics(): Promise<readonly DiagnosticSnapshot[]>;
    readFileExcerpts(): Promise<readonly FileExcerpt[]>;
    walkProjectShallow(): Promise<readonly ProjectEntry[]>;
    readRecentHistory(): Promise<RecentHistorySnapshot>;
}
//# sourceMappingURL=fallback-signals.d.ts.map