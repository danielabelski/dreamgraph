"use strict";
// Slice 8A.5 \u2014 VS Code-backed FallbackSignalProvider.
//
// SCOPED EXCEPTION (ADR-171): host/ is wiring; it MAY depend on
// `vscode` to read workspace state. The architect-v2 cognition layer
// still sees only the FallbackSignalProvider port surface.
//
// Every method is best-effort: failures return empty snapshots so the
// ContextBuilder can mark the requirement unmet rather than throwing.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.VSCodeFallbackSignalProvider = void 0;
const vscode = __importStar(require("vscode"));
const DEFAULT_FILE_CHARS = 4_000;
const DEFAULT_DIAG_ITEMS = 25;
const DEFAULT_WALK_ENTRIES = 50;
const DEFAULT_HISTORY_ITEMS = 10;
class VSCodeFallbackSignalProvider {
    options;
    constructor(options = {}) {
        this.options = options;
    }
    async readEnvironment() {
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
        }
        catch {
            return {
                osPlatform: process.platform,
                editorHostName: "vscode",
                openFolderUris: [],
            };
        }
    }
    async readRecentDiagnostics(maxItems = DEFAULT_DIAG_ITEMS) {
        try {
            const out = [];
            for (const [uri, diags] of vscode.languages.getDiagnostics()) {
                for (const d of diags) {
                    out.push({
                        fileUri: uri.toString(),
                        line: d.range.start.line,
                        severity: severityName(d.severity),
                        message: d.message,
                        source: d.source,
                    });
                    if (out.length >= maxItems)
                        return out;
                }
            }
            return out;
        }
        catch {
            return [];
        }
    }
    async readFileExcerpts(input) {
        const cap = input.maxCharsPerFile ?? DEFAULT_FILE_CHARS;
        const out = [];
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
            }
            catch {
                // Skip unreadable URIs; the assembler treats them as unmet.
            }
        }
        return out;
    }
    async walkProjectShallow(maxEntries = DEFAULT_WALK_ENTRIES) {
        try {
            const folders = vscode.workspace.workspaceFolders ?? [];
            if (folders.length === 0)
                return [];
            const out = [];
            for (const folder of folders) {
                const entries = await vscode.workspace.fs.readDirectory(folder.uri);
                for (const [name, fileType] of entries) {
                    if (out.length >= maxEntries)
                        return out;
                    if (name.startsWith(".") || name === "node_modules")
                        continue;
                    const childUri = vscode.Uri.joinPath(folder.uri, name);
                    out.push({
                        uri: childUri.toString(),
                        relPath: name,
                        kind: fileType === vscode.FileType.Directory ? "directory" : "file",
                    });
                }
            }
            return out;
        }
        catch {
            return [];
        }
    }
    async readRecentHistory(taskId, maxItems = DEFAULT_HISTORY_ITEMS) {
        try {
            const deltas = this.options.readPassDeltas
                ? await this.options.readPassDeltas(taskId, maxItems)
                : [];
            return { priorPassDeltas: deltas };
        }
        catch {
            return { priorPassDeltas: [] };
        }
    }
}
exports.VSCodeFallbackSignalProvider = VSCodeFallbackSignalProvider;
function severityName(s) {
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
//# sourceMappingURL=vscode-fallback-signal-provider.js.map