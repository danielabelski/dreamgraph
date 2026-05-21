"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — real `CopilotCliMcpAuditPort` (Slice 3b).
//
// The bridge process (see `bridge-entry.ts`) writes one NDJSON line
// per `tools/call` it observes between Copilot CLI and the in-process
// DreamGraph MCP server. This adapter reads those lines back into
// `RecordedMcpToolCall` records and then deletes the file.
//
// Wire format (per line, written by the bridge):
//   {"server":"dreamgraph","tool":"query_resource","inputJson":"{…}",
//    "resultJson":"{…}","isError":false,"durationMs":12,
//    "startedAtEpochMs":1763000000000}
//
// Two records sharing the same JSON-RPC `id` are NEVER produced — the
// bridge already paired request and response before writing.
//
// Hard rules respected:
//   - The bridge writes the audit file. The orchestrator passes
//     `DREAMGRAPH_AUDIT_PATH` to the bridge via the MCP server env in
//     `mcp-config.json` (Copilot CLI propagates env to MCP child
//     processes verbatim). This adapter MUST agree with the bridge on
//     the path, hence the shared `auditFilePathFor(runId)` helper.
//   - Empty file → empty array (legitimate "run made no MCP calls").
//   - Missing file → empty array (bridge never started, or run failed
//     before any tool call). Never throws on absence.
//   - Malformed lines → skipped silently with a stderr warning. We
//     never let one bad record poison the rest of the run.
Object.defineProperty(exports, "__esModule", { value: true });
exports.auditFilePathFor = auditFilePathFor;
exports.createHostAudit = createHostAudit;
exports.parseRecordOrNull = parseRecordOrNull;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
/**
 * Compute the audit NDJSON path for a given run. The bridge calls the
 * same function so adapter and bridge stay in lockstep without sharing
 * a runtime module.
 */
function auditFilePathFor(auditDirAbsPath, runId) {
    if (!auditDirAbsPath || auditDirAbsPath.length === 0) {
        throw new Error("auditFilePathFor: auditDirAbsPath is required");
    }
    if (!runId || runId.length === 0) {
        throw new Error("auditFilePathFor: runId is required");
    }
    // Sanitize runId for filesystem safety; the orchestrator's runIds
    // are already URL-safe but we belt-and-brace here.
    const safeRunId = runId.replace(/[^A-Za-z0-9._-]/g, "_");
    return (0, node_path_1.join)(auditDirAbsPath, `${safeRunId}.ndjson`);
}
function createHostAudit(opts) {
    if (!opts || typeof opts.auditDirAbsPath !== "string" || opts.auditDirAbsPath.length === 0) {
        throw new Error("createHostAudit: auditDirAbsPath is required");
    }
    const recordings = new Map();
    return Object.freeze({
        async startRecording(runId) {
            if (!runId || runId.length === 0) {
                throw new Error("startRecording: runId is required");
            }
            // Ensure the audit directory exists so the bridge can open the
            // file in append mode without racing on `mkdir`.
            await (0, promises_1.mkdir)(opts.auditDirAbsPath, { recursive: true });
            const path = auditFilePathFor(opts.auditDirAbsPath, runId);
            // Idempotent: re-recording the same runId resets the start clock
            // but does NOT delete an existing audit file (the bridge owns
            // file lifecycle; double-start is a programmer error in the
            // orchestrator, not this port's responsibility to recover from).
            recordings.set(runId, { path, startedAtEpochMs: Date.now() });
        },
        async finishRecording(runId) {
            if (!runId || runId.length === 0) {
                throw new Error("finishRecording: runId is required");
            }
            const state = recordings.get(runId);
            if (!state) {
                // Either we already finished (port contract: second call is
                // empty) or startRecording was never invoked. Both → empty.
                return Object.freeze([]);
            }
            recordings.delete(runId);
            let raw;
            try {
                await (0, promises_1.stat)(state.path);
                raw = await (0, promises_1.readFile)(state.path, "utf8");
            }
            catch {
                // No audit file exists → run made zero MCP calls.
                return Object.freeze([]);
            }
            const lines = raw.split(/\r?\n/);
            const out = [];
            for (let i = 0; i < lines.length; i += 1) {
                const line = lines[i].trim();
                if (line.length === 0)
                    continue;
                const parsed = parseRecordOrNull(line);
                if (parsed === null) {
                    // eslint-disable-next-line no-console
                    console.warn(`[copilot-cli audit] skipped malformed record at ${state.path}:${i + 1}`);
                    continue;
                }
                out.push(parsed);
            }
            // Best-effort delete: the audit file lives inside COPILOT_HOME,
            // which the orchestrator scrubs anyway. Failing to delete is
            // not an audit-correctness problem.
            try {
                await (0, promises_1.rm)(state.path, { force: true });
            }
            catch {
                /* ignore */
            }
            return Object.freeze(out);
        },
    });
}
/**
 * Parse one NDJSON line written by the bridge into a frozen
 * `RecordedMcpToolCall`, or return `null` if the line is not a
 * well-formed audit record. Shared with the live tail reader
 * (`audit-live-adapter.ts`) so both readers agree on the wire format.
 */
function parseRecordOrNull(line) {
    let raw;
    try {
        raw = JSON.parse(line);
    }
    catch {
        return null;
    }
    if (typeof raw !== "object" || raw === null)
        return null;
    const r = raw;
    if (typeof r["server"] !== "string" ||
        typeof r["tool"] !== "string" ||
        typeof r["inputJson"] !== "string" ||
        typeof r["resultJson"] !== "string" ||
        typeof r["isError"] !== "boolean" ||
        typeof r["durationMs"] !== "number" ||
        typeof r["startedAtEpochMs"] !== "number") {
        return null;
    }
    return Object.freeze({
        server: r["server"],
        tool: r["tool"],
        inputJson: r["inputJson"],
        resultJson: r["resultJson"],
        isError: r["isError"],
        durationMs: r["durationMs"],
        startedAtEpochMs: r["startedAtEpochMs"],
    });
}
//# sourceMappingURL=audit-adapter.js.map