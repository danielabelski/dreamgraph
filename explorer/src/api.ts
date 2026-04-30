import type {
  ExplorerEdgeKind,
  ExplorerNodeType,
  GraphSnapshot,
  NeighborhoodResult,
  NodeRecord,
  SearchResult,
  StatsResult,
  TensionView,
} from "./types";
import { EXPECTED_SNAPSHOT_VERSION } from "./types";

export class SnapshotVersionError extends Error {
  constructor(public got: number, public expected: number) {
    super(`Daemon snapshot version ${got} is newer than this Explorer build (${expected}). Update the SPA.`);
    this.name = "SnapshotVersionError";
  }
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function fetchSnapshot(): Promise<GraphSnapshot> {
  const body = await getJson<GraphSnapshot>("/explorer/api/graph-snapshot");
  if (body.version !== EXPECTED_SNAPSHOT_VERSION) {
    throw new SnapshotVersionError(body.version, EXPECTED_SNAPSHOT_VERSION);
  }
  return body;
}

export function fetchNode(id: string): Promise<NodeRecord> {
  return getJson<NodeRecord>(`/explorer/api/node/${encodeURIComponent(id)}`);
}

export function fetchNeighborhood(
  id: string,
  depth = 1,
  limit = 200,
): Promise<NeighborhoodResult> {
  return getJson<NeighborhoodResult>(
    `/explorer/api/neighborhood/${encodeURIComponent(id)}?depth=${depth}&limit=${limit}`,
  );
}

export function fetchSearch(
  q: string,
  types?: ExplorerNodeType[],
  limit = 25,
): Promise<SearchResult> {
  const qs = new URLSearchParams({ q, limit: String(limit) });
  if (types && types.length > 0) qs.set("types", types.join(","));
  return getJson<SearchResult>(`/explorer/api/search?${qs.toString()}`);
}

export function fetchEdges(
  kinds?: ExplorerEdgeKind[],
  minConf = 0,
  limit = 500,
): Promise<{ total: number; truncated: boolean; edges: unknown[] }> {
  const qs = new URLSearchParams({
    min_conf: String(minConf),
    limit: String(limit),
  });
  if (kinds && kinds.length > 0) qs.set("kind", kinds.join(","));
  return getJson(`/explorer/api/edges?${qs.toString()}`);
}

export function fetchTensions(
  status: "active" | "resolved" | "all" = "active",
): Promise<TensionView> {
  return getJson<TensionView>(`/explorer/api/tensions?status=${status}`);
}

export function fetchStats(): Promise<StatsResult> {
  return getJson<StatsResult>("/explorer/api/stats");
}

/* ------------------------------------------------------------------ */
/*  Slice E1 — recent-traffic heatmap                                 */
/* ------------------------------------------------------------------ */

export interface HeatmapResult {
  window_seconds: number;
  generated_at: string;
  total_events: number;
  max_count: number;
  /** [id, count] tuples sorted by count desc, then id asc. */
  nodes: Array<[string, number]>;
}

/**
 * Read recent per-entity traffic counts from `event_log.json`. Returns
 * an empty result on any error so the UI can fail open silently.
 */
export async function fetchHeatmap(
  windowSeconds = 3600,
): Promise<HeatmapResult> {
  try {
    return await getJson<HeatmapResult>(
      `/explorer/api/heatmap?window=${windowSeconds}`,
    );
  } catch {
    return {
      window_seconds: windowSeconds,
      generated_at: new Date().toISOString(),
      total_events: 0,
      max_count: 0,
      nodes: [],
    };
  }
}

export interface CandidateRow {
  dream_id: string;
  dream_type: "node" | "edge";
  confidence: number;
  plausibility: number;
  evidence_score: number;
  contradiction_score: number;
  evidence_count: number;
  reason_code: string;
  reason: string;
  validated_at: string;
  // Edge-only enrichment (populated when dream_type === "edge")
  from?: string;
  to?: string;
  relation?: string;
  edge_kind?: string;
  strategy?: string;
  dream_reason?: string;
  // Node-only enrichment (populated when dream_type === "node")
  name?: string;
  description?: string;
  entity_type?: string;
  inspiration?: string[];
  intent?: string;
  // Common
  dream_cycle?: number;
}

export interface CandidatesResult {
  total: number;
  pending: number;
  orphaned?: number;
  last_normalization: string | null;
  candidates: CandidateRow[];
}

export function fetchCandidates(): Promise<CandidatesResult> {
  return getJson<CandidatesResult>("/explorer/api/candidates");
}

interface ClientMetricsBatch {
  "render.node_count"?: number;
  "render.fps_estimate"?: number;
  "render.frame_drops"?: number;
  "snapshot.fetch_ms"?: number;
}

export function postClientMetrics(batch: ClientMetricsBatch): void {
  // Fire and forget; never block the UI on telemetry.
  void fetch("/explorer/api/metrics/client", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(batch),
  }).catch(() => undefined);
}

/* ------------------------------------------------------------------ */
/*  Explorer 3D mode (plans/EXPLORER_3D_MODE.md §9) — UI prefs        */
/* ------------------------------------------------------------------ */

export type ExplorerRenderMode = "2d" | "3d";
export type ExplorerQuality = "auto" | "high" | "medium" | "low";

export interface ExplorerCamera3D {
  target: [number, number, number];
  position: [number, number, number];
}

export interface ExplorerPrefs {
  version: 1;
  renderMode: ExplorerRenderMode;
  camera3d: ExplorerCamera3D;
  quality3d: ExplorerQuality;
  showGrid3d: boolean;
  bloom3d: boolean;
}

export const DEFAULT_EXPLORER_PREFS: ExplorerPrefs = {
  version: 1,
  renderMode: "2d",
  camera3d: { target: [0, 0, 0], position: [40, 24, 40] },
  quality3d: "auto",
  showGrid3d: false,
  bloom3d: true,
};

/**
 * Read UI prefs from the daemon. Falls back to defaults on any failure —
 * the Explorer must be usable even when the prefs file is unwritable.
 */
export async function fetchExplorerPrefs(): Promise<ExplorerPrefs> {
  try {
    return await getJson<ExplorerPrefs>("/explorer/api/prefs");
  } catch {
    return { ...DEFAULT_EXPLORER_PREFS };
  }
}

/**
 * Patch UI prefs. Fire-and-forget by design: a failed write should never
 * disrupt the user's session — they'll just lose the persisted choice.
 * Returns the merged prefs the daemon settled on, or `null` on error.
 */
export async function patchExplorerPrefs(
  patch: Partial<ExplorerPrefs>,
): Promise<ExplorerPrefs | null> {
  try {
    const res = await fetch("/explorer/api/prefs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) return null;
    return (await res.json()) as ExplorerPrefs;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Phase 4 / Slice 1 (frontend) — curated mutation helpers           */
/* ------------------------------------------------------------------ */

export interface MutationOptions {
  intent: string;
  body: Record<string, unknown>;
  reason: string;
  /** Active instance UUID — sent as `X-DreamGraph-Instance`. */
  instanceUuid: string;
  /** Snapshot etag the user was looking at — sent as `If-Match`. */
  etag: string;
  dryRun?: boolean;
}

export interface MutationResponse {
  ok: boolean;
  mutation_id?: string;
  applied_at?: string;
  affected?: string[];
  event_seq?: number;
  data?: unknown;
  error?: string;
  message?: string;
  /** When the daemon detected a stale etag, the latest one it knows. */
  current_etag?: string;
}

export class MutationConflictError extends Error {
  constructor(public currentEtag?: string) {
    super("Snapshot moved on while the form was open. Please retry.");
    this.name = "MutationConflictError";
  }
}

export async function applyMutation(opts: MutationOptions): Promise<MutationResponse> {
  const url = `/explorer/mutations/${encodeURIComponent(opts.intent)}${opts.dryRun ? "?dry=1" : ""}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-DreamGraph-Instance": opts.instanceUuid,
      "If-Match": opts.etag,
    },
    body: JSON.stringify({
      ...opts.body,
      reason: opts.reason,
      dry_run: opts.dryRun ?? false,
    }),
  });
  let body: MutationResponse = { ok: false };
  try {
    body = (await res.json()) as MutationResponse;
  } catch {
    // body parse failure — fall through with default
  }
  if (res.status === 412) {
    throw new MutationConflictError(body.current_etag);
  }
  if (!res.ok || body.ok === false) {
    const msg = body.message ?? body.error ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

export interface ReasonSuggestion {
  suggestion: string | null;
  source: "llm" | "fallback";
  model?: string;
}

export async function suggestReason(
  intent: string,
  subject: Record<string, unknown>,
  context: Record<string, unknown> = {},
): Promise<ReasonSuggestion> {
  try {
    const res = await fetch("/explorer/api/reason-suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent, subject, context }),
    });
    if (!res.ok) return { suggestion: null, source: "fallback" };
    const body = (await res.json()) as ReasonSuggestion & { ok: boolean };
    return { suggestion: body.suggestion ?? null, source: body.source ?? "fallback", model: body.model };
  } catch {
    return { suggestion: null, source: "fallback" };
  }
}

