"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — Slice 3 host adapter tests.
//
// Exercises the four real port adapters (`HOST_FS`, `HOST_PROCESS`,
// `HOST_CRYPTO`, `HOST_CLOCK`) against the actual `node:fs`,
// `node:child_process`, `node:crypto`, and wall clock. No mocks.
//
// `HOST_PROCESS` is exercised against `process.execPath` (the running
// Node binary) so the tests are portable across Windows/macOS/Linux
// CI without depending on an installed `copilot` binary.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const index_js_1 = require("../architect-core/adapters/copilot-cli/host/index.js");
const IS_WINDOWS = process.platform === "win32";
// ---------------------------------------------------------------------------
// HOST_CLOCK
// ---------------------------------------------------------------------------
(0, node_test_1.default)("HOST_CLOCK.nowMs returns a wall-clock millisecond reading", () => {
    const before = Date.now();
    const t = index_js_1.HOST_CLOCK.nowMs();
    const after = Date.now();
    strict_1.default.equal(typeof t, "number");
    strict_1.default.ok(Number.isFinite(t));
    strict_1.default.ok(t >= before && t <= after, `${t} not within [${before}, ${after}]`);
});
(0, node_test_1.default)("HOST_CLOCK.nowMs is monotonic-ish across two reads", async () => {
    const a = index_js_1.HOST_CLOCK.nowMs();
    await new Promise((r) => setTimeout(r, 5));
    const b = index_js_1.HOST_CLOCK.nowMs();
    strict_1.default.ok(b >= a, `${b} should be >= ${a}`);
});
// ---------------------------------------------------------------------------
// HOST_CRYPTO
// ---------------------------------------------------------------------------
(0, node_test_1.default)("HOST_CRYPTO.randomToken is URL-safe and unique", () => {
    const a = index_js_1.HOST_CRYPTO.randomToken(32);
    const b = index_js_1.HOST_CRYPTO.randomToken(32);
    strict_1.default.notEqual(a, b);
    strict_1.default.match(a, /^[A-Za-z0-9_-]+$/);
    strict_1.default.match(b, /^[A-Za-z0-9_-]+$/);
    // base64(32 bytes) without padding is 43 chars.
    strict_1.default.equal(a.length, 43);
});
(0, node_test_1.default)("HOST_CRYPTO.randomToken rejects invalid byte lengths", () => {
    strict_1.default.throws(() => index_js_1.HOST_CRYPTO.randomToken(0), /positive integer/);
    strict_1.default.throws(() => index_js_1.HOST_CRYPTO.randomToken(-1), /positive integer/);
    strict_1.default.throws(() => index_js_1.HOST_CRYPTO.randomToken(1.5), /positive integer/);
});
(0, node_test_1.default)("HOST_CRYPTO.randomRunId is path-safe and unique", () => {
    const a = index_js_1.HOST_CRYPTO.randomRunId();
    const b = index_js_1.HOST_CRYPTO.randomRunId();
    strict_1.default.notEqual(a, b);
    strict_1.default.ok(a.startsWith("copilot-cli-"));
    strict_1.default.match(a, /^copilot-cli-[0-9a-f-]+$/);
});
// ---------------------------------------------------------------------------
// HOST_FS
// ---------------------------------------------------------------------------
(0, node_test_1.default)("HOST_FS round-trip: mkdtemp → mkdir → writeFile → rmRecursive", async () => {
    const root = await index_js_1.HOST_FS.mkdtemp("dreamgraph-cli-test-");
    try {
        strict_1.default.ok(root.length > 0);
        await (0, promises_1.access)(root, promises_1.constants.F_OK); // exists
        const sub = index_js_1.HOST_FS.joinPath(root, "logs", "audit");
        await index_js_1.HOST_FS.mkdir(sub, { recursive: true });
        await (0, promises_1.access)(sub, promises_1.constants.F_OK);
        const file = index_js_1.HOST_FS.joinPath(sub, "calls.json");
        await index_js_1.HOST_FS.writeFile(file, "{\"hello\":\"world\"}\n", { mode: 0o600 });
        const contents = await (0, promises_1.readFile)(file, "utf8");
        strict_1.default.equal(contents, "{\"hello\":\"world\"}\n");
        if (!IS_WINDOWS) {
            const st = await (0, promises_1.stat)(file);
            // Mask off everything except permission bits.
            strict_1.default.equal(st.mode & 0o777, 0o600);
        }
    }
    finally {
        await index_js_1.HOST_FS.rmRecursive(root);
    }
    // After rm: the directory is gone.
    await strict_1.default.rejects((0, promises_1.access)(root, promises_1.constants.F_OK));
});
(0, node_test_1.default)("HOST_FS.rmRecursive is idempotent (force:true)", async () => {
    const root = await index_js_1.HOST_FS.mkdtemp("dreamgraph-cli-rm-");
    await index_js_1.HOST_FS.rmRecursive(root);
    await index_js_1.HOST_FS.rmRecursive(root); // second call must not throw
});
(0, node_test_1.default)("HOST_FS.joinPath delegates to node:path", () => {
    const joined = index_js_1.HOST_FS.joinPath("a", "b", "c");
    strict_1.default.ok(joined.includes("a"));
    strict_1.default.ok(joined.endsWith("c"));
});
// ---------------------------------------------------------------------------
// HOST_PROCESS
// ---------------------------------------------------------------------------
//
// We use `process.execPath` (the absolute path to the Node binary
// running these tests) as the spawn target. Node has `--help` and
// `--version` flags so it doubles as a stand-in for the Copilot CLI
// shape.
(0, node_test_1.default)("HOST_PROCESS.resolveExecutable: absolute path round-trips", async () => {
    const result = await index_js_1.HOST_PROCESS.resolveExecutable(process.execPath);
    strict_1.default.notEqual(result, null);
    strict_1.default.equal(result.executablePath, process.execPath);
    // Node's --version banner is `vXX.YY.ZZ`.
    if (result.versionString !== null) {
        strict_1.default.match(result.versionString, /^v\d+\.\d+\.\d+/);
    }
});
(0, node_test_1.default)("HOST_PROCESS.resolveExecutable: missing binary returns null", async () => {
    const result = await index_js_1.HOST_PROCESS.resolveExecutable("definitely-not-a-real-binary-xyzzy-7f3a");
    strict_1.default.equal(result, null);
});
(0, node_test_1.default)("HOST_PROCESS.resolveExecutable: rejects empty name", async () => {
    await strict_1.default.rejects(() => index_js_1.HOST_PROCESS.resolveExecutable(""));
});
(0, node_test_1.default)("HOST_PROCESS.runHelp captures Node --help output", async () => {
    const help = await index_js_1.HOST_PROCESS.runHelp({
        command: process.execPath,
        cwd: process.cwd(),
        env: filteredEnv(),
    });
    strict_1.default.ok(help.helpText.length > 0);
    // Node's --help mentions "Usage" — a stable token.
    strict_1.default.match(help.helpText, /Usage/i);
});
(0, node_test_1.default)("HOST_PROCESS.spawn captures stdout, exitCode 0, durationMs >= 0", async () => {
    const result = await index_js_1.HOST_PROCESS.spawn({
        command: process.execPath,
        args: ["-e", "process.stdout.write('hello-stdout');process.stderr.write('hello-stderr')"],
        cwd: process.cwd(),
        env: filteredEnv(),
        timeoutMs: 10_000,
    });
    strict_1.default.equal(result.exitCode, 0);
    strict_1.default.equal(result.signal, null);
    strict_1.default.equal(result.stdout, "hello-stdout");
    strict_1.default.equal(result.stderr, "hello-stderr");
    strict_1.default.equal(result.timedOut, false);
    strict_1.default.equal(result.aborted, false);
    strict_1.default.ok(result.durationMs >= 0);
});
(0, node_test_1.default)("HOST_PROCESS.spawn surfaces nonzero exit codes verbatim", async () => {
    const result = await index_js_1.HOST_PROCESS.spawn({
        command: process.execPath,
        args: ["-e", "process.exit(7)"],
        cwd: process.cwd(),
        env: filteredEnv(),
        timeoutMs: 10_000,
    });
    strict_1.default.equal(result.exitCode, 7);
    strict_1.default.equal(result.timedOut, false);
    strict_1.default.equal(result.aborted, false);
});
(0, node_test_1.default)("HOST_PROCESS.spawn streams chunks live via onStdoutChunk", async () => {
    const chunks = [];
    const result = await index_js_1.HOST_PROCESS.spawn({
        command: process.execPath,
        args: ["-e", "process.stdout.write('a');process.stdout.write('b');process.stdout.write('c')"],
        cwd: process.cwd(),
        env: filteredEnv(),
        timeoutMs: 10_000,
        onStdoutChunk: (c) => chunks.push(c),
    });
    strict_1.default.equal(result.exitCode, 0);
    strict_1.default.equal(chunks.join(""), "abc");
});
(0, node_test_1.default)("HOST_PROCESS.spawn enforces timeoutMs and reports timedOut=true", async () => {
    const result = await index_js_1.HOST_PROCESS.spawn({
        command: process.execPath,
        // Sleep 30s so the timeout always fires first.
        args: ["-e", "setTimeout(()=>{}, 30000)"],
        cwd: process.cwd(),
        env: filteredEnv(),
        timeoutMs: 200,
    });
    strict_1.default.equal(result.timedOut, true);
    // Killed by signal, so exitCode is null and signal is set (POSIX).
    // On Windows, the kill comes through differently; accept either.
    strict_1.default.ok(result.exitCode !== 0 || result.signal !== null);
    strict_1.default.ok(result.durationMs >= 200);
    // Hard cap: must not block much past timeout + grace.
    strict_1.default.ok(result.durationMs < 30_000);
});
(0, node_test_1.default)("HOST_PROCESS.spawn honors abortSignal and reports aborted=true", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100).unref?.();
    const result = await index_js_1.HOST_PROCESS.spawn({
        command: process.execPath,
        args: ["-e", "setTimeout(()=>{}, 30000)"],
        cwd: process.cwd(),
        env: filteredEnv(),
        timeoutMs: 30_000,
        abortSignal: ac.signal,
    });
    strict_1.default.equal(result.aborted, true);
    strict_1.default.equal(result.timedOut, false);
    strict_1.default.ok(result.durationMs < 30_000);
});
(0, node_test_1.default)("HOST_PROCESS.spawn rejects non-positive timeoutMs", async () => {
    await strict_1.default.rejects(() => index_js_1.HOST_PROCESS.spawn({
        command: process.execPath,
        args: ["-e", "0"],
        cwd: process.cwd(),
        env: filteredEnv(),
        timeoutMs: 0,
    }), /positive finite/);
});
(0, node_test_1.default)("HOST_PROCESS.spawn surfaces ENOENT as a thrown error", async () => {
    await strict_1.default.rejects(() => index_js_1.HOST_PROCESS.spawn({
        command: (0, node_path_1.join)(process.cwd(), "definitely-not-a-real-binary-xyzzy-7f3a.exe"),
        args: [],
        cwd: process.cwd(),
        env: filteredEnv(),
        timeoutMs: 5_000,
    }));
});
// ---------------------------------------------------------------------------
// Cancellation escalation (SIGINT → SIGTERM → SIGKILL + Windows tree kill)
// ---------------------------------------------------------------------------
(0, node_test_1.default)("HOST_PROCESS.spawn: aborting twice is idempotent and still settles", async () => {
    const ac = new AbortController();
    // Abort immediately, then again 50ms later. The escalation timers
    // must not double-fire and the spawn must still resolve.
    ac.abort();
    setTimeout(() => ac.abort(), 50).unref?.();
    const result = await index_js_1.HOST_PROCESS.spawn({
        command: process.execPath,
        args: ["-e", "setTimeout(()=>{}, 30000)"],
        cwd: process.cwd(),
        env: filteredEnv(),
        timeoutMs: 30_000,
        abortSignal: ac.signal,
    });
    strict_1.default.equal(result.aborted, true);
    strict_1.default.ok(result.durationMs < 10_000, `expected fast settle, got ${result.durationMs}ms`);
});
(0, node_test_1.default)("HOST_PROCESS.spawn: aborted child stops emitting stdout chunks before resolve", async () => {
    // Child writes 'a' immediately, then would write 'b' after 5s. We
    // abort before 'b' is sent. The collected chunks must contain 'a'
    // and must not contain 'b'.
    const ac = new AbortController();
    const chunks = [];
    setTimeout(() => ac.abort(), 100).unref?.();
    const result = await index_js_1.HOST_PROCESS.spawn({
        command: process.execPath,
        args: [
            "-e",
            "process.stdout.write('a');setTimeout(()=>{process.stdout.write('b')},5000);setTimeout(()=>{},30000)",
        ],
        cwd: process.cwd(),
        env: filteredEnv(),
        timeoutMs: 30_000,
        abortSignal: ac.signal,
        onStdoutChunk: (c) => chunks.push(c),
    });
    strict_1.default.equal(result.aborted, true);
    strict_1.default.ok(chunks.join("").includes("a"));
    strict_1.default.ok(!chunks.join("").includes("b"), `late chunk leaked: ${chunks.join("")}`);
});
(0, node_test_1.default)("HOST_PROCESS.spawn: cooperative SIGINT child exits cleanly inside the escalation window", async () => {
    // POSIX-only: child installs a SIGINT handler that writes a marker
    // and exits 0. On Windows there is no SIGINT for spawned children,
    // so this test is skipped — the SIGTERM/taskkill path is exercised
    // by the abort tests above.
    if (IS_WINDOWS)
        return;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50).unref?.();
    const result = await index_js_1.HOST_PROCESS.spawn({
        command: process.execPath,
        args: [
            "-e",
            "process.on('SIGINT',()=>{process.stdout.write('caught-sigint');process.exit(0)});setTimeout(()=>{},30000)",
        ],
        cwd: process.cwd(),
        env: filteredEnv(),
        timeoutMs: 30_000,
        abortSignal: ac.signal,
    });
    strict_1.default.equal(result.aborted, true);
    // Child must have caught SIGINT — proves we send the polite signal
    // first, before escalating to SIGTERM/SIGKILL.
    strict_1.default.ok(result.stdout.includes("caught-sigint"), `expected SIGINT handler to fire, got stdout=${JSON.stringify(result.stdout)}`);
    // Clean exit through SIGINT handler → exitCode 0, no signal.
    strict_1.default.equal(result.exitCode, 0);
    strict_1.default.equal(result.signal, null);
});
// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function filteredEnv() {
    const out = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === "string")
            out[k] = v;
    }
    return out;
}
//# sourceMappingURL=copilot-cli-host-adapters.test.js.map