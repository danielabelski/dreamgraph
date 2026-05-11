// Slice 8A.5 \u2014 VS Code-backed FallbackSignalProvider.
//
// SCOPED EXCEPTION (ADR-171): host/ is wiring; it MAY depend on
// `vscode` to read workspace state. The architect-v2 cognition layer
// still sees only the FallbackSignalProvider port surface.
//
// Every method is best-effort: failures return empty snapshots so the
// ContextBuilder can mark the requirement unmet rather than throwing.

import * as vscode from "vscode";
import type {
  DiagnosticSnapshot,
  EnvironmentSnapshot,
  FallbackSignalProvider,
  FileExcerpt,
  ProjectEntry,
  ReadFileExcerptsInput,
  RecentHistorySnapshot,
} from "../context/index.js";

const DEFAULT_FILE_CHARS = 4_000;
const DEFAULT_DIAG_ITEMS = 25;
const DEFAULT_WALK_ENTRIES = 50;
const DEFAULT_HISTORY_ITEMS = 10;

export interface VSCodeFallbackProviderOptions {
  /**
   * Reader for prior pass deltas. The host wires this against the same
   * MemoryPort used by the orchestrator so 'recent_history' actually
   * reflects what the task did. Optional; when omitted, history is empty.
   */
  readonly readPassDeltas?: (
    taskId: string,
    maxItems: number,
  ) => Promise<readonly string[]>;
}

export class VSCodeFallbackSignalProvider implements FallbackSignalProvider {
  constructor(private readonly options: VSCodeFallbackProviderOptions = {}) {}

  async readEnvironment(): Promise<EnvironmentSnapshot> {
    try {
      const folders = vscode.workspace.workspaceFolders ?? [];
      const active = vscode.window.activeTextEditor?.document.uri.toString();
      return {
        osPlatform: process.platform,
        editorHostName: vscode.env.appName,
        workspaceName: vscode.workspace.name,
        openFolderUris: folders.map((f) => f.uri.toString()),
        activeFileUri: active,
      };
    } catch {
      return {
        osPlatform: process.platform,
        editorHostName: "vscode",
        openFolderUris: [],
      };
    }
  }

  async readRecentDiagnostics(
    maxItems = DEFAULT_DIAG_ITEMS,
  ): Promise<readonly DiagnosticSnapshot[]> {
    try {
      const out: DiagnosticSnapshot[] = [];
      for (const [uri, diags] of vscode.languages.getDiagnostics()) {
        for (const d of diags) {
          out.push({
            fileUri: uri.toString(),
            line: d.range.start.line,
            severity: severityName(d.severity),
            message: d.message,
            source: d.source,
          });
          if (out.length >= maxItems) return out;
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  async readFileExcerpts(
    input: ReadFileExcerptsInput,
  ): Promise<readonly FileExcerpt[]> {
    const cap = input.maxCharsPerFile ?? DEFAULT_FILE_CHARS;
    const out: FileExcerpt[] = [];
    for (const uriStr of input.uris) {
      try {
        const uri = vscode.Uri.parse(uriStr);
        const bytes = await vscode.workspace.fs.readFile(uri);
        const full = new TextDecoder("utf-8").decode(bytes);
        const truncated = full.length > cap;
        out.push({
          uri: uriStr,
          content: truncated ? full.slice(0, cap) : full,
          truncated,
        });
      } catch {
        // Skip unreadable URIs; the assembler treats them as unmet.
      }
    }
    return out;
  }

  async walkProjectShallow(
    maxEntries = DEFAULT_WALK_ENTRIES,
  ): Promise<readonly ProjectEntry[]> {
    try {
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length === 0) return [];
      const out: ProjectEntry[] = [];
      for (const folder of folders) {
        const entries = await vscode.workspace.fs.readDirectory(folder.uri);
        for (const [name, fileType] of entries) {
          if (out.length >= maxEntries) return out;
          if (name.startsWith(".") || name === "node_modules") continue;
          const childUri = vscode.Uri.joinPath(folder.uri, name);
          out.push({
            uri: childUri.toString(),
            relPath: name,
            kind:
              fileType === vscode.FileType.Directory ? "directory" : "file",
          });
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  async readRecentHistory(
    taskId: string,
    maxItems = DEFAULT_HISTORY_ITEMS,
  ): Promise<RecentHistorySnapshot> {
    try {
      const deltas = this.options.readPassDeltas
        ? await this.options.readPassDeltas(taskId, maxItems)
        : [];
      return { priorPassDeltas: deltas };
    } catch {
      return { priorPassDeltas: [] };
    }
  }
}

function severityName(s: vscode.DiagnosticSeverity): DiagnosticSnapshot["severity"] {
  switch (s) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "info";
    default:
      return "hint";
  }
}
