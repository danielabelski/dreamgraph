/**
 * DreamGraph Causal Reasoning Engine
 *
 * Mines dream_history + tension_log to build causal inference chains.
 * Instead of just structural relationships (A connects to B), causal
 * reasoning identifies that *changing A causes B to fail*.
 *
 * Capabilities:
 *   - Build causal chains from historical tension/edge correlation
 *   - Identify propagation hotspots (entities that amplify failures)
 *   - Predict downstream impact of entity changes
 *   - Dream strategy: "causal_replay" — replay historical tensions
 *     forward to predict future breakage
 *
 * READ-ONLY against the Fact Graph. Writes only to dream space.
 */

import { randomUUID } from "node:crypto";
import { engine } from "./engine.js";
import { logger } from "../utils/logger.js";
import type {
  CausalLink,
  CausalChain,
  CausalInsights,
  DreamEdge,
  DreamHistoryEntry,
} from "./types.js";
import { DEFAULT_DECAY } from "./types.js";

// ---------------------------------------------------------------------------
// Causal Link Discovery
// ---------------------------------------------------------------------------

interface TensionEvent {
  entity: string;
  cycle: number;
  /** Real ISO timestamp the underlying tension was first/last seen. */
  timestamp_iso: string;
  urgency: number;
  type: string;
  domain: string;
  resolved: boolean;
}

/**
 * Build an ascending `(timestamp_ms, cycle_number)` index from dream history
 * so we can map any ISO timestamp back to the cycle in which it most likely
 * occurred. Used by `cycleFromIso` below.
 */
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

/**
 * Map an ISO timestamp to the cycle number whose session timestamp is the
 * nearest predecessor (or the earliest cycle if the timestamp is older than
 * any recorded session). Falls back to `latestCycle` for malformed input.
 */
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
  // Binary search for the largest entry with ts <= target
  let lo = 0;
  let hi = index.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (index[mid].ts <= ts) lo = mid;
    else hi = mid - 1;
  }
  return index[lo].cycle;
}

/**
 * Extract a timeline of tension events from history + tension log.
 * Each event records: which entity was troubled, when, and how urgently.
 *
 * Cycles are derived from real ISO timestamps on the signals (not from the
 * remaining-TTL counter, which is meaningless as an "age" indicator).
 */
async function buildTensionTimeline(): Promise<TensionEvent[]> {
  const [tensionFile, history] = await Promise.all([
    engine.loadTensions(),
    engine.loadDreamHistory(),
  ]);

  const index = buildHistoryIndex(history.sessions);
  const latestCycle =
    history.sessions.length > 0
      ? history.sessions[history.sessions.length - 1].cycle_number
      : 0;

  const events: TensionEvent[] = [];

  // Active tensions — use the signal's own first_seen timestamp.
  for (const signal of tensionFile.signals) {
    const cycle = cycleFromIso(signal.first_seen, index, latestCycle);
    for (const entity of signal.entities) {
      events.push({
        entity,
        cycle,
        timestamp_iso: signal.first_seen,
        urgency: signal.urgency,
        type: signal.type,
        domain: signal.domain,
        resolved: signal.resolved,
      });
    }
  }

  // Resolved tensions — use the original signal's first_seen timestamp,
  // not its remaining-TTL counter.
  for (const resolved of tensionFile.resolved_tensions ?? []) {
    const cycle = cycleFromIso(resolved.original.first_seen, index, latestCycle);
    for (const entity of resolved.original.entities) {
      events.push({
        entity,
        cycle,
        timestamp_iso: resolved.original.first_seen,
        urgency: resolved.original.urgency,
        type: resolved.original.type,
        domain: resolved.original.domain,
        resolved: true,
      });
    }
  }

  return events.sort((a, b) => a.cycle - b.cycle);
}

/**
 * Find pairs of entities where tension in entity A consistently
 * precedes tension in entity B within a lag window.
 */
function discoverCausalLinks(
  events: TensionEvent[],
  maxLag: number = 5
): CausalLink[] {
  // Group events by entity
  const byEntity = new Map<string, TensionEvent[]>();
  for (const e of events) {
    const list = byEntity.get(e.entity) ?? [];
    list.push(e);
    byEntity.set(e.entity, list);
  }

  const links: CausalLink[] = [];
  const entities = [...byEntity.keys()];
  const now = new Date().toISOString();

  for (let i = 0; i < entities.length; i++) {
    for (let j = 0; j < entities.length; j++) {
      if (i === j) continue;

      const causeEvents = byEntity.get(entities[i])!;
      const effectEvents = byEntity.get(entities[j])!;

      let coOccurrences = 0;
      let totalLag = 0;
      let firstObservedTs: number = Number.POSITIVE_INFINITY;
      let lastObservedTs: number = Number.NEGATIVE_INFINITY;

      for (const cause of causeEvents) {
        for (const effect of effectEvents) {
          const lag = effect.cycle - cause.cycle;
          if (lag > 0 && lag <= maxLag) {
            coOccurrences++;
            totalLag += lag;
            const causeTs = Date.parse(cause.timestamp_iso);
            const effectTs = Date.parse(effect.timestamp_iso);
            if (Number.isFinite(causeTs) && causeTs < firstObservedTs) {
              firstObservedTs = causeTs;
            }
            if (Number.isFinite(effectTs) && effectTs > lastObservedTs) {
              lastObservedTs = effectTs;
            }
          }
        }
      }

      // Require at least 2 co-occurrences for statistical significance
      if (coOccurrences < 2) continue;

      const avgLag = totalLag / coOccurrences;
      // Correlation strength: normalized by total possible co-occurrences
      const maxPossible = Math.min(causeEvents.length, effectEvents.length);
      const strength = Math.round(
        Math.min(coOccurrences / Math.max(maxPossible, 1), 1) * 100
      ) / 100;

      if (strength < 0.3) continue; // Filter weak correlations

      const firstObservedIso = Number.isFinite(firstObservedTs)
        ? new Date(firstObservedTs).toISOString()
        : now;
      const lastObservedIso = Number.isFinite(lastObservedTs)
        ? new Date(lastObservedTs).toISOString()
        : now;

      links.push({
        cause_entity: entities[i],
        effect_entity: entities[j],
        lag_cycles: Math.round(avgLag * 10) / 10,
        correlation_strength: strength,
        observed_count: coOccurrences,
        first_observed: firstObservedIso,
        last_observed: lastObservedIso,
        description: `Changes to "${entities[i]}" are followed by tensions in "${entities[j]}" within ~${Math.round(avgLag)} cycles (observed ${coOccurrences} times)`,
      });
    }
  }

  return links.sort((a, b) => b.correlation_strength - a.correlation_strength);
}

/**
 * Build multi-hop causal chains from individual links.
 * A → B → C where A→B and B→C are both causal links.
 */
function buildCausalChains(links: CausalLink[], maxDepth: number = 4): CausalChain[] {
  const chains: CausalChain[] = [];
  const linksBySource = new Map<string, CausalLink[]>();

  for (const link of links) {
    const list = linksBySource.get(link.cause_entity) ?? [];
    list.push(link);
    linksBySource.set(link.cause_entity, list);
  }

  // BFS from each root cause
  for (const rootLink of links) {
    const visited = new Set<string>([rootLink.cause_entity]);
    const queue: Array<{ path: CausalLink[]; current: string }> = [
      { path: [rootLink], current: rootLink.effect_entity },
    ];

    while (queue.length > 0) {
      const { path, current } = queue.shift()!;

      if (path.length >= maxDepth) continue;
      if (visited.has(current)) continue;
      visited.add(current);

      // Record chain if path > 1
      if (path.length >= 2) {
        const totalStrength = path.reduce(
          (acc, l) => acc * l.correlation_strength, 1
        );
        chains.push({
          id: `causal_chain_${randomUUID()}`,
          links: [...path],
          total_strength: Math.round(totalStrength * 100) / 100,
          root_cause: path[0].cause_entity,
          terminal_effect: path[path.length - 1].effect_entity,
          discovered_at: new Date().toISOString(),
        });
      }

      // Continue BFS
      const nextLinks = linksBySource.get(current) ?? [];
      for (const next of nextLinks) {
        if (!visited.has(next.effect_entity)) {
          queue.push({
            path: [...path, next],
            current: next.effect_entity,
          });
        }
      }
    }
  }

  return chains.sort((a, b) => b.total_strength - a.total_strength).slice(0, 20);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze the system's history for causal patterns.
 * Returns chains, hotspots, and predicted impacts.
 */
export async function analyzeCausality(): Promise<CausalInsights> {
  logger.info("Causal analysis starting");

  const events = await buildTensionTimeline();
  logger.debug(`Built tension timeline: ${events.length} events`);

  const links = discoverCausalLinks(events);
  logger.debug(`Discovered ${links.length} causal links`);

  const chains = buildCausalChains(links);
  logger.debug(`Built ${chains.length} causal chains`);

  // Propagation hotspots: entities that appear as cause in many links
  const causeCount = new Map<string, { count: number; totalLag: number }>();
  for (const link of links) {
    const existing = causeCount.get(link.cause_entity) ?? { count: 0, totalLag: 0 };
    existing.count++;
    existing.totalLag += link.lag_cycles;
    causeCount.set(link.cause_entity, existing);
  }

  const propagation_hotspots = [...causeCount.entries()]
    .map(([entity, stats]) => ({
      entity,
      downstream_count: stats.count,
      avg_lag: Math.round((stats.totalLag / stats.count) * 10) / 10,
    }))
    .sort((a, b) => b.downstream_count - a.downstream_count)
    .slice(0, 10);

  // Predicted impacts: for each hotspot, list affected entities
  const predicted_impacts = propagation_hotspots.map((hotspot) => {
    const affected = links
      .filter((l) => l.cause_entity === hotspot.entity)
      .map((l) => l.effect_entity);
    return {
      if_changed: hotspot.entity,
      likely_affected: [...new Set(affected)],
      confidence: Math.round(
        (links
          .filter((l) => l.cause_entity === hotspot.entity)
          .reduce((sum, l) => sum + l.correlation_strength, 0) /
          Math.max(affected.length, 1)) * 100
      ) / 100,
    };
  });

  logger.info(
    `Causal analysis complete: ${chains.length} chains, ${propagation_hotspots.length} hotspots`
  );

  return { chains, propagation_hotspots, predicted_impacts };
}

/**
 * Causal Replay dream strategy.
 * Replays historical tension patterns forward to generate
 * speculative edges predicting future breakage.
 *
 * PRECONDITION: Engine must be in REM state.
 */
export async function causalReplayDream(
  cycle: number,
  max: number
): Promise<DreamEdge[]> {
  engine.assertState("rem", "causalReplayDream");

  const events = await buildTensionTimeline();
  const links = discoverCausalLinks(events);
  const edges: DreamEdge[] = [];
  const now = new Date().toISOString();

  // For each strong causal link, generate a predictive dream edge
  for (const link of links.slice(0, max)) {
    edges.push({
      id: `dream_causal_${randomUUID()}`,
      from: link.cause_entity,
      to: link.effect_entity,
      type: "hypothetical",
      relation: `causal_dependency`,
      reason: `Causal inference: ${link.description}. Strength: ${link.correlation_strength}, lag: ${link.lag_cycles} cycles`,
      confidence: Math.round(link.correlation_strength * 0.8 * 100) / 100,
      origin: "rem",
      created_at: now,
      dream_cycle: cycle,
      strategy: "causal_replay",
      meta: {
        causal_lag: link.lag_cycles,
        observed_count: link.observed_count,
        correlation_strength: link.correlation_strength,
      },
      ttl: DEFAULT_DECAY.ttl + 2, // Causal edges get longer TTL
      decay_rate: DEFAULT_DECAY.decay_rate,
      // Start at 0 like every other dream edge — historical co-occurrence
      // count is preserved in `meta.observed_count` for transparency, but
      // pre-seeding `reinforcement_count` would short-circuit the promotion
      // threshold without any in-cycle reinforcement actually happening.
      reinforcement_count: 0,
      last_reinforced_cycle: cycle,
      status: "candidate",
      activation_score: 0,
      plausibility: 0,
      evidence_score: 0,
      contradiction_score: 0,
    });
  }

  logger.info(`Causal replay: generated ${edges.length} predictive dream edges`);
  return edges;
}
