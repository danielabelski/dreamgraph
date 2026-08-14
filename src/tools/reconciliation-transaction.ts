import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { atomicWriteFile } from "../utils/atomic-write.js";
import { withFileLock } from "../utils/mutex.js";
import { dataPath } from "../utils/paths.js";
import { invalidateCache } from "../utils/cache.js";
import { withGraphReconciliation } from "../utils/graph-reconciliation-barrier.js";

const JOURNAL_FILE = "reconciliation_journal.json";
const LEASE_KEY = "reconciliation";

export interface ReconciliationWrite {
  file: string;
  content: string;
}

interface Journal {
  schema: "dreamgraph.reconciliation_journal.v1";
  transaction_id: string;
  expected_revision: string | null;
  next_revision: string;
  status: "prepared" | "committing" | "rolling_back" | "recovery_required";
  writes: Array<{ file: string; next: string; previous: string | null }>;
}

async function readOptional(file: string): Promise<string | null> {
  try { return await fs.readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function removeOptional(file: string): Promise<void> {
  try { await fs.unlink(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function recoverReconciliationTransactionUnlocked(
  faultInject?: (step: string) => Promise<void> | void,
): Promise<"clean" | "rolled_back"> {
  const journalPath = dataPath(JOURNAL_FILE);
  const raw = await readOptional(journalPath);
  if (!raw) return "clean";
  const journal = JSON.parse(raw) as Journal;
  await atomicWriteFile(journalPath, JSON.stringify({ ...journal, status: "rolling_back" }, null, 2));
  try {
    for (let index = 0; index < journal.writes.length; index++) {
      const write = journal.writes[index];
      await faultInject?.(`recovery_before_restore:${index}:${write.file}`);
      const destination = dataPath(write.file);
      if (write.previous === null) await removeOptional(destination);
      else await atomicWriteFile(destination, write.previous);
      invalidateCache(write.file);
      await faultInject?.(`recovery_after_restore:${index}:${write.file}`);
    }
  } catch (error) {
    await atomicWriteFile(journalPath, JSON.stringify({ ...journal, status: "recovery_required" }, null, 2));
    throw new Error(`RECONCILIATION_RECOVERY_REQUIRED: ${error instanceof Error ? error.message : String(error)}`);
  }
  await removeOptional(journalPath);
  return "rolled_back";
}

export async function recoverReconciliationTransaction(): Promise<"clean" | "rolled_back"> {
  return withGraphReconciliation(recoverReconciliationTransactionUnlocked);
}

export async function withReconciliationTransaction<T>(input: {
  expected_revision: string | null;
  next_revision: string;
  writes: ReconciliationWrite[];
  read_current_revision: () => Promise<string | null>;
  before_commit?: () => Promise<T>;
  /** Deterministic test seam; production callers omit it. */
  fault_inject?: (step: string) => Promise<void> | void;
}): Promise<{ transaction_id: string; result: T | undefined }> {
  return withFileLock(LEASE_KEY, async () => withGraphReconciliation(async () => {
    await recoverReconciliationTransactionUnlocked();
    const current = await input.read_current_revision();
    if (current !== input.expected_revision) {
      throw new Error(`RECONCILIATION_REVISION_CONFLICT: expected ${input.expected_revision ?? "none"}, found ${current ?? "none"}`);
    }
    const transaction_id = randomUUID();
    const writes = await Promise.all(input.writes.map(async (write) => ({
      file: write.file,
      next: write.content,
      previous: await readOptional(dataPath(write.file)),
    })));
    const journal: Journal = {
      schema: "dreamgraph.reconciliation_journal.v1",
      transaction_id,
      expected_revision: input.expected_revision,
      next_revision: input.next_revision,
      status: "prepared",
      writes,
    };
    const journalPath = dataPath(JOURNAL_FILE);
    await atomicWriteFile(journalPath, JSON.stringify(journal, null, 2));
    await input.fault_inject?.("journal_prepared");
    const result = await input.before_commit?.();
    await atomicWriteFile(journalPath, JSON.stringify({ ...journal, status: "committing" }, null, 2));
    try {
      // Publication marker is always last regardless of caller order.
      const orderedWrites = [
        ...writes.filter((write) => write.file !== "scan_state.json"),
        ...writes.filter((write) => write.file === "scan_state.json"),
      ];
      for (let index = 0; index < orderedWrites.length; index++) {
        const write = orderedWrites[index];
        await input.fault_inject?.(`before_replace:${index}:${write.file}`);
        const destination = dataPath(write.file);
        if (path.basename(destination) !== write.file) throw new Error(`Unsafe reconciliation file: ${write.file}`);
        await atomicWriteFile(destination, write.next);
        invalidateCache(write.file);
        await input.fault_inject?.(`after_replace:${index}:${write.file}`);
      }
      await input.fault_inject?.("before_journal_remove");
      await removeOptional(journalPath);
      return { transaction_id, result };
    } catch (error) {
      await recoverReconciliationTransactionUnlocked(input.fault_inject);
      throw error;
    }
  }));
}
