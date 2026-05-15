"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — pure transcript normalizer (Slice 2).
//
// Captured stdout/stderr from a Copilot CLI run is normalized into
// the orchestrator's `CopilotCliTranscript`:
//   • `assistantText` — the user-visible model output, cleaned of
//     ANSI escape sequences and stray carriage returns.
//   • `diagnostics`   — best-effort lines extracted from stderr
//     (Copilot CLI emits warnings/errors there).
//
// IMPORTANT: This normalizer does NOT attempt to parse tool-call
// markers out of stdout. The CLI's human-readable transcript shape
// varies between versions and is fragile to regex against. The
// authoritative source of truth for tool calls is the in-process
// DreamGraph MCP audit port (`CopilotCliMcpAuditPort`), which
// observes every call the model actually made via the
// stdio-bridge — that source is robust regardless of how the CLI
// chooses to render the transcript.
//
// Pure: no I/O, no time, no randomness. Safe to call in tests with
// literal strings.
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeCopilotTranscript = normalizeCopilotTranscript;
// CSI sequences (`ESC [ … letter`) plus standalone `ESC` artifacts.
// Conservative on purpose: only strips well-formed ANSI; never touches
// printable bytes that happen to look similar.
const ANSI_CSI_RE = /\x1B\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC_RE = /\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g;
const STRAY_ESC_RE = /\x1B/g;
const ERROR_LINE_RE = /\b(?:error|errors|failed|failure|fatal|panic|exception)\b/i;
function stripAnsi(text) {
    return text.replace(ANSI_OSC_RE, "").replace(ANSI_CSI_RE, "").replace(STRAY_ESC_RE, "");
}
function normalizeNewlines(text) {
    // Replace bare CR with LF, collapse CRLF to LF — the CLI uses both
    // depending on whether stdout is a TTY.
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
function normalizeCopilotTranscript(input) {
    const cleanedStdout = stripAnsi(normalizeNewlines(input.stdout));
    const cleanedStderr = stripAnsi(normalizeNewlines(input.stderr));
    const assistantText = cleanedStdout.replace(/[ \t]+\n/g, "\n").trim();
    const diagnostics = [];
    let hasStderrErrors = false;
    for (const raw of cleanedStderr.split("\n")) {
        const line = raw.trim();
        if (line.length === 0)
            continue;
        diagnostics.push(line);
        if (!hasStderrErrors && ERROR_LINE_RE.test(line)) {
            hasStderrErrors = true;
        }
    }
    return {
        assistantText,
        diagnostics: Object.freeze(diagnostics),
        hasStderrErrors,
    };
}
//# sourceMappingURL=transcript.js.map