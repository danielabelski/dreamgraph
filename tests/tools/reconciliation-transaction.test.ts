import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { setDataDirOverride } from "../../src/utils/paths.js";
import { invalidateCache, loadJsonData, setDataDirResolver } from "../../src/utils/cache.js";
import { atomicWriteFile } from "../../src/utils/atomic-write.js";
import { withGraphRead } from "../../src/utils/graph-reconciliation-barrier.js";
import {
  recoverReconciliationTransaction,
  withReconciliationTransaction,
} from "../../src/tools/reconciliation-transaction.js";

const root = mkdtempSync(join(tmpdir(), "dg-reconciliation-"));
setDataDirOverride(root);
setDataDirResolver(() => root);

const files = ["features.json", "workflows.json", "scan_state.json"] as const;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function seed(revision = "old"): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const file of files) {
    await writeFile(join(root, file), JSON.stringify({ revision, file }), "utf-8");
  }
  invalidateCache();
}

async function revision(file: string): Promise<string> {
  return (JSON.parse(await readFile(join(root, file), "utf-8")) as { revision: string }).revision;
}

function transaction(options: {
  expected?: string | null;
  next?: string;
  before_commit?: () => Promise<void>;
  fault_inject?: (step: string) => Promise<void> | void;
} = {}) {
  const next = options.next ?? "new";
  return withReconciliationTransaction({
    expected_revision: options.expected === undefined ? "old" : options.expected,
    next_revision: next,
    read_current_revision: async () => revision("scan_state.json"),
    before_commit: options.before_commit,
    fault_inject: options.fault_inject,
    writes: files.map((file) => ({ file, content: JSON.stringify({ revision: next, file }) })),
  });
}

async function readSet(): Promise<string[]> {
  return withGraphRead(async () => Promise.all(files.map(async (file) =>
    (await loadJsonData<{ revision: string }>(file)).revision
  )));
}

beforeEach(async () => {
  await seed();
  try { await writeFile(join(root, "reconciliation_journal.json"), "", "utf-8"); } catch { /* noop */ }
  await import("node:fs/promises").then(({ unlink }) => unlink(join(root, "reconciliation_journal.json")).catch(() => undefined));
});

afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

describe("instance graph reconciliation barrier", () => {
  it("lets a reader that began first complete against the old revision", async () => {
    const readerEntered = deferred();
    const releaseReader = deferred();
    const reader = withGraphRead(async () => {
      readerEntered.resolve();
      const first = await loadJsonData<{ revision: string }>("features.json");
      await releaseReader.promise;
      const second = await loadJsonData<{ revision: string }>("workflows.json");
      return [first.revision, second.revision];
    });
    await readerEntered.promise;
    const commit = transaction();
    await Promise.resolve();
    expect(await revision("features.json")).toBe("old");
    releaseReader.resolve();
    expect(await reader).toEqual(["old", "old"]);
    await commit;
  });

  it("blocks a reader during commit and exposes the complete new revision after publication", async () => {
    const commitEntered = deferred();
    const releaseCommit = deferred();
    const commit = transaction({
      before_commit: async () => {
        commitEntered.resolve();
        await releaseCommit.promise;
      },
    });
    await commitEntered.promise;
    let completed = false;
    const reader = readSet().then((value) => { completed = true; return value; });
    await Promise.resolve();
    expect(completed).toBe(false);
    releaseCommit.resolve();
    await commit;
    expect(await reader).toEqual(["new", "new", "new"]);
  });

  it("rolls back every injected commit interruption without exposing a mixed read", async () => {
    const steps = [
      "journal_prepared",
      "before_replace:0:features.json",
      "after_replace:0:features.json",
      "before_replace:1:workflows.json",
      "after_replace:1:workflows.json",
      "before_replace:2:scan_state.json",
      "after_replace:2:scan_state.json",
      "before_journal_remove",
    ];
    for (const target of steps) {
      await seed();
      await expect(transaction({
        fault_inject: (step) => {
          if (step === target) throw new Error(`fault:${target}`);
        },
      })).rejects.toThrow(`fault:${target}`);
      expect(await readSet()).toEqual(["old", "old", "old"]);
    }
  });

  it("preserves a recovery-required journal when rollback itself fails", async () => {
    await expect(transaction({
      fault_inject: (step) => {
        if (step === "after_replace:0:features.json") throw new Error("commit failed");
        if (step === "recovery_before_restore:0:features.json") throw new Error("rollback failed");
      },
    })).rejects.toThrow("RECONCILIATION_RECOVERY_REQUIRED");
    const journal = JSON.parse(await readFile(join(root, "reconciliation_journal.json"), "utf-8")) as { status: string };
    expect(journal.status).toBe("recovery_required");
  });

  it("recovers an interrupted daemon transaction journal to the previous complete set", async () => {
    const journal = {
      schema: "dreamgraph.reconciliation_journal.v1",
      transaction_id: "interrupted",
      expected_revision: "old",
      next_revision: "new",
      status: "committing",
      writes: files.map((file) => ({
        file,
        next: JSON.stringify({ revision: "new", file }),
        previous: JSON.stringify({ revision: "old", file }),
      })),
    };
    await writeFile(join(root, "features.json"), JSON.stringify({ revision: "new", file: "features.json" }));
    await writeFile(join(root, "reconciliation_journal.json"), JSON.stringify(journal));
    invalidateCache();
    expect(await recoverReconciliationTransaction()).toBe("rolled_back");
    expect(await readSet()).toEqual(["old", "old", "old"]);
  });

  it("serializes concurrent full/incremental commits and rejects the stale revision writer", async () => {
    const entered = deferred();
    const release = deferred();
    const first = transaction({ before_commit: async () => { entered.resolve(); await release.promise; } });
    await entered.promise;
    const stale = transaction();
    release.resolve();
    await first;
    await expect(stale).rejects.toThrow("RECONCILIATION_REVISION_CONFLICT");
    expect(await readSet()).toEqual(["new", "new", "new"]);
  });

  it("blocks enrichment, dream, scheduler, and manual atomic mutations at the same boundary", async () => {
    const entered = deferred();
    const release = deferred();
    const commit = transaction({ before_commit: async () => { entered.resolve(); await release.promise; } });
    await entered.promise;
    let mutationCompleted = false;
    const mutation = atomicWriteFile(join(root, "dream_graph.json"), JSON.stringify({ revision: "manual" }))
      .then(() => { mutationCompleted = true; });
    await Promise.resolve();
    expect(mutationCompleted).toBe(false);
    release.resolve();
    await commit;
    await mutation;
    expect(JSON.parse(await readFile(join(root, "dream_graph.json"), "utf-8"))).toEqual({ revision: "manual" });
  });

  it("invalidates cached stores before post-commit readers enter", async () => {
    expect(await readSet()).toEqual(["old", "old", "old"]);
    await transaction();
    expect(await readSet()).toEqual(["new", "new", "new"]);
  });
});
