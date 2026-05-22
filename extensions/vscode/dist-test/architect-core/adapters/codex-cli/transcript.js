"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Codex CLI adapter - pure transcript normalizer (Slice 1).
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeCodexTranscript = normalizeCodexTranscript;
const ANSI_CSI_RE = /\x1B\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC_RE = /\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g;
const STRAY_ESC_RE = /\x1B/g;
const ERROR_LINE_RE = /\b(?:error|errors|failed|failure|fatal|panic|exception)\b/i;
const NOT_LOGGED_IN_RE = /\b(?:not logged in|not signed in|unauthenticated|authentication required|please\s+run\s+codex\s+login)\b/i;
// Lines that are clearly Codex/MCP runtime noise rather than login-status answers.
// We strip these before the not-logged-in heuristic so unrelated tool-router or rmcp
// errors (or taskkill SUCCESS lines) cannot trigger a false CODEX_NOT_LOGGED_IN.
const RUNTIME_NOISE_LINE_RE = /(?:^\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+)|(?:\b(?:rmcp::|codex_core::|codex_mcp_server::|tools::router|tracing::|tower::|hyper::|reqwest::)\S*)|(?:^SUCCESS:\s+The process with PID\b)|(?:\brejected:\s+blocked by policy\b)/i;
function stripAnsi(text) {
    return text.replace(ANSI_OSC_RE, "").replace(ANSI_CSI_RE, "").replace(STRAY_ESC_RE, "");
}
function normalizeNewlines(text) {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
function normalizeCodexTranscript(input) {
    const cleanedStdout = stripAnsi(normalizeNewlines(input.stdout));
    const cleanedStderr = stripAnsi(normalizeNewlines(input.stderr));
    const extracted = extractCodexJsonEvents(cleanedStdout);
    const projectedAssistantText = projectCodexAssistantText(extracted.events);
    const assistantText = projectedAssistantText ?? cleanedStdout.replace(/[ \t]+\n/g, "\n").trim();
    const toolCalls = projectCodexToolCalls(extracted.events);
    const diagnostics = [];
    let hasStderrErrors = false;
    if (extracted.events.length > 0) {
        diagnostics.push(...extracted.stdoutDiagnostics);
    }
    for (const raw of cleanedStderr.split("\n")) {
        const line = raw.trim();
        if (line.length === 0)
            continue;
        diagnostics.push(line);
        if (!hasStderrErrors && ERROR_LINE_RE.test(line) && !RUNTIME_NOISE_LINE_RE.test(line)) {
            hasStderrErrors = true;
        }
    }
    const notLoggedIn = detectNotLoggedIn({
        stdout: cleanedStdout,
        stderr: cleanedStderr,
        exitCode: input.exitCode,
    });
    return {
        assistantText,
        diagnostics: Object.freeze(diagnostics),
        hasStderrErrors,
        notLoggedIn,
        toolCalls,
    };
}
/**
 * Decide whether `codex login status` actually reported an unauthenticated session.
 *
 * Rules:
 *   1. Exit code 0 is authoritative: the CLI confirmed an authenticated session.
 *      Any matching keywords in stdout/stderr at exit 0 are advisory noise (for
 *      example, MCP/router log lines that mention "rejected" or "required").
 *   2. When exit code is non-zero or unknown, scan only lines that are NOT
 *      clearly Codex/MCP runtime noise. Timestamped tracing lines, rmcp/router
 *      diagnostics, taskkill banners, and "blocked by policy" rejections are not
 *      login signals and must not trigger a CODEX_NOT_LOGGED_IN failure.
 */
function detectNotLoggedIn(input) {
    if (input.exitCode === 0)
        return false;
    const candidateLines = [];
    for (const raw of `${input.stdout}\n${input.stderr}`.split("\n")) {
        const line = raw.trim();
        if (line.length === 0)
            continue;
        if (RUNTIME_NOISE_LINE_RE.test(line))
            continue;
        candidateLines.push(line);
    }
    for (const line of candidateLines) {
        if (NOT_LOGGED_IN_RE.test(line))
            return true;
    }
    return false;
}
function extractCodexJsonEvents(stdout) {
    const events = [];
    const stdoutDiagnostics = [];
    let nonJson = "";
    let objectStart = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < stdout.length; i += 1) {
        const ch = stdout[i];
        if (objectStart < 0) {
            if (ch === "{") {
                objectStart = i;
                depth = 1;
                inString = false;
                escaped = false;
            }
            else {
                nonJson += ch;
            }
            continue;
        }
        if (inString) {
            if (escaped) {
                escaped = false;
            }
            else if (ch === "\\") {
                escaped = true;
            }
            else if (ch === "\"") {
                inString = false;
            }
            continue;
        }
        if (ch === "\"") {
            inString = true;
        }
        else if (ch === "{") {
            depth += 1;
        }
        else if (ch === "}") {
            depth -= 1;
            if (depth === 0) {
                const rawObject = stdout.slice(objectStart, i + 1);
                try {
                    events.push(JSON.parse(rawObject));
                }
                catch {
                    appendStdoutDiagnostics(stdoutDiagnostics, rawObject);
                }
                objectStart = -1;
            }
        }
    }
    if (objectStart >= 0) {
        appendStdoutDiagnostics(stdoutDiagnostics, stdout.slice(objectStart));
    }
    appendStdoutDiagnostics(stdoutDiagnostics, nonJson);
    return Object.freeze({
        events: Object.freeze(events),
        stdoutDiagnostics: Object.freeze(stdoutDiagnostics),
    });
}
function projectCodexAssistantText(events) {
    if (events.length === 0)
        return null;
    const deltaBuffer = [];
    let authoritativeText = null;
    for (const event of events) {
        const record = asRecord(event);
        const type = recordString(record, "type");
        if (type === "assistant.message") {
            const content = recordString(record, "content");
            if (content !== undefined)
                authoritativeText = content;
            continue;
        }
        if (type === "assistant.message_delta") {
            const deltaContent = recordString(record, "deltaContent");
            if (deltaContent)
                deltaBuffer.push(deltaContent);
            continue;
        }
        if (type === "item.completed") {
            const item = asRecord(record?.item);
            if (recordString(item, "type") === "agent_message") {
                const text = recordString(item, "text");
                if (text !== undefined)
                    authoritativeText = text;
            }
        }
    }
    if (authoritativeText !== null)
        return authoritativeText.trim();
    const deltaText = deltaBuffer.join("").trim();
    return deltaText.length > 0 ? deltaText : "";
}
/**
 * Project DreamGraph MCP tool invocations directly from Codex's JSON event stream.
 *
 * The MCP audit bridge is the authoritative source of recorded tool calls, but
 * when the bridge audit is empty (e.g. transport hiccup, race with `turn.completed`),
 * Codex's own `item.completed { item.type: "mcp_tool_call" }` and
 * `mcp_tool_call.completed { tool: "<server>.<tool>" }` events still witness the
 * invocation. We surface them on the transcript so the orchestrator can avoid
 * falsely classifying a grounded run as MCP_PROBE_FAILED.
 */
function projectCodexToolCalls(events) {
    if (events.length === 0)
        return Object.freeze([]);
    const calls = [];
    for (const event of events) {
        const record = asRecord(event);
        const type = recordString(record, "type");
        if (type === "item.completed") {
            const item = asRecord(record?.item);
            if (recordString(item, "type") === "mcp_tool_call") {
                const server = recordString(item, "server");
                const tool = recordString(item, "tool");
                if (server && tool)
                    calls.push({ server, tool });
            }
            continue;
        }
        if (type === "mcp_tool_call.completed" || type === "mcp_tool_call") {
            const qualified = recordString(record, "tool");
            if (qualified) {
                const dot = qualified.indexOf(".");
                if (dot > 0 && dot < qualified.length - 1) {
                    calls.push({
                        server: qualified.slice(0, dot),
                        tool: qualified.slice(dot + 1),
                    });
                }
            }
        }
    }
    return Object.freeze(calls);
}
function appendStdoutDiagnostics(target, text) {
    for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (line.length > 0)
            target.push(`stdout: ${line}`);
    }
}
function asRecord(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return undefined;
    return value;
}
function recordString(record, key) {
    const value = record?.[key];
    return typeof value === "string" ? value : undefined;
}
//# sourceMappingURL=transcript.js.map