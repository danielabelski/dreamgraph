/**
 * LLM bootstrap fingerprint registry (ADR-098, Slice 2B).
 *
 * Persistent record of which `(provider, base_url, dreamer_model,
 * normalizer_model)` fingerprints have already triggered the auto-bootstrap
 * chain for this instance. Backs the ADR-098 guard rail:
 *
 *   "Bootstrap must run exactly once per (provider, model, endpoint)
 *    configuration."
 *
 * Storage: `<data>/llm_bootstrap_log.json`. Append-only — entries record the
 * fingerprint, when it was first observed ready, what kind of bootstrap was
 * fired (full | re-enrich | skipped), and a brief outcome string. Designed
 * to be cheap to read on every readiness transition and forensic-friendly
 * after the fact.
 *
 * The file is intentionally NOT in templates/default — it's per-instance
 * runtime state, not seed data.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dataPath } from "../utils/paths.js";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { withFileLock } from "../utils/mutex.js";
import { logger } from "../utils/logger.js";

export type BootstrapKind = "full" | "re_enrich_skipped" | "manual" | "skipped_not_fresh";

export interface BootstrapHistoryEntry {
  fingerprint: string;
  /** The effective config snapshot at the time of bootstrap (forensic only). */
  effective: {
    provider: string;
    base_url: string;
    dreamer_model: string;
    normalizer_model: string;
  };
  kind: BootstrapKind;
  /** When the daemon first saw this fingerprint go ready. */
  observed_at: string;
  /** Human-readable outcome — error message on failure, summary on success. */
  outcome: string;
  success: boolean;
}

interface BootstrapHistoryFile {
  entries: BootstrapHistoryEntry[];
}

const FILENAME = "llm_bootstrap_log.json";

async function loadHistory(): Promise<BootstrapHistoryFile> {
  const file = dataPath(FILENAME);
  if (!existsSync(file)) return { entries: [] };
  try {
    const raw = await readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as Partial<BootstrapHistoryFile>;
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch (err) {
    logger.warn(
      `bootstrap-registry: unreadable ${FILENAME} — treating as empty (${
        err instanceof Error ? err.message : err
      })`,
    );
    return { entries: [] };
  }
}

async function saveHistory(history: BootstrapHistoryFile): Promise<void> {
  await atomicWriteFile(dataPath(FILENAME), JSON.stringify(history, null, 2));
}

/** True if this fingerprint has already been observed ready and recorded. */
export async function hasFingerprintBeenSeen(fingerprint: string): Promise<boolean> {
  const history = await loadHistory();
  return history.entries.some((e) => e.fingerprint === fingerprint);
}

/** Append a new history entry under the file lock. */
export async function recordBootstrap(entry: BootstrapHistoryEntry): Promise<void> {
  await withFileLock(FILENAME, async () => {
    const history = await loadHistory();
    // Defensive: dedupe — a second concurrent ready transition for the same
    // fingerprint should produce at most one entry.
    if (history.entries.some((e) => e.fingerprint === entry.fingerprint && e.kind === entry.kind)) {
      return;
    }
    history.entries.push(entry);
    await saveHistory(history);
  });
}

/** Read-only history accessor for `cognitive_status` etc. */
export async function getBootstrapHistory(): Promise<BootstrapHistoryEntry[]> {
  const history = await loadHistory();
  return history.entries;
}
