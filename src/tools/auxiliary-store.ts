/**
 * DreamGraph — auxiliary entity store (Phase 5 #9).
 *
 * Persists auxiliary entities (tests, configs, scripts, MCP tools) to
 * data/auxiliary_entities.json with the same atomic-write + file-lock
 * discipline used by the rest of the cognitive engine. Backed by the
 * lazy-create policy in ADR-095: on ENOENT the loader returns an empty
 * canonical shape rather than throwing.
 */

import { withFileLock } from "../utils/mutex.js";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { dataPath } from "../utils/paths.js";
import { invalidateCache } from "../utils/cache.js";
import { logger } from "../utils/logger.js";
import type {
  AuxiliaryEntitiesFile,
  AuxiliaryEntity,
} from "../types/index.js";
import fs from "node:fs/promises";

const FILE_NAME = "auxiliary_entities.json";
const SCHEMA_VERSION = "1.0.0";

function emptyFile(): AuxiliaryEntitiesFile {
  return {
    metadata: {
      description:
        "Auxiliary project entities (tests, configuration, automation scripts, MCP tools) discovered by scan_project. Phase 5 #9.",
      schema_version: SCHEMA_VERSION,
      last_scanned: null,
      total: 0,
    },
    entries: [],
  };
}

export async function loadAuxiliaryEntities(): Promise<AuxiliaryEntitiesFile> {
  try {
    const text = await fs.readFile(dataPath(FILE_NAME), "utf-8");
    const parsed = JSON.parse(text) as Partial<AuxiliaryEntitiesFile>;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
      return emptyFile();
    }
    return {
      metadata: {
        description: parsed.metadata?.description ?? emptyFile().metadata.description,
        schema_version: parsed.metadata?.schema_version ?? SCHEMA_VERSION,
        last_scanned: parsed.metadata?.last_scanned ?? null,
        total: parsed.metadata?.total ?? parsed.entries.length,
      },
      entries: parsed.entries as AuxiliaryEntity[],
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // ADR-095: return empty canonical shape when the backing file
      // hasn't been created yet.
      return emptyFile();
    }
    logger.warn(`auxiliary-store: failed to load ${FILE_NAME}: ${err instanceof Error ? err.message : err}`);
    return emptyFile();
  }
}

/**
 * Merge `incoming` into the existing store by `id` and persist.
 * Existing fields are preserved unless the incoming entry overrides them.
 *
 * Returns counts so the caller can surface them in `scan_project` output.
 */
export async function mergeAuxiliaryEntities(
  incoming: AuxiliaryEntity[],
): Promise<{ inserted: number; updated: number; total: number }> {
  return withFileLock(FILE_NAME, async () => {
    const current = await loadAuxiliaryEntities();
    const byId = new Map<string, AuxiliaryEntity>();
    for (const e of current.entries) byId.set(e.id, e);

    let inserted = 0;
    let updated = 0;
    for (const incomingEntry of incoming) {
      if (!incomingEntry.id) continue;
      const existing = byId.get(incomingEntry.id);
      if (existing) {
        byId.set(incomingEntry.id, { ...existing, ...incomingEntry });
        updated++;
      } else {
        byId.set(incomingEntry.id, incomingEntry);
        inserted++;
      }
    }

    const merged: AuxiliaryEntitiesFile = {
      metadata: {
        ...current.metadata,
        last_scanned: new Date().toISOString(),
        total: byId.size,
      },
      entries: Array.from(byId.values()),
    };

    await atomicWriteFile(dataPath(FILE_NAME), JSON.stringify(merged, null, 2));
    invalidateCache(FILE_NAME);
    return { inserted, updated, total: byId.size };
  });
}
