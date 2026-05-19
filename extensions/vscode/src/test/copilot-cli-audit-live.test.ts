// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — tests for the live tail of the per-run MCP
// audit NDJSON (`createHostAuditLive`).
//
// Real `node:fs` operations against per-test tmp dirs. The bridge
// process is not involved here — we simulate its `appendFileSync`
// behaviour by writing NDJSON lines directly. Bridge↔audit integration
// is covered separately in `copilot-cli-bridge-audit.test.ts`.

import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  auditFilePathFor,
  createHostAuditLive,
  MAX_LIVE_RESULT_JSON_BYTES,
} from "../architect-core/adapters/copilot-cli/host/index.js";

import type { RecordedMcpToolCall } from "../architect-core/adapters/copilot-cli/orchestrator-ports.js";

function makeLine(overrides: Partial<RecordedMcpToolCall> = {}): string {
  const rec: RecordedMcpToolCall = {
    server: "dreamgraph",
    tool: "query_resource",
    inputJson: '{"uri":"system://overview"}',
    resultJson: '{"ok":true}',
    isError: false,
    durationMs: 5,
    startedAtEpochMs: 1763000000000,
    ...overrides,
  };
  return JSON.stringify(rec) + "\n";
}

/** Wait until `predicate()` is truthy or `timeoutMs` elapses. */
async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2000,
  stepMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitUntil: predicate did not become true within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

test("createHostAuditLive: rejects empty auditDirAbsPath", () => {
  // @ts-expect-error testing invalid input
  assert.throws(() => createHostAuditLive({}));
  assert.throws(() => createHostAuditLive({ auditDirAbsPath: "" }));
});

test("subscribe with no existing file → catch-up empty, future records delivered", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dg-audit-live-future-"));
  try {
    const live = createHostAuditLive({ auditDirAbsPath: dir, heartbeatMs: 50 });
    const received: RecordedMcpToolCall[] = [];
    const sub = await live.subscribe("run-1", (call) => received.push(call));

    assert.equal(received.length, 0, "no catch-up records expected");

    const path = auditFilePathFor(dir, "run-1");
    await writeFile(path, makeLine({ tool: "alpha" }));
    await appendFile(path, makeLine({ tool: "beta" }));

    await waitUntil(() => received.length >= 2);
    assert.equal(received.length, 2);
    assert.equal(received[0]!.tool, "alpha");
    assert.equal(received[1]!.tool, "beta");

    await sub.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("subscribe after records exist → catch-up replays them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dg-audit-live-catchup-"));
  try {
    const path = auditFilePathFor(dir, "run-2");
    await writeFile(path, makeLine({ tool: "preexisting-a" }) + makeLine({ tool: "preexisting-b" }));

    const live = createHostAuditLive({ auditDirAbsPath: dir, heartbeatMs: 0 });
    const received: RecordedMcpToolCall[] = [];
    const sub = await live.subscribe("run-2", (call) => received.push(call));

    assert.equal(received.length, 2);
    assert.equal(received[0]!.tool, "preexisting-a");
    assert.equal(received[1]!.tool, "preexisting-b");

    await sub.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("partial trailing line is buffered until newline arrives", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dg-audit-live-partial-"));
  try {
    const live = createHostAuditLive({ auditDirAbsPath: dir, heartbeatMs: 25 });
    const received: RecordedMcpToolCall[] = [];
    const sub = await live.subscribe("run-3", (call) => received.push(call));

    const path = auditFilePathFor(dir, "run-3");
    const first = makeLine({ tool: "full-line" });
    const partial = '{"server":"dreamgraph","tool":"split","inputJson":"{}","resultJson":"{}","isError":false,"durationMs":1,"startedAtEpochMs":1';
    await writeFile(path, first + partial);

    await waitUntil(() => received.length >= 1);
    assert.equal(received.length, 1, "partial line must not be delivered");
    assert.equal(received[0]!.tool, "full-line");

    await appendFile(path, '}\n');
    await waitUntil(() => received.length >= 2);
    assert.equal(received[1]!.tool, "split");

    await sub.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("malformed line is skipped silently", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dg-audit-live-bad-"));
  try {
    const path = auditFilePathFor(dir, "run-4");
    await writeFile(path, makeLine({ tool: "ok-1" }) + "not-json\n" + makeLine({ tool: "ok-2" }));

    const live = createHostAuditLive({ auditDirAbsPath: dir, heartbeatMs: 0 });
    const received: RecordedMcpToolCall[] = [];
    const sub = await live.subscribe("run-4", (call) => received.push(call));

    assert.equal(received.length, 2);
    assert.equal(received[0]!.tool, "ok-1");
    assert.equal(received[1]!.tool, "ok-2");

    await sub.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("close() stops further deliveries and is idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dg-audit-live-close-"));
  try {
    const live = createHostAuditLive({ auditDirAbsPath: dir, heartbeatMs: 25 });
    const received: RecordedMcpToolCall[] = [];
    const sub = await live.subscribe("run-5", (call) => received.push(call));

    const path = auditFilePathFor(dir, "run-5");
    await writeFile(path, makeLine({ tool: "before" }));
    await waitUntil(() => received.length >= 1);

    await sub.close();
    await sub.close(); // idempotent

    await appendFile(path, makeLine({ tool: "after" }));
    // Give the (now-disposed) heartbeat plenty of time to NOT fire.
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(received.length, 1, "no events should arrive after close");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("handler exception does not break subsequent deliveries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dg-audit-live-throw-"));
  try {
    const path = auditFilePathFor(dir, "run-6");
    await writeFile(path, makeLine({ tool: "throw-me" }) + makeLine({ tool: "deliver-me" }));

    const live = createHostAuditLive({ auditDirAbsPath: dir, heartbeatMs: 0 });
    const received: RecordedMcpToolCall[] = [];
    const sub = await live.subscribe("run-6", (call) => {
      if (call.tool === "throw-me") throw new Error("boom");
      received.push(call);
    });

    assert.equal(received.length, 1);
    assert.equal(received[0]!.tool, "deliver-me");

    await sub.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resultJson larger than 4 KB is truncated for the live channel", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dg-audit-live-trunc-"));
  try {
    const huge = "x".repeat(MAX_LIVE_RESULT_JSON_BYTES * 2);
    const path = auditFilePathFor(dir, "run-7");
    await writeFile(path, makeLine({ tool: "big", resultJson: huge }));

    const live = createHostAuditLive({ auditDirAbsPath: dir, heartbeatMs: 0 });
    const received: RecordedMcpToolCall[] = [];
    const sub = await live.subscribe("run-7", (call) => received.push(call));

    assert.equal(received.length, 1);
    const parsed = JSON.parse(received[0]!.resultJson) as {
      truncated: boolean;
      truncatedAtBytes: number;
      originalBytes: number;
      head: string;
    };
    assert.equal(parsed.truncated, true);
    assert.equal(parsed.truncatedAtBytes, MAX_LIVE_RESULT_JSON_BYTES);
    assert.equal(parsed.originalBytes, huge.length);
    assert.equal(parsed.head.length, MAX_LIVE_RESULT_JSON_BYTES);

    await sub.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
