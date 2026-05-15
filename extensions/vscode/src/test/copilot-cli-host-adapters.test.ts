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

import test from "node:test";
import assert from "node:assert/strict";
import { access, constants as FS, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  HOST_CLOCK,
  HOST_CRYPTO,
  HOST_FS,
  HOST_PROCESS,
} from "../architect-core/adapters/copilot-cli/host/index.js";

const IS_WINDOWS = process.platform === "win32";

// ---------------------------------------------------------------------------
// HOST_CLOCK
// ---------------------------------------------------------------------------

test("HOST_CLOCK.nowMs returns a wall-clock millisecond reading", () => {
  const before = Date.now();
  const t = HOST_CLOCK.nowMs();
  const after = Date.now();
  assert.equal(typeof t, "number");
  assert.ok(Number.isFinite(t));
  assert.ok(t >= before && t <= after, `${t} not within [${before}, ${after}]`);
});

test("HOST_CLOCK.nowMs is monotonic-ish across two reads", async () => {
  const a = HOST_CLOCK.nowMs();
  await new Promise((r) => setTimeout(r, 5));
  const b = HOST_CLOCK.nowMs();
  assert.ok(b >= a, `${b} should be >= ${a}`);
});

// ---------------------------------------------------------------------------
// HOST_CRYPTO
// ---------------------------------------------------------------------------

test("HOST_CRYPTO.randomToken is URL-safe and unique", () => {
  const a = HOST_CRYPTO.randomToken(32);
  const b = HOST_CRYPTO.randomToken(32);
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.match(b, /^[A-Za-z0-9_-]+$/);
  // base64(32 bytes) without padding is 43 chars.
  assert.equal(a.length, 43);
});

test("HOST_CRYPTO.randomToken rejects invalid byte lengths", () => {
  assert.throws(() => HOST_CRYPTO.randomToken(0), /positive integer/);
  assert.throws(() => HOST_CRYPTO.randomToken(-1), /positive integer/);
  assert.throws(() => HOST_CRYPTO.randomToken(1.5), /positive integer/);
});

test("HOST_CRYPTO.randomRunId is path-safe and unique", () => {
  const a = HOST_CRYPTO.randomRunId();
  const b = HOST_CRYPTO.randomRunId();
  assert.notEqual(a, b);
  assert.ok(a.startsWith("copilot-cli-"));
  assert.match(a, /^copilot-cli-[0-9a-f-]+$/);
});

// ---------------------------------------------------------------------------
// HOST_FS
// ---------------------------------------------------------------------------

test("HOST_FS round-trip: mkdtemp → mkdir → writeFile → rmRecursive", async () => {
  const root = await HOST_FS.mkdtemp("dreamgraph-cli-test-");
  try {
    assert.ok(root.length > 0);
    await access(root, FS.F_OK); // exists
    const sub = HOST_FS.joinPath(root, "logs", "audit");
    await HOST_FS.mkdir(sub, { recursive: true });
    await access(sub, FS.F_OK);
    const file = HOST_FS.joinPath(sub, "calls.json");
    await HOST_FS.writeFile(file, "{\"hello\":\"world\"}\n", { mode: 0o600 });
    const contents = await readFile(file, "utf8");
    assert.equal(contents, "{\"hello\":\"world\"}\n");
    if (!IS_WINDOWS) {
      const st = await stat(file);
      // Mask off everything except permission bits.
      assert.equal(st.mode & 0o777, 0o600);
    }
  } finally {
    await HOST_FS.rmRecursive(root);
  }
  // After rm: the directory is gone.
  await assert.rejects(access(root, FS.F_OK));
});

test("HOST_FS.rmRecursive is idempotent (force:true)", async () => {
  const root = await HOST_FS.mkdtemp("dreamgraph-cli-rm-");
  await HOST_FS.rmRecursive(root);
  await HOST_FS.rmRecursive(root); // second call must not throw
});

test("HOST_FS.joinPath delegates to node:path", () => {
  const joined = HOST_FS.joinPath("a", "b", "c");
  assert.ok(joined.includes("a"));
  assert.ok(joined.endsWith("c"));
});

// ---------------------------------------------------------------------------
// HOST_PROCESS
// ---------------------------------------------------------------------------
//
// We use `process.execPath` (the absolute path to the Node binary
// running these tests) as the spawn target. Node has `--help` and
// `--version` flags so it doubles as a stand-in for the Copilot CLI
// shape.

test("HOST_PROCESS.resolveExecutable: absolute path round-trips", async () => {
  const result = await HOST_PROCESS.resolveExecutable(process.execPath);
  assert.notEqual(result, null);
  assert.equal(result!.executablePath, process.execPath);
  // Node's --version banner is `vXX.YY.ZZ`.
  if (result!.versionString !== null) {
    assert.match(result!.versionString, /^v\d+\.\d+\.\d+/);
  }
});

test("HOST_PROCESS.resolveExecutable: missing binary returns null", async () => {
  const result = await HOST_PROCESS.resolveExecutable(
    "definitely-not-a-real-binary-xyzzy-7f3a",
  );
  assert.equal(result, null);
});

test("HOST_PROCESS.resolveExecutable: rejects empty name", async () => {
  await assert.rejects(() => HOST_PROCESS.resolveExecutable(""));
});

test("HOST_PROCESS.runHelp captures Node --help output", async () => {
  const help = await HOST_PROCESS.runHelp({
    command: process.execPath,
    cwd: process.cwd(),
    env: filteredEnv(),
  });
  assert.ok(help.helpText.length > 0);
  // Node's --help mentions "Usage" — a stable token.
  assert.match(help.helpText, /Usage/i);
});

test("HOST_PROCESS.spawn captures stdout, exitCode 0, durationMs >= 0", async () => {
  const result = await HOST_PROCESS.spawn({
    command: process.execPath,
    args: ["-e", "process.stdout.write('hello-stdout');process.stderr.write('hello-stderr')"],
    cwd: process.cwd(),
    env: filteredEnv(),
    timeoutMs: 10_000,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "hello-stdout");
  assert.equal(result.stderr, "hello-stderr");
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
  assert.ok(result.durationMs >= 0);
});

test("HOST_PROCESS.spawn surfaces nonzero exit codes verbatim", async () => {
  const result = await HOST_PROCESS.spawn({
    command: process.execPath,
    args: ["-e", "process.exit(7)"],
    cwd: process.cwd(),
    env: filteredEnv(),
    timeoutMs: 10_000,
  });
  assert.equal(result.exitCode, 7);
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
});

test("HOST_PROCESS.spawn streams chunks live via onStdoutChunk", async () => {
  const chunks: string[] = [];
  const result = await HOST_PROCESS.spawn({
    command: process.execPath,
    args: ["-e", "process.stdout.write('a');process.stdout.write('b');process.stdout.write('c')"],
    cwd: process.cwd(),
    env: filteredEnv(),
    timeoutMs: 10_000,
    onStdoutChunk: (c) => chunks.push(c),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(chunks.join(""), "abc");
});

test("HOST_PROCESS.spawn enforces timeoutMs and reports timedOut=true", async () => {
  const result = await HOST_PROCESS.spawn({
    command: process.execPath,
    // Sleep 30s so the timeout always fires first.
    args: ["-e", "setTimeout(()=>{}, 30000)"],
    cwd: process.cwd(),
    env: filteredEnv(),
    timeoutMs: 200,
  });
  assert.equal(result.timedOut, true);
  // Killed by signal, so exitCode is null and signal is set (POSIX).
  // On Windows, the kill comes through differently; accept either.
  assert.ok(result.exitCode !== 0 || result.signal !== null);
  assert.ok(result.durationMs >= 200);
  // Hard cap: must not block much past timeout + grace.
  assert.ok(result.durationMs < 30_000);
});

test("HOST_PROCESS.spawn honors abortSignal and reports aborted=true", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100).unref?.();
  const result = await HOST_PROCESS.spawn({
    command: process.execPath,
    args: ["-e", "setTimeout(()=>{}, 30000)"],
    cwd: process.cwd(),
    env: filteredEnv(),
    timeoutMs: 30_000,
    abortSignal: ac.signal,
  });
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
  assert.ok(result.durationMs < 30_000);
});

test("HOST_PROCESS.spawn rejects non-positive timeoutMs", async () => {
  await assert.rejects(
    () =>
      HOST_PROCESS.spawn({
        command: process.execPath,
        args: ["-e", "0"],
        cwd: process.cwd(),
        env: filteredEnv(),
        timeoutMs: 0,
      }),
    /positive finite/,
  );
});

test("HOST_PROCESS.spawn surfaces ENOENT as a thrown error", async () => {
  await assert.rejects(
    () =>
      HOST_PROCESS.spawn({
        command: join(process.cwd(), "definitely-not-a-real-binary-xyzzy-7f3a.exe"),
        args: [],
        cwd: process.cwd(),
        env: filteredEnv(),
        timeoutMs: 5_000,
      }),
  );
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function filteredEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
