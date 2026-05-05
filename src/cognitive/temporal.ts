/**
 * DreamGraph Temporal Dreaming Engine
 *
 * Adds a time dimension to the cognitive system:
 *
 *   Retrocognition — "3 months ago, tension X was latent. Then feature Y
 *     was shipped. The tension resolved. What latent tensions share that
 *     trajectory?"
 *
 *   Precognition — Given current validated edges + latent tensions + cycle
 *     velocity, predict which tensions will become critical in 1/2/4 weeks.
 *
 *   Seasonal Awareness — Learn that certain domains get heavy development
 *     at certain periods and proactively deepen dreaming in those areas.
 *
 *   Tension Thermodynamics — Track how tension energy flows, transforms,
 *     and dissipates over time.
 *
 * READ-ONLY against fact data. Analyzes dream_history and tension_log.
 */

import { engine } from "./engine.js";
import { logger } from "../utils/logger.js";
import type {
  TensionTrajectory,
  TemporalPrediction,
  SeasonalPattern,
  TemporalInsights,
  DreamHistoryEntry,
  ResolvedTension,
} from "./types.js";

// ---------------------------------------------------------------------------
// History indexing — map ISO timestamps back to cycle numbers
// ---------------------------------------------------------------------------

function buildHistoryIndex(
  sessions: DreamHistoryEntry[],
): Array<{ ts: number; cycle: number }> {
  const idx: Array<{ ts: number; cycle: number }> = [];
  for (const s of sessions) {
    const ts = Date.parse(s.timestamp);
    if (Number.isFinite(ts)) idx.push({ ts, cycle: s.cycle_number });
  }
  idx.sort((a, b) => a.ts - b.ts);
  return idx;
}

function cycleFromIso(
  iso: string | undefined,
  index: Array<{ ts: number; cycle: number }>,
  latestCycle: number,
): number {
  if (!iso) return latestCycle;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts) || index.length === 0) return latestCycle;
  if (ts <= index[0].ts) return index[0].cycle;
  if (ts >= index[index.length - 1].ts) return index[index.length - 1].cycle;
  let lo = 0;
  let hi = index.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (index[mid].ts <= ts) lo = mid;
    else hi = mid - 1;
  }
  return index[lo].cycle;
}

// ---------------------------------------------------------------------------
// Trajectory Analysis
// ---------------------------------------------------------------------------

/**
 * Build urgency-over-time trajectories for all known tensions.
 *
 * Each trajectory has at most two anchored data points: when the tension was
 * first seen and when it was last seen (or resolved). We deliberately do
 * **not** fabricate intermediate points by extrapolating from `ttl` —
 * those synthesized curves were monotonic by construction and broke every
 * downstream peak/seasonality detector.
 */
async function buildTrajectories(): Promise<TensionTrajectory[]> {
  const [tensionFile, history] = await Promise.all([
    engine.loadTensions(),
    engine.loadDreamHistory(),
  ]);

  const index = buildHistoryIndex(history.sessions);
  const latestCycle =
    history.sessions.length > 0
      ? history.sessions[history.sessions.length - 1].cycle_number
      : 0;

  const trajectories: TensionTrajectory[] = [];

  // Active tensions: anchor at (first_seen_cycle, urgency) and
  // (last_seen_cycle, urgency). If only one anchor is available the
  // trajectory degenerates to a single point.
  for (const signal of tensionFile.signals) {
    if (signal.resolved) continue;

    const firstCycle = cycleFromIso(signal.first_seen, index, latestCycle);
    const lastCycle = cycleFromIso(signal.last_seen, index, latestCycle);
    const points: Array<{ cycle: number; urgency: number }> = [];
    points.push({
      cycle: firstCycle,
      urgency: Math.round(signal.urgency * 100) / 100,
    });
    if (lastCycle !== firstCycle) {
      points.push({
        cycle: lastCycle,
        urgency: Math.round(signal.urgency * 100) / 100,
      });
    }

    const pattern = classifyPattern(points);

    trajectories.push({
      tension_id: signal.id,
      domain: signal.domain,
      urgency_over_time: points,
      peak_urgency: Math.round(signal.urgency * 100) / 100,
      pattern,
    });
  }

  // Resolved tensions: anchor at (first_seen_cycle, peak_urgency) and
  // (resolved_at_cycle, 0).
  for (const resolved of tensionFile.resolved_tensions ?? []) {
    const original = resolved.original;
    const firstCycle = cycleFromIso(original.first_seen, index, latestCycle);
    const resolutionCycle = cycleFromIso(resolved.resolved_at, index, latestCycle);

    const points: Array<{ cycle: number; urgency: number }> = [
      { cycle: firstCycle, urgency: Math.round(original.urgency * 100) / 100 },
      { cycle: resolutionCycle, urgency: 0 },
    ];

    trajectories.push({
      tension_id: original.id,
      domain: original.domain,
      urgency_over_time: points,
      peak_urgency: original.urgency,
      resolution_cycle: resolutionCycle,
      pattern: "resolved",
    });
  }

  return trajectories;
}

/**
 * Classify a trajectory pattern from urgency points.
 */
function classifyPattern(
  points: Array<{ cycle: number; urgency: number }>
): "rising" | "falling" | "stable" | "spike" | "resolved" {
  if (points.length < 2) return "stable";

  const first = points[0].urgency;
  const last = points[points.length - 1].urgency;
  const max = Math.max(...points.map((p) => p.urgency));
  const delta = last - first;

  if (last === 0) return "resolved";
  if (max > first * 2 && max > last * 1.5) return "spike";
  if (delta > 0.15) return "rising";
  if (delta < -0.15) return "falling";
  return "stable";
}

// ---------------------------------------------------------------------------
// Precognition (Prediction)
// ---------------------------------------------------------------------------

/**
 * Predict which entities will develop tensions based on trajectory patterns.
 * Uses pattern matching: if entity A's trajectory matches what entity B
 * looked like before it became critical, predict B-like trouble for A.
 */
async function predictFutureTensions(
  trajectories: TensionTrajectory[]
): Promise<TemporalPrediction[]> {
  const predictions: TemporalPrediction[] = [];
  const tensionFile = await engine.loadTensions();

  // Rising trajectories are predictors of future critical tensions
  const rising = trajectories.filter((t) => t.pattern === "rising");

  for (const trajectory of rising) {
    const points = trajectory.urgency_over_time;
    if (points.length < 2) continue;

    const last = points[points.length - 1];
    const rate = points.length > 1
      ? (last.urgency - points[0].urgency) / points.length
      : 0;

    if (rate <= 0) continue;

    // Estimate cycles to critical (urgency >= 0.8)
    const remaining = Math.max(0, 0.8 - last.urgency);
    const cyclesToCritical = Math.ceil(remaining / rate);

    // Find the original tension to get entity info
    const signal = tensionFile.signals.find(
      (s) => s.id === trajectory.tension_id
    );
    if (!signal) continue;

    for (const entity of signal.entities) {
      predictions.push({
        entity_id: entity,
        predicted_tension_type: signal.type,
        confidence: Math.round(Math.min(rate * 5, 0.9) * 100) / 100,
        estimated_cycles_to_critical: cyclesToCritical,
        basis: `Tension "${trajectory.tension_id}" for entity "${entity}" has rising urgency (rate: +${(rate).toFixed(3)}/cycle). Predicted critical in ~${cyclesToCritical} cycles.`,
      });
    }
  }

  // Also predict from resolved patterns: entities with resolved tensions
  // in the same domain may develop similar issues
  const resolvedByDomain = new Map<string, ResolvedTension[]>();
  for (const resolved of tensionFile.resolved_tensions ?? []) {
    const domain = resolved.original.domain;
    const list = resolvedByDomain.get(domain) ?? [];
    list.push(resolved);
    resolvedByDomain.set(domain, list);
  }

  // If a domain has many resolved tensions, entities in that domain
  // are likely to develop new tensions (pattern recurrence).
  for (const [domain, resolved] of resolvedByDomain) {
    if (resolved.length < 3) continue; // Need enough history

    // Skip per-entity prediction only when that *entity* already has an
    // active tension in this domain — the prediction would be noise.
    const activelyTrackedEntities = new Set<string>();
    for (const sig of tensionFile.signals) {
      if (sig.domain === domain && !sig.resolved) {
        for (const e of sig.entities) activelyTrackedEntities.add(e);
      }
    }

    // Predict recurrence for entities that had resolved tensions
    const entityFrequency = new Map<string, number>();
    for (const r of resolved) {
      for (const e of r.original.entities) {
        entityFrequency.set(e, (entityFrequency.get(e) ?? 0) + 1);
      }
    }

    for (const [entity, freq] of entityFrequency) {
      if (freq < 2) continue;
      if (activelyTrackedEntities.has(entity)) continue;
      predictions.push({
        entity_id: entity,
        predicted_tension_type: "weak_connection",
        confidence: Math.round(Math.min(freq * 0.15, 0.7) * 100) / 100,
        estimated_cycles_to_critical: Math.round(30 / freq),
        basis: `Entity "${entity}" in domain "${domain}" has had ${freq} resolved tensions. Historical pattern suggests recurrence.`,
      });
    }
  }

  return predictions.sort((a, b) => b.confidence - a.confidence).slice(0, 15);
}

// ---------------------------------------------------------------------------
// Seasonal Pattern Detection
// ---------------------------------------------------------------------------

/**
 * Detect seasonal patterns: domains that have cyclical tension activity.
 *
 * NOTE: this is a placeholder. Honest seasonality detection needs
 * per-cycle, per-domain tension counts that the dream-history schema does
 * not yet record. The previous implementation tried to derive those counts
 * from per-tension trajectories, but every trajectory was a synthesised
 * monotonic curve — peak detection was structurally impossible. Returns an
 * empty list until `DreamHistoryEntry` carries domain-level signal counts.
 */
async function detectSeasonalPatterns(
  _trajectories: TensionTrajectory[],
): Promise<SeasonalPattern[]> {
  return [];
}

// ---------------------------------------------------------------------------
// Retrocognition
// ---------------------------------------------------------------------------

/**
 * Find latent tensions that match the trajectories of previously resolved tensions.
 * "This latent tension looks like tension X did before it was resolved."
 */
async function findRetrocognitiveMatches(
  trajectories: TensionTrajectory[]
): Promise<Array<{ pattern: string; past_resolution: string; latent_matches: string[] }>> {
  const tensionFile = await engine.loadTensions();
  const matches: Array<{ pattern: string; past_resolution: string; latent_matches: string[] }> = [];

  // Get resolved trajectory patterns
  const resolvedTrajectories = trajectories.filter((t) => t.pattern === "resolved");
  const activeTrajectories = trajectories.filter(
    (t) => t.pattern !== "resolved"
  );

  for (const resolved of resolvedTrajectories) {
    // Find active tensions in the same domain with similar peak urgency
    const similar = activeTrajectories.filter(
      (t) =>
        t.domain === resolved.domain &&
        Math.abs(t.peak_urgency - resolved.peak_urgency) < 0.2
    );

    if (similar.length === 0) continue;

    const resolvedTension = tensionFile.resolved_tensions?.find(
      (r) => r.tension_id === resolved.tension_id
    );

    matches.push({
      pattern: `${resolved.domain} tension peaking at ~${resolved.peak_urgency.toFixed(2)}`,
      past_resolution: resolvedTension
        ? `Resolved as "${resolvedTension.resolution_type}"${resolvedTension.evidence ? `: ${resolvedTension.evidence}` : ""}`
        : "Resolution details unavailable",
      latent_matches: similar.map((s) => s.tension_id),
    });
  }

  return matches.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run temporal analysis across all available history.
 * Returns trajectories, predictions, seasonal patterns, and retrocognitive matches.
 */
export async function analyzeTemporalPatterns(): Promise<TemporalInsights> {
  logger.info("Temporal analysis starting");

  const history = await engine.loadDreamHistory();
  const trajectories = await buildTrajectories();
  logger.debug(`Built ${trajectories.length} tension trajectories`);

  const predictions = await predictFutureTensions(trajectories);
  logger.debug(`Generated ${predictions.length} temporal predictions`);

  const seasonal_patterns = await detectSeasonalPatterns(trajectories);
  logger.debug(`Detected ${seasonal_patterns.length} seasonal patterns`);

  const retrocognition = await findRetrocognitiveMatches(trajectories);
  logger.debug(`Found ${retrocognition.length} retrocognitive matches`);

  const sessions = history.sessions;
  const time_horizon = {
    total_cycles_analyzed: sessions.length,
    oldest_data: sessions.length > 0 ? sessions[0].timestamp : new Date().toISOString(),
    newest_data: sessions.length > 0 ? sessions[sessions.length - 1].timestamp : new Date().toISOString(),
  };

  logger.info(
    `Temporal analysis complete: ${trajectories.length} trajectories, ` +
    `${predictions.length} predictions, ${seasonal_patterns.length} seasonal patterns`
  );

  return {
    trajectories: trajectories.slice(0, 20),
    predictions,
    seasonal_patterns,
    retrocognition,
    time_horizon,
  };
}
