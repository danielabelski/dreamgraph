/**
 * DreamGraph Explorer — recent-traffic heatmap.
 *
 * Plan: plans/EXPLORER_3D_MODE.md §12.E (Slice E1).
 *
 * Aggregates recent entries from `data/event_log.json` into a per-entity
 * "heat" count for the last `windowSeconds` (default 1 hour). The 3D
 * Explorer recolors edge tubes by the max heat of their two endpoints so
 * the operator can see where the cognitive engine has been working
 * recently without leaving the graph.
 *
 * Read-only. Loopback-only. Defaults silently when the file is missing
 * or malformed — heatmap is a view enhancement, never a hard dependency.
 */

import { readFile } from "node:fs/promises";
import { dataPath } from "../utils/paths.js";
import { isMissingFileError } from "../utils/json-store.js";
import { logger } from "../utils/logger.js";
import type { EventLogEntry, EventLogFile } from "../cognitive/types.js";

/** Maximum window the SPA may request (24 hours). Beyond that, clamp. */
export const MAX_HEATMAP_WINDOW_SECONDS = 24 * 60 * 60;
/** Default window when the SPA does not specify one (1 hour). */
export const DEFAULT_HEATMAP_WINDOW_SECONDS = 60 * 60;

export interface HeatmapResult {
  /** Window actually used (after clamping), in seconds. */
  window_seconds: number;
  /** ISO timestamp the snapshot was generated at. */
  generated_at: string;
  /** Total events that fell inside the window. */
  total_events: number;
  /** Highest per-entity count — useful for client-side normalization. */
  max_count: number;
  /**
   * Per-entity hit counts. Sorted by count desc, then id asc, so the
   * Explorer can take a stable top-N slice.
   */
  nodes: Array<[id: string, count: number]>;
}

function emptyResult(windowSeconds: number): HeatmapResult {
  return {
    window_seconds: windowSeconds,
    generated_at: new Date().toISOString(),
    total_events: 0,
    max_count: 0,
    nodes: [],
  };
}

async function loadRawLog(): Promise<EventLogFile | null> {
  try {
    const raw = await readFile(dataPath("event_log.json"), "utf-8");
    const parsed = JSON.parse(raw) as EventLogFile;
    if (!parsed || !Array.isArray(parsed.events)) return null;
    return parsed;
  } catch (err) {
    if (isMissingFileError(err)) return null;
    logger.warn(
      `event_log.json malformed (${(err as Error).message}); heatmap returns empty`,
    );
    return null;
  }
}

/**
 * Coerce a user-supplied window string into a valid integer second count.
 * Garbage falls back to the default; values outside the allowed range are
 * clamped, never rejected — heatmap must always render something.
 */
export function coerceWindowSeconds(raw: string | null | undefined): number {
  if (raw == null || raw === "") return DEFAULT_HEATMAP_WINDOW_SECONDS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_HEATMAP_WINDOW_SECONDS;
  return Math.min(n, MAX_HEATMAP_WINDOW_SECONDS);
}

/**
 * Aggregate event-log entries into per-entity heat. Pure function over
 * its inputs; takes `now` so tests can pin the cutoff.
 */
export function aggregateHeatmap(
  events: EventLogEntry[],
  windowSeconds: number,
  now: Date = new Date(),
): HeatmapResult {
  const cutoffMs = now.getTime() - windowSeconds * 1000;
  const counts = new Map<string, number>();
  let total = 0;

  for (const entry of events) {
    if (!entry || typeof entry !== "object") continue;
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isFinite(ts) || ts < cutoffMs) continue;
    const ids = entry.event?.affected_entities;
    if (!Array.isArray(ids)) continue;
    total += 1;
    // Dedupe within a single event so one large multi-entity event does
    // not over-saturate any single node relative to many small events.
    const seen = new Set<string>();
    for (const id of ids) {
      if (typeof id !== "string" || id.length === 0) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }

  const nodes: Array<[string, number]> = Array.from(counts.entries()).sort(
    (a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]),
  );
  const max_count = nodes.length > 0 ? nodes[0][1] : 0;

  return {
    window_seconds: windowSeconds,
    generated_at: now.toISOString(),
    total_events: total,
    max_count,
    nodes,
  };
}

/**
 * Load the on-disk event log and aggregate. Returns an empty result
 * (never throws) when the file is missing or malformed.
 */
export async function getHeatmap(windowSeconds: number): Promise<HeatmapResult> {
  const log = await loadRawLog();
  if (!log) return emptyResult(windowSeconds);
  return aggregateHeatmap(log.events, windowSeconds);
}
