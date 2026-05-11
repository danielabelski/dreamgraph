// STRICT ISOLATION (ADR-140 + ADR-171 + ADR-176): no v1 imports; no
// mcp_dreamgraph_* imports; no vscode/fs/http imports in this file.
// This module defines the *port* and a Null implementation. Real
// implementations live in 8A.5 (vscode adapter) under
// orchestrator/adapters/.
//
// Slice 8A.3 — FallbackSignalProvider port.
//
// Purpose: when ProjectGraphReader returns sparse/absent richness (or for
// requirement kinds that are inherently non-graph: file_excerpts,
// environment_state, runtime_diagnostics, recent_history), the
// ContextBuilder must still produce useful context. This port abstracts
// the "normal agent context" sources — filesystem, environment,
// diagnostics, and prior-pass history — behind a uniform interface.
//
// The Null implementation returns empty results for every method so the
// builder can run in pure unit tests without scaffolding a workspace.

// ---------------------------------------------------------------------------
// Snapshot types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Null implementation (default; used in tests + when no host adapter wired)
// ---------------------------------------------------------------------------

export const NULL_ENVIRONMENT: EnvironmentSnapshot = Object.freeze({
  osPlatform: "unknown",
  editorHostName: "none",
  openFolderUris: Object.freeze([]),
});

export const NULL_RECENT_HISTORY: RecentHistorySnapshot = Object.freeze({
  priorPassDeltas: Object.freeze([]),
});

export class NullFallbackSignalProvider implements FallbackSignalProvider {
  async readEnvironment(): Promise<EnvironmentSnapshot> {
    return NULL_ENVIRONMENT;
  }
  async readRecentDiagnostics(): Promise<readonly DiagnosticSnapshot[]> {
    return [];
  }
  async readFileExcerpts(): Promise<readonly FileExcerpt[]> {
    return [];
  }
  async walkProjectShallow(): Promise<readonly ProjectEntry[]> {
    return [];
  }
  async readRecentHistory(): Promise<RecentHistorySnapshot> {
    return NULL_RECENT_HISTORY;
  }
}
