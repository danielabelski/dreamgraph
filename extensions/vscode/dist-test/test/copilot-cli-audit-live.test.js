"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — tests for the live tail of the per-run MCP
// audit NDJSON (`createHostAuditLive`).
//
// Real `node:fs` operations against per-test tmp dirs. The bridge
// process is not involved here — we simulate its `appendFileSync`
// behaviour by writing NDJSON lines directly. Bridge↔audit integration
// is covered separately in `copilot-cli-bridge-audit.test.ts`.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const index_js_1 = require("../architect-core/adapters/copilot-cli/host/index.js");
function makeLine(overrides = {}) {
    const rec = {
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
async function waitUntil(predicate, timeoutMs = 2000, stepMs = 25) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error(`waitUntil: predicate did not become true within ${timeoutMs}ms`);
        }
        await new Promise((r) => setTimeout(r, stepMs));
    }
}
(0, node_test_1.default)("createHostAuditLive: rejects empty auditDirAbsPath", () => {
    // @ts-expect-error testing invalid input
    strict_1.default.throws(() => (0, index_js_1.createHostAuditLive)({}));
    strict_1.default.throws(() => (0, index_js_1.createHostAuditLive)({ auditDirAbsPath: "" }));
});
(0, node_test_1.default)("subscribe with no existing file → catch-up empty, future records delivered", async () => {
    const dir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "dg-audit-live-future-"));
    try {
        const live = (0, index_js_1.createHostAuditLive)({ auditDirAbsPath: dir, heartbeatMs: 50 });
        const received = [];
        const sub = await live.subscribe("run-1", (call) => received.push(call));
        strict_1.default.equal(received.length, 0, "no catch-up records expected");
        const path = (0, index_js_1.auditFilePathFor)(dir, "run-1");
        await (0, promises_1.writeFile)(path, makeLine({ tool: "alpha" }));
        await (0, promises_1.appendFile)(path, makeLine({ tool: "beta" }));
        await waitUntil(() => received.length >= 2);
        strict_1.default.equal(received.length, 2);
        strict_1.default.equal(received[0].tool, "alpha");
        strict_1.default.equal(received[1].tool, "beta");
        await sub.close();
    }
    finally {
        await (0, promises_1.rm)(dir, { recursive: true, force: true });
    }
});
(0, node_test_1.default)("subscribe after records exist → catch-up replays them", async () => {
    const dir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "dg-audit-live-catchup-"));
    try {
        const path = (0, index_js_1.auditFilePathFor)(dir, "run-2");
        await (0, promises_1.writeFile)(path, makeLine({ tool: "preexisting-a" }) + makeLine({ tool: "preexisting-b" }));
        const live = (0, index_js_1.createHostAuditLive)({ auditDirAbsPath: dir, heartbeatMs: 0 });
        const received = [];
        const sub = await live.subscribe("run-2", (call) => received.push(call));
        strict_1.default.equal(received.length, 2);
        strict_1.default.equal(received[0].tool, "preexisting-a");
        strict_1.default.equal(received[1].tool, "preexisting-b");
        await sub.close();
    }
    finally {
        await (0, promises_1.rm)(dir, { recursive: true, force: true });
    }
});
(0, node_test_1.default)("partial trailing line is buffered until newline arrives", async () => {
    const dir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "dg-audit-live-partial-"));
    try {
        const live = (0, index_js_1.createHostAuditLive)({ auditDirAbsPath: dir, heartbeatMs: 25 });
        const received = [];
        const sub = await live.subscribe("run-3", (call) => received.push(call));
        const path = (0, index_js_1.auditFilePathFor)(dir, "run-3");
        const first = makeLine({ tool: "full-line" });
        const partial = '{"server":"dreamgraph","tool":"split","inputJson":"{}","resultJson":"{}","isError":false,"durationMs":1,"startedAtEpochMs":1';
        await (0, promises_1.writeFile)(path, first + partial);
        await waitUntil(() => received.length >= 1);
        strict_1.default.equal(received.length, 1, "partial line must not be delivered");
        strict_1.default.equal(received[0].tool, "full-line");
        await (0, promises_1.appendFile)(path, '}\n');
        await waitUntil(() => received.length >= 2);
        strict_1.default.equal(received[1].tool, "split");
        await sub.close();
    }
    finally {
        await (0, promises_1.rm)(dir, { recursive: true, force: true });
    }
});
(0, node_test_1.default)("malformed line is skipped silently", async () => {
    const dir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "dg-audit-live-bad-"));
    try {
        const path = (0, index_js_1.auditFilePathFor)(dir, "run-4");
        await (0, promises_1.writeFile)(path, makeLine({ tool: "ok-1" }) + "not-json\n" + makeLine({ tool: "ok-2" }));
        const live = (0, index_js_1.createHostAuditLive)({ auditDirAbsPath: dir, heartbeatMs: 0 });
        const received = [];
        const sub = await live.subscribe("run-4", (call) => received.push(call));
        strict_1.default.equal(received.length, 2);
        strict_1.default.equal(received[0].tool, "ok-1");
        strict_1.default.equal(received[1].tool, "ok-2");
        await sub.close();
    }
    finally {
        await (0, promises_1.rm)(dir, { recursive: true, force: true });
    }
});
(0, node_test_1.default)("close() stops further deliveries and is idempotent", async () => {
    const dir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "dg-audit-live-close-"));
    try {
        const live = (0, index_js_1.createHostAuditLive)({ auditDirAbsPath: dir, heartbeatMs: 25 });
        const received = [];
        const sub = await live.subscribe("run-5", (call) => received.push(call));
        const path = (0, index_js_1.auditFilePathFor)(dir, "run-5");
        await (0, promises_1.writeFile)(path, makeLine({ tool: "before" }));
        await waitUntil(() => received.length >= 1);
        await sub.close();
        await sub.close(); // idempotent
        await (0, promises_1.appendFile)(path, makeLine({ tool: "after" }));
        // Give the (now-disposed) heartbeat plenty of time to NOT fire.
        await new Promise((r) => setTimeout(r, 150));
        strict_1.default.equal(received.length, 1, "no events should arrive after close");
    }
    finally {
        await (0, promises_1.rm)(dir, { recursive: true, force: true });
    }
});
(0, node_test_1.default)("handler exception does not break subsequent deliveries", async () => {
    const dir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "dg-audit-live-throw-"));
    try {
        const path = (0, index_js_1.auditFilePathFor)(dir, "run-6");
        await (0, promises_1.writeFile)(path, makeLine({ tool: "throw-me" }) + makeLine({ tool: "deliver-me" }));
        const live = (0, index_js_1.createHostAuditLive)({ auditDirAbsPath: dir, heartbeatMs: 0 });
        const received = [];
        const sub = await live.subscribe("run-6", (call) => {
            if (call.tool === "throw-me")
                throw new Error("boom");
            received.push(call);
        });
        strict_1.default.equal(received.length, 1);
        strict_1.default.equal(received[0].tool, "deliver-me");
        await sub.close();
    }
    finally {
        await (0, promises_1.rm)(dir, { recursive: true, force: true });
    }
});
(0, node_test_1.default)("resultJson larger than 4 KB is truncated for the live channel", async () => {
    const dir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "dg-audit-live-trunc-"));
    try {
        const huge = "x".repeat(index_js_1.MAX_LIVE_RESULT_JSON_BYTES * 2);
        const path = (0, index_js_1.auditFilePathFor)(dir, "run-7");
        await (0, promises_1.writeFile)(path, makeLine({ tool: "big", resultJson: huge }));
        const live = (0, index_js_1.createHostAuditLive)({ auditDirAbsPath: dir, heartbeatMs: 0 });
        const received = [];
        const sub = await live.subscribe("run-7", (call) => received.push(call));
        strict_1.default.equal(received.length, 1);
        const parsed = JSON.parse(received[0].resultJson);
        strict_1.default.equal(parsed.truncated, true);
        strict_1.default.equal(parsed.truncatedAtBytes, index_js_1.MAX_LIVE_RESULT_JSON_BYTES);
        strict_1.default.equal(parsed.originalBytes, huge.length);
        strict_1.default.equal(parsed.head.length, index_js_1.MAX_LIVE_RESULT_JSON_BYTES);
        await sub.close();
    }
    finally {
        await (0, promises_1.rm)(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=copilot-cli-audit-live.test.js.map