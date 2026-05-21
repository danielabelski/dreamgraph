"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — tests for the pure NDJSON event-stream parser.
// All inputs are literal strings; no I/O.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const event_stream_js_1 = require("../architect-core/adapters/copilot-cli/event-stream.js");
function ev(type, data, extra = {}) {
    return JSON.stringify({ type, data, timestamp: "2026-05-19T16:48:00.000Z", id: `ev-${type}`, ...extra }) + "\n";
}
(0, node_test_1.default)("event-stream: parses a tool.execution_start with mcpServerName/mcpToolName", () => {
    const s = (0, event_stream_js_1.createCopilotCliEventStream)();
    const out = s.feed(ev("tool.execution_start", {
        toolCallId: "toolu_1",
        toolName: "dreamgraph-query_resource",
        arguments: { uri: "system://overview" },
        mcpServerName: "dreamgraph",
        mcpToolName: "query_resource",
        turnId: "0",
    }));
    strict_1.default.equal(out.length, 1);
    const e = out[0];
    strict_1.default.equal(e.type, "tool.execution_start");
    strict_1.default.equal(e.toolCallId, "toolu_1");
    strict_1.default.equal(e.mcpServerName, "dreamgraph");
    strict_1.default.equal(e.mcpToolName, "query_resource");
});
(0, node_test_1.default)("event-stream: parses a CLI-native tool.execution_start without mcp fields", () => {
    const s = (0, event_stream_js_1.createCopilotCliEventStream)();
    const out = s.feed(ev("tool.execution_start", {
        toolCallId: "toolu_native",
        toolName: "powershell",
        arguments: { command: "echo hi" },
    }));
    const e = out[0];
    strict_1.default.equal(e.toolName, "powershell");
    strict_1.default.equal(e.mcpServerName, undefined);
    strict_1.default.equal(e.mcpToolName, undefined);
});
(0, node_test_1.default)("event-stream: pairs start+complete by toolCallId across chunks split mid-line", () => {
    const s = (0, event_stream_js_1.createCopilotCliEventStream)();
    const startLine = ev("tool.execution_start", {
        toolCallId: "tc-1",
        toolName: "glob",
        arguments: { pattern: "**/*.ts" },
    });
    const completeLine = ev("tool.execution_complete", {
        toolCallId: "tc-1",
        toolName: "glob",
        success: true,
        result: { matches: 3 },
    });
    // split arbitrarily mid-line
    const mid = Math.floor((startLine.length + completeLine.length) / 2);
    const blob = startLine + completeLine;
    const a = s.feed(blob.slice(0, mid));
    const b = s.feed(blob.slice(mid));
    const combined = [...a, ...b];
    strict_1.default.equal(combined.length, 2);
    strict_1.default.equal(combined[0].type, "tool.execution_start");
    strict_1.default.equal(combined[1].type, "tool.execution_complete");
    const done = combined[1];
    strict_1.default.equal(done.toolCallId, "tc-1");
    strict_1.default.equal(done.success, true);
});
(0, node_test_1.default)("event-stream: accumulates assistant deltas and snapshotAssistantText concatenates them", () => {
    const s = (0, event_stream_js_1.createCopilotCliEventStream)();
    s.feed(ev("assistant.message_delta", { deltaContent: "Hello " }));
    s.feed(ev("assistant.message_delta", { deltaContent: "world" }));
    s.feed(ev("assistant.message_delta", { deltaContent: "!" }));
    strict_1.default.equal(s.snapshotAssistantText(), "Hello world!");
});
(0, node_test_1.default)("event-stream: assistant.message replaces accumulated deltas as authoritative", () => {
    const s = (0, event_stream_js_1.createCopilotCliEventStream)();
    s.feed(ev("assistant.message_delta", { deltaContent: "partial" }));
    s.feed(ev("assistant.message", { content: "FINAL TEXT" }));
    strict_1.default.equal(s.snapshotAssistantText(), "FINAL TEXT");
});
(0, node_test_1.default)("event-stream: reasoning deltas are emitted but do NOT contribute to assistant text", () => {
    const s = (0, event_stream_js_1.createCopilotCliEventStream)();
    const out = s.feed(ev("assistant.reasoning_delta", { deltaContent: "thinking..." }));
    const e = out[0];
    strict_1.default.equal(e.type, "assistant.reasoning_delta");
    strict_1.default.equal(s.snapshotAssistantText(), "");
});
(0, node_test_1.default)("event-stream: result event is parsed with sessionId/exitCode/usage", () => {
    const s = (0, event_stream_js_1.createCopilotCliEventStream)();
    const out = s.feed(ev("result", {
        sessionId: "sess-1",
        exitCode: 0,
        usage: { premiumRequests: 1, totalApiDurationMs: 1234 },
    }));
    const r = out[0];
    strict_1.default.equal(r.type, "result");
    strict_1.default.equal(r.sessionId, "sess-1");
    strict_1.default.equal(r.exitCode, 0);
    strict_1.default.deepEqual(r.usage, { premiumRequests: 1, totalApiDurationMs: 1234 });
});
(0, node_test_1.default)("event-stream: unknown event types surface as `other` without losing data", () => {
    const s = (0, event_stream_js_1.createCopilotCliEventStream)();
    const out = s.feed(JSON.stringify({ type: "session.tools_updated", data: { model: "claude" }, timestamp: "t" }) + "\n");
    const e = out[0];
    strict_1.default.equal(e.type, "_other");
    strict_1.default.equal(e.rawType, "session.tools_updated");
    strict_1.default.deepEqual(e.data, { model: "claude" });
});
(0, node_test_1.default)("event-stream: malformed JSON lines and blank lines are skipped silently", () => {
    const s = (0, event_stream_js_1.createCopilotCliEventStream)();
    const out = s.feed("not-json\n\n{ broken\n" + ev("result", { sessionId: "ok" }));
    strict_1.default.equal(out.length, 1);
    strict_1.default.equal(out[0].type, "result");
});
(0, node_test_1.default)("event-stream: events missing required fields are dropped", () => {
    const s = (0, event_stream_js_1.createCopilotCliEventStream)();
    // tool.execution_start missing toolCallId
    const out = s.feed(JSON.stringify({ type: "tool.execution_start", data: { toolName: "x" }, timestamp: "t" }) + "\n");
    strict_1.default.equal(out.length, 0);
});
(0, node_test_1.default)("event-stream: flush() emits a buffered trailing line missing its newline", () => {
    const s = (0, event_stream_js_1.createCopilotCliEventStream)();
    // Feed without trailing newline
    s.feed(JSON.stringify({ type: "result", data: { sessionId: "trailing" }, timestamp: "t" }));
    const drained = s.flush();
    strict_1.default.equal(drained.length, 1);
    const r = drained[0];
    strict_1.default.equal(r.sessionId, "trailing");
});
(0, node_test_1.default)("event-stream: handles \\r\\n line endings", () => {
    const s = (0, event_stream_js_1.createCopilotCliEventStream)();
    const line = JSON.stringify({ type: "assistant.message_delta", data: { deltaContent: "hi" }, timestamp: "t" });
    s.feed(line + "\r\n");
    strict_1.default.equal(s.snapshotAssistantText(), "hi");
});
(0, node_test_1.default)("event-stream: assistant.message_delta with empty deltaContent is dropped (no zero-byte events)", () => {
    const s = (0, event_stream_js_1.createCopilotCliEventStream)();
    const out = s.feed(ev("assistant.message_delta", { deltaContent: "" }));
    strict_1.default.equal(out.length, 0);
    strict_1.default.equal(s.snapshotAssistantText(), "");
});
(0, node_test_1.default)("event-stream: tool.execution_complete defaults success=true when field missing", () => {
    const s = (0, event_stream_js_1.createCopilotCliEventStream)();
    const out = s.feed(JSON.stringify({
        type: "tool.execution_complete",
        data: { toolCallId: "tc-x", toolName: "glob", result: {} },
        timestamp: "t",
    }) + "\n");
    const c = out[0];
    strict_1.default.equal(c.success, true);
});
(0, node_test_1.default)("event-stream: feed() returns events in arrival order across multiple lines in one chunk", () => {
    const s = (0, event_stream_js_1.createCopilotCliEventStream)();
    const blob = ev("assistant.message_delta", { deltaContent: "A" }) +
        ev("assistant.message_delta", { deltaContent: "B" }) +
        ev("result", { sessionId: "z" });
    const out = s.feed(blob);
    strict_1.default.equal(out.length, 3);
    strict_1.default.equal(out[0].deltaContent, "A");
    strict_1.default.equal(out[1].deltaContent, "B");
    strict_1.default.equal(out[2].type, "result");
});
(0, node_test_1.default)("event-stream: assistant.message with empty content is dropped", () => {
    const s = (0, event_stream_js_1.createCopilotCliEventStream)();
    const out = s.feed(ev("assistant.message", { content: "" }));
    strict_1.default.equal(out.length, 0);
    strict_1.default.equal(s.snapshotAssistantText(), "");
});
//# sourceMappingURL=copilot-cli-event-stream.test.js.map