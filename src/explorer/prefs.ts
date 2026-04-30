/**
 * DreamGraph Explorer — UI preferences store.
 *
 * Owns `data/explorer_prefs.json`. Loopback-only, never touched by the
 * cognitive engine; this is purely UI state echoed back to the SPA so the
 * Explorer remembers per-instance choices like which renderer (2D/3D) to
 * boot into.
 *
 * Plan: plans/EXPLORER_3D_MODE.md §9.
 *
 * Robustness contract:
 *   - Missing or malformed file → return defaults, log a warning, do not throw.
 *   - PATCH semantics: the POST handler merges shallowly into the existing
 *     file so the SPA can update one field without re-sending the whole blob.
 *   - All writes go through `atomicWriteFile` to avoid zero-byte anomalies on
 *     crash, matching the rest of the daemon's data layer.
 */

import { readFile } from "node:fs/promises";
import { dataPath } from "../utils/paths.js";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { isMissingFileError } from "../utils/json-store.js";
import { logger } from "../utils/logger.js";

export type ExplorerRenderMode = "2d" | "3d";
export type ExplorerQuality = "auto" | "high" | "medium" | "low";
export type ExplorerLayoutMode3D = "force" | "radial";

export interface ExplorerCamera3D {
  /** [x, y, z] — what the camera is looking at. */
  target: [number, number, number];
  /** [x, y, z] — where the camera is. */
  position: [number, number, number];
}

export interface ExplorerPrefs {
  version: 1;
  renderMode: ExplorerRenderMode;
  camera3d: ExplorerCamera3D;
  quality3d: ExplorerQuality;
  showGrid3d: boolean;
  bloom3d: boolean;
  /**
   * Per-node saved camera poses for the 3D mode. Keyed by node id; each
   * entry stores the orbit-controls target plus the camera position so
   * the SPA can re-frame on Shift+R. Coercion drops malformed entries
   * silently — see `coercePrefs`.
   */
  cameraPresets3d: Record<string, ExplorerCamera3D>;
  /**
   * 3D layout strategy. "force" runs the d3-force-3d simulation;
   * "radial" places nodes on Fibonacci-sphere shells by BFS depth from
   * the highest-degree root.
   */
  layoutMode3d: ExplorerLayoutMode3D;
}

export const DEFAULT_PREFS: ExplorerPrefs = {
  version: 1,
  renderMode: "2d",
  camera3d: {
    target: [0, 0, 0],
    position: [40, 24, 40],
  },
  quality3d: "auto",
  showGrid3d: false,
  bloom3d: true,
  cameraPresets3d: {},
  layoutMode3d: "force",
};

const PREFS_FILE = "explorer_prefs.json";

/**
 * Hard cap on persisted camera presets to keep the prefs file from
 * growing unboundedly when the operator hammers Shift+S across a large
 * graph. Excess entries are silently dropped during coercion.
 */
export const MAX_CAMERA_PRESETS = 256;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isVec3(v: unknown): v is [number, number, number] {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

/**
 * Coerce an arbitrary parsed value into a fully-defaulted ExplorerPrefs.
 * Unknown / wrong-type fields fall back to defaults silently — a corrupt
 * UI file must never wedge the Explorer.
 */
export function coercePrefs(input: unknown): ExplorerPrefs {
  if (!isPlainObject(input)) return { ...DEFAULT_PREFS };

  const renderMode =
    input.renderMode === "3d" || input.renderMode === "2d"
      ? input.renderMode
      : DEFAULT_PREFS.renderMode;

  const quality3d: ExplorerQuality =
    input.quality3d === "high" ||
    input.quality3d === "medium" ||
    input.quality3d === "low" ||
    input.quality3d === "auto"
      ? input.quality3d
      : DEFAULT_PREFS.quality3d;

  const camRaw = isPlainObject(input.camera3d) ? input.camera3d : {};
  const camera3d: ExplorerCamera3D = {
    target: isVec3(camRaw.target) ? camRaw.target : [...DEFAULT_PREFS.camera3d.target],
    position: isVec3(camRaw.position)
      ? camRaw.position
      : [...DEFAULT_PREFS.camera3d.position],
  };

  // Camera presets: per-node {target, position}. Drop malformed entries
  // silently and cap the total count so a runaway SPA can't grow the
  // file unboundedly. Keys must be non-empty strings.
  const presets: Record<string, ExplorerCamera3D> = {};
  if (isPlainObject(input.cameraPresets3d)) {
    const raw = input.cameraPresets3d as Record<string, unknown>;
    let kept = 0;
    for (const [id, value] of Object.entries(raw)) {
      if (kept >= MAX_CAMERA_PRESETS) break;
      if (typeof id !== "string" || id.length === 0) continue;
      if (!isPlainObject(value)) continue;
      const t = (value as Record<string, unknown>).target;
      const p = (value as Record<string, unknown>).position;
      if (!isVec3(t) || !isVec3(p)) continue;
      presets[id] = { target: [...t], position: [...p] };
      kept++;
    }
  }

  return {
    version: 1,
    renderMode,
    camera3d,
    quality3d,
    showGrid3d:
      typeof input.showGrid3d === "boolean" ? input.showGrid3d : DEFAULT_PREFS.showGrid3d,
    bloom3d:
      typeof input.bloom3d === "boolean" ? input.bloom3d : DEFAULT_PREFS.bloom3d,
    cameraPresets3d: presets,
    layoutMode3d:
      input.layoutMode3d === "radial" || input.layoutMode3d === "force"
        ? input.layoutMode3d
        : DEFAULT_PREFS.layoutMode3d,
  };
}

/**
 * Read the prefs file. Returns defaults if the file does not exist or is
 * malformed. Never throws on bad on-disk state.
 */
export async function loadExplorerPrefs(): Promise<ExplorerPrefs> {
  const path = dataPath(PREFS_FILE);
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    return coercePrefs(parsed);
  } catch (err) {
    if (isMissingFileError(err)) return { ...DEFAULT_PREFS };
    logger.warn(
      `explorer_prefs.json malformed (${(err as Error).message}); falling back to defaults`,
    );
    return { ...DEFAULT_PREFS };
  }
}

/**
 * Replace the prefs file on disk with the given (already-coerced) value.
 * Caller is responsible for serializing concurrent writes — Explorer is
 * single-user and the SPA only writes on user action, so contention is
 * effectively impossible.
 */
export async function saveExplorerPrefs(prefs: ExplorerPrefs): Promise<void> {
  const path = dataPath(PREFS_FILE);
  await atomicWriteFile(path, JSON.stringify(prefs, null, 2));
}

/**
 * Apply a shallow patch from the SPA, persist, return the resulting prefs.
 * All unknown fields in the patch are silently dropped by the coercer.
 */
export async function patchExplorerPrefs(patch: unknown): Promise<ExplorerPrefs> {
  const current = await loadExplorerPrefs();
  const merged = isPlainObject(patch) ? { ...current, ...patch } : current;
  const next = coercePrefs(merged);
  await saveExplorerPrefs(next);
  return next;
}
