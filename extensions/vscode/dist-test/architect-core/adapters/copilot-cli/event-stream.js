"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — pure NDJSON event-stream parser.
//
// Copilot CLI invoked with `--output-format json` writes one JSON
// object per line to stdout. Each object is a typed event:
//
//   • `tool.execution_start`     — a tool (CLI-native OR MCP-served)
//                                  has been invoked. Carries
//                                  `toolCallId`, `toolName`, raw
//                                  `arguments`, and for MCP calls an
//                                  explicit `mcpServerName` +
//                                  `mcpToolName` pair.
//   • `tool.execution_complete`  — the same `toolCallId` finished.
//                                  Carries `success` and a free-form
//                                  `result` payload.
//   • `assistant.message_delta`  — incremental assistant text. Each
//                                  event holds a `deltaContent`
//                                  fragment. Concatenated in arrival
//                                  order they reproduce the message.
//   • `assistant.reasoning_delta`— same shape as message_delta but
//                                  for the model's internal reasoning
//                                  channel.
//   • `assistant.message`        — authoritative final assistant
//                                  text for a turn. When present it
//                                  supersedes the accumulated deltas.
//   • `result`                   — session-level summary emitted once
//                                  at run end (sessionId, exitCode,
//                                  usage).
//
// Unknown event types are surfaced as a generic `other` variant so the
// caller can record them in audit without losing data.
//
// Pure: no I/O, no time, no randomness. The parser is line-buffered
// with a carry slot so partial chunks are stitched together correctly
// across multiple `feed()` calls. Malformed lines (invalid JSON, or
// missing the required `type` field) are skipped silently — the CLI
// occasionally emits an empty line at the end of the stream and this
// must not break the run.
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCopilotCliEventStream = createCopilotCliEventStream;
const ASSISTANT_DELTA_TYPES = new Set([
    "assistant.message_delta",
    "assistant.reasoning_delta",
]);
function parseLineToEvent(line) {
    const trimmed = line.trim();
    if (trimmed.length === 0)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    }
    catch {
        return null;
    }
    if (typeof parsed !== "object" || parsed === null)
        return null;
    const obj = parsed;
    const type = obj.type;
    if (typeof type !== "string" || type.length === 0)
        return null;
    const timestamp = typeof obj.timestamp === "string" ? obj.timestamp : "";
    const id = typeof obj.id === "string" ? obj.id : undefined;
    const data = (obj.data && typeof obj.data === "object" ? obj.data : {});
    if (type === "tool.execution_start") {
        const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : "";
        const toolName = typeof data.toolName === "string" ? data.toolName : "";
        if (toolCallId.length === 0 || toolName.length === 0)
            return null;
        const mcpServerName = typeof data.mcpServerName === "string" ? data.mcpServerName : undefined;
        const mcpToolName = typeof data.mcpToolName === "string" ? data.mcpToolName : undefined;
        const turnId = typeof data.turnId === "string" ? data.turnId : undefined;
        const ev = {
            type: "tool.execution_start",
            toolCallId,
            toolName,
            arguments: data.arguments,
            ...(mcpServerName !== undefined ? { mcpServerName } : {}),
            ...(mcpToolName !== undefined ? { mcpToolName } : {}),
            timestamp,
            ...(turnId !== undefined ? { turnId } : {}),
            ...(id !== undefined ? { id } : {}),
        };
        return ev;
    }
    if (type === "tool.execution_complete") {
        const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : "";
        const toolName = typeof data.toolName === "string" ? data.toolName : "";
        if (toolCallId.length === 0)
            return null;
        const success = typeof data.success === "boolean" ? data.success : true;
        const ev = {
            type: "tool.execution_complete",
            toolCallId,
            toolName,
            success,
            result: data.result,
            timestamp,
            ...(id !== undefined ? { id } : {}),
        };
        return ev;
    }
    if (ASSISTANT_DELTA_TYPES.has(type)) {
        const deltaContent = typeof data.deltaContent === "string" ? data.deltaContent : "";
        if (deltaContent.length === 0)
            return null;
        const messageId = typeof data.messageId === "string" ? data.messageId : undefined;
        const ev = {
            type: type,
            deltaContent,
            ...(messageId !== undefined ? { messageId } : {}),
            timestamp,
            ...(id !== undefined ? { id } : {}),
        };
        return ev;
    }
    if (type === "assistant.message") {
        const content = typeof data.content === "string" ? data.content : "";
        if (content.length === 0)
            return null;
        const messageId = typeof data.messageId === "string" ? data.messageId : undefined;
        const ev = {
            type: "assistant.message",
            content,
            ...(messageId !== undefined ? { messageId } : {}),
            timestamp,
            ...(id !== undefined ? { id } : {}),
        };
        return ev;
    }
    if (type === "result") {
        const sessionId = typeof data.sessionId === "string" ? data.sessionId : undefined;
        const exitCode = typeof data.exitCode === "number" ? data.exitCode : undefined;
        const usage = data.usage;
        const ev = {
            type: "result",
            ...(sessionId !== undefined ? { sessionId } : {}),
            ...(exitCode !== undefined ? { exitCode } : {}),
            ...(usage !== undefined ? { usage } : {}),
            timestamp,
            ...(id !== undefined ? { id } : {}),
        };
        return ev;
    }
    const other = {
        type: "_other",
        rawType: type,
        ...(obj.data !== undefined ? { data: obj.data } : {}),
        ...(timestamp.length > 0 ? { timestamp } : {}),
        ...(id !== undefined ? { id } : {}),
    };
    return other;
}
function createCopilotCliEventStream() {
    let carry = "";
    // Accumulated assistant text from message_delta events, in arrival
    // order. Replaced wholesale when an `assistant.message` event arrives.
    const deltaBuffer = [];
    let authoritativeMessage = null;
    // Track the active `messageId` so we can insert paragraph breaks
    // between distinct assistant messages within a single turn. Some
    // CLI/model pairs emit per-step "thoughts" as separate messages
    // (each with its own `messageId`) and the deltas within each
    // message contain prose but no trailing newline. Without an
    // explicit boundary, joined deltas read as run-on text.
    let lastDeltaMessageId = null;
    function ingest(line, out) {
        const ev = parseLineToEvent(line);
        if (!ev)
            return;
        if (ev.type === "assistant.message_delta") {
            const mid = ev.messageId ?? null;
            if (lastDeltaMessageId !== null &&
                mid !== null &&
                mid !== lastDeltaMessageId &&
                deltaBuffer.length > 0) {
                const tail = deltaBuffer[deltaBuffer.length - 1] ?? "";
                if (!tail.endsWith("\n\n")) {
                    deltaBuffer.push(tail.endsWith("\n") ? "\n" : "\n\n");
                }
            }
            lastDeltaMessageId = mid;
            deltaBuffer.push(ev.deltaContent);
        }
        else if (ev.type === "assistant.message") {
            authoritativeMessage = ev.content;
        }
        out.push(ev);
    }
    return Object.freeze({
        feed(chunk) {
            const out = [];
            if (chunk.length === 0)
                return out;
            const combined = carry + chunk;
            // Walk by line — handle both `\n` and `\r\n` cleanly. We use a
            // manual scan rather than split() so the carry slot is exact.
            let start = 0;
            let i = 0;
            while (i < combined.length) {
                const ch = combined.charCodeAt(i);
                if (ch === 10 /* \n */) {
                    let end = i;
                    if (end > start && combined.charCodeAt(end - 1) === 13 /* \r */)
                        end -= 1;
                    ingest(combined.slice(start, end), out);
                    i += 1;
                    start = i;
                }
                else {
                    i += 1;
                }
            }
            carry = combined.slice(start);
            return out;
        },
        flush() {
            const out = [];
            if (carry.length > 0) {
                ingest(carry, out);
                carry = "";
            }
            return out;
        },
        snapshotAssistantText() {
            if (authoritativeMessage !== null)
                return authoritativeMessage;
            if (deltaBuffer.length === 0)
                return "";
            return deltaBuffer.join("");
        },
    });
}
//# sourceMappingURL=event-stream.js.map