"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.NullFallbackSignalProvider = exports.NULL_RECENT_HISTORY = exports.NULL_ENVIRONMENT = void 0;
// ---------------------------------------------------------------------------
// Null implementation (default; used in tests + when no host adapter wired)
// ---------------------------------------------------------------------------
exports.NULL_ENVIRONMENT = Object.freeze({
    osPlatform: "unknown",
    editorHostName: "none",
    openFolderUris: Object.freeze([]),
});
exports.NULL_RECENT_HISTORY = Object.freeze({
    priorPassDeltas: Object.freeze([]),
});
class NullFallbackSignalProvider {
    async readEnvironment() {
        return exports.NULL_ENVIRONMENT;
    }
    async readRecentDiagnostics() {
        return [];
    }
    async readFileExcerpts() {
        return [];
    }
    async walkProjectShallow() {
        return [];
    }
    async readRecentHistory() {
        return exports.NULL_RECENT_HISTORY;
    }
}
exports.NullFallbackSignalProvider = NullFallbackSignalProvider;
//# sourceMappingURL=fallback-signals.js.map