// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — tests for the pure NDJSON event-stream parser.
// All inputs are literal strings; no I/O.

import test from "node:test";
import assert from "node:assert/strict";

import {
  createCopilotCliEventStream,
  type CliJsonAssistantDeltaEvent,
  type CliJsonAssistantMessageEvent,
  type CliJsonOtherEvent,
  type CliJsonResultEvent,
  type CliJsonToolCompleteEvent,
  type CliJsonToolStartEvent,
} from "../architect-core/adapters/copilot-cli/event-stream.js";

function ev(type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, data, timestamp: "2026-05-19T16:48:00.000Z", id: `ev-${type}`, ...extra }) + "\n";
}

test("event-stream: parses a tool.execution_start with mcpServerName/mcpToolName", () => {
  const s = createCopilotCliEventStream();
  const out = s.feed(ev("tool.execution_start", {
    toolCallId: "toolu_1",
    toolName: "dreamgraph-query_resource",
    arguments: { uri: "system://overview" },
    mcpServerName: "dreamgraph",
    mcpToolName: "query_resource",
    turnId: "0",
  }));
  assert.equal(out.length, 1);
  const e = out[0] as CliJsonToolStartEvent;
  assert.equal(e.type, "tool.execution_start");
  assert.equal(e.toolCallId, "toolu_1");
  assert.equal(e.mcpServerName, "dreamgraph");
  assert.equal(e.mcpToolName, "query_resource");
});

test("event-stream: parses a CLI-native tool.execution_start without mcp fields", () => {
  const s = createCopilotCliEventStream();
  const out = s.feed(ev("tool.execution_start", {
    toolCallId: "toolu_native",
    toolName: "powershell",
    arguments: { command: "echo hi" },
  }));
  const e = out[0] as CliJsonToolStartEvent;
  assert.equal(e.toolName, "powershell");
  assert.equal(e.mcpServerName, undefined);
  assert.equal(e.mcpToolName, undefined);
});

test("event-stream: pairs start+complete by toolCallId across chunks split mid-line", () => {
  const s = createCopilotCliEventStream();
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
  assert.equal(combined.length, 2);
  assert.equal(combined[0]!.type, "tool.execution_start");
  assert.equal(combined[1]!.type, "tool.execution_complete");
  const done = combined[1] as CliJsonToolCompleteEvent;
  assert.equal(done.toolCallId, "tc-1");
  assert.equal(done.success, true);
});

test("event-stream: accumulates assistant deltas and snapshotAssistantText concatenates them", () => {
  const s = createCopilotCliEventStream();
  s.feed(ev("assistant.message_delta", { deltaContent: "Hello " }));
  s.feed(ev("assistant.message_delta", { deltaContent: "world" }));
  s.feed(ev("assistant.message_delta", { deltaContent: "!" }));
  assert.equal(s.snapshotAssistantText(), "Hello world!");
});

test("event-stream: assistant.message replaces accumulated deltas as authoritative", () => {
  const s = createCopilotCliEventStream();
  s.feed(ev("assistant.message_delta", { deltaContent: "partial" }));
  s.feed(ev("assistant.message", { content: "FINAL TEXT" }));
  assert.equal(s.snapshotAssistantText(), "FINAL TEXT");
});

test("event-stream: reasoning deltas are emitted but do NOT contribute to assistant text", () => {
  const s = createCopilotCliEventStream();
  const out = s.feed(ev("assistant.reasoning_delta", { deltaContent: "thinking..." }));
  const e = out[0] as CliJsonAssistantDeltaEvent;
  assert.equal(e.type, "assistant.reasoning_delta");
  assert.equal(s.snapshotAssistantText(), "");
});

test("event-stream: result event is parsed with sessionId/exitCode/usage", () => {
  const s = createCopilotCliEventStream();
  const out = s.feed(ev("result", {
    sessionId: "sess-1",
    exitCode: 0,
    usage: { premiumRequests: 1, totalApiDurationMs: 1234 },
  }));
  const r = out[0] as CliJsonResultEvent;
  assert.equal(r.type, "result");
  assert.equal(r.sessionId, "sess-1");
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.usage, { premiumRequests: 1, totalApiDurationMs: 1234 });
});

test("event-stream: unknown event types surface as `other` without losing data", () => {
  const s = createCopilotCliEventStream();
  const out = s.feed(JSON.stringify({ type: "session.tools_updated", data: { model: "claude" }, timestamp: "t" }) + "\n");
  const e = out[0] as CliJsonOtherEvent;
  assert.equal(e.type, "_other");
  assert.equal(e.rawType, "session.tools_updated");
  assert.deepEqual(e.data, { model: "claude" });
});

test("event-stream: malformed JSON lines and blank lines are skipped silently", () => {
  const s = createCopilotCliEventStream();
  const out = s.feed("not-json\n\n{ broken\n" + ev("result", { sessionId: "ok" }));
  assert.equal(out.length, 1);
  assert.equal((out[0] as CliJsonResultEvent).type, "result");
});

test("event-stream: events missing required fields are dropped", () => {
  const s = createCopilotCliEventStream();
  // tool.execution_start missing toolCallId
  const out = s.feed(JSON.stringify({ type: "tool.execution_start", data: { toolName: "x" }, timestamp: "t" }) + "\n");
  assert.equal(out.length, 0);
});

test("event-stream: flush() emits a buffered trailing line missing its newline", () => {
  const s = createCopilotCliEventStream();
  // Feed without trailing newline
  s.feed(JSON.stringify({ type: "result", data: { sessionId: "trailing" }, timestamp: "t" }));
  const drained = s.flush();
  assert.equal(drained.length, 1);
  const r = drained[0] as CliJsonResultEvent;
  assert.equal(r.sessionId, "trailing");
});

test("event-stream: handles \\r\\n line endings", () => {
  const s = createCopilotCliEventStream();
  const line = JSON.stringify({ type: "assistant.message_delta", data: { deltaContent: "hi" }, timestamp: "t" });
  s.feed(line + "\r\n");
  assert.equal(s.snapshotAssistantText(), "hi");
});

test("event-stream: assistant.message_delta with empty deltaContent is dropped (no zero-byte events)", () => {
  const s = createCopilotCliEventStream();
  const out = s.feed(ev("assistant.message_delta", { deltaContent: "" }));
  assert.equal(out.length, 0);
  assert.equal(s.snapshotAssistantText(), "");
});

test("event-stream: tool.execution_complete defaults success=true when field missing", () => {
  const s = createCopilotCliEventStream();
  const out = s.feed(JSON.stringify({
    type: "tool.execution_complete",
    data: { toolCallId: "tc-x", toolName: "glob", result: {} },
    timestamp: "t",
  }) + "\n");
  const c = out[0] as CliJsonToolCompleteEvent;
  assert.equal(c.success, true);
});

test("event-stream: feed() returns events in arrival order across multiple lines in one chunk", () => {
  const s = createCopilotCliEventStream();
  const blob =
    ev("assistant.message_delta", { deltaContent: "A" }) +
    ev("assistant.message_delta", { deltaContent: "B" }) +
    ev("result", { sessionId: "z" });
  const out = s.feed(blob);
  assert.equal(out.length, 3);
  assert.equal((out[0] as CliJsonAssistantDeltaEvent).deltaContent, "A");
  assert.equal((out[1] as CliJsonAssistantDeltaEvent).deltaContent, "B");
  assert.equal((out[2] as CliJsonResultEvent).type, "result");
});

test("event-stream: assistant.message with empty content is dropped", () => {
  const s = createCopilotCliEventStream();
  const out = s.feed(ev("assistant.message", { content: "" }));
  assert.equal(out.length, 0);
  assert.equal(s.snapshotAssistantText(), "");
});
