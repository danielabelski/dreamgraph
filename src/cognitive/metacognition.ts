/**
 * DreamGraph v8.3 â€” Metacognitive Self-Tuning Engine
 *
 * Closes the feedback loop: analyzes DreamGraph's own performance and
 * recommends (or auto-applies) threshold adjustments.
 *
 * Three analysis modes:
 * 1. Strategy Performance â€” precision, resolution-share, validation lag per strategy
 * 2. Promotion Calibration â€” actual validation rates per confidence bucket
 * 3. Domain Decay Profiles â€” per-domain optimal TTL and urgency decay
 *
 * Safety guarantees:
 * - Analysis is read-only against dream_history, tensions, candidates
 * - Auto-tuning is bounded (hard min/max guards)
 * - Auto-tuning is transparent (every action logged to meta_log.json)
 * - Auto-tuning never persists to disk â€” overrides are in-memory only and
 *   reset on restart. Policy-profile tuning remains the durable baseline.
 *
 * v8.3 fixes vs v5.1:
 * - Strategy list pulled from `ALL_DREAM_STRATEGIES_NON_ALL` (single source
 *   of truth) instead of a hardcoded subset.
 * - Sessions with `strategy === "all"` are decomposed via the
 *   `per_strategy_yields` breakdown when present, with a dream-graph
 *   fallback for legacy entries â€” no more silent collapse to gap_detection.
 * - Validated-edge attribution uses `edge.strategy` (recorded at promotion)
 *   with a dream-graph lookup fallback. The pre-v8.3 trick of reading
 *   `session.strategy` for the dream cycle gave wrong answers whenever
 *   that session ran "all".
 * - Calibration buckets honour the rolling window: candidates outside the
 *   selected cycle range are filtered out before bucketing.
 * - Domain decay's `avg_resolution_cycles` derives from the
 *   first_seen â†’ resolved_at timestamp delta instead of the broken
 *   `initialTtl - r.original.ttl` arithmetic that always produced 0.
 * - Threshold recommendations compare against the *effective* promotion
 *   config (policy + overrides), not the static `DEFAULT_PROMOTION`.
 * - `auto_apply: true` actually mutates engine state via
 *   `engine.setPromotionOverride(...)` and records before/after values.
 *
 * Design: "Think about how you think. Tune how you tune."
 */

import { readFile } from "node:fs/promises";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { existsSync } from "node:fs";
import { engine } from "./engine.js";
import { logger } from "../utils/logger.js";
import { dataPath } from "../utils/paths.js";
import {
  ALL_DREAM_STRATEGIES_NON_ALL,
  DEFAULT_TENSION_CONFIG,
} from "./types.js";
import type {
  DreamStrategy,
  DreamHistoryEntry,
  ValidationResult,
  ValidatedEdge,
  TensionSignal,
  ResolvedTension,
  TensionDomain,
  PromotionConfig,
  StrategyMetrics,
  CalibrationBucket,
  ThresholdRecommendation,
  DomainDecayProfile,
  MetaLogEntry,
  MetaLogFile,
} from "./types.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const metaLogPath = () => dataPath("meta_log.json");

// ---------------------------------------------------------------------------
// Safety Guards
// ---------------------------------------------------------------------------

const GUARDS = {
  promotion_confidence: { min: 0.55, max: 0.90 },
  promotion_plausibility: { min: 0.30, max: 0.80 },
  promotion_evidence: { min: 0.25, max: 0.80 },
  promotion_evidence_count: { min: 1, max: 5 },
  retention_plausibility: { min: 0.20, max: 0.60 },
  max_contradiction: { min: 0.15, max: 0.50 },
} as const;

const DECAY_GUARDS = {
  ttl: { min: 5, max: 60 },
  urgency_decay: { min: 0.005, max: 0.10 },
} as const;

/** Minimum confidence on a recommendation before auto_apply will act on it. */
const AUTO_APPLY_MIN_CONFIDENCE = 0.6;

// ---------------------------------------------------------------------------
// Strategy Attribution Helpers
// ---------------------------------------------------------------------------

/** All concrete strategies (excluding "all") â€” single source of truth. */
const ALL_STRATEGIES: ReadonlyArray<Exclude<DreamStrategy, "all">> =
  ALL_DREAM_STRATEGIES_NON_ALL;

/**
 * Compute generated edge+node yield per strategy across a window.
 *
 * For sessions whose `strategy !== "all"`, all generated artifacts are
 * credited to that strategy.
 *
 * For sessions where `strategy === "all"`, the per-strategy breakdown is
 * preferred (recorded in `per_strategy_yields` from v8.3+). When the
 * breakdown is missing (legacy entries), the cycle's total yield is
 * apportioned uniformly across `ALL_STRATEGIES` as a least-bad fallback â€”
 * this is documented in the meta-log basis text so consumers know the
 * numbers may be approximate for older windows.
 */
function distributeYieldByStrategy(
  sessions: DreamHistoryEntry[],
): Map<Exclude<DreamStrategy, "all">, number> {
  const out = new Map<Exclude<DreamStrategy, "all">, number>();
  for (const s of ALL_STRATEGIES) out.set(s, 0);

  for (const s of sessions) {
    const total = s.generated_edges + s.generated_nodes;
    if (total === 0) continue;

    if (s.strategy !== "all") {
      const key = s.strategy as Exclude<DreamStrategy, "all">;
      out.set(key, (out.get(key) ?? 0) + total);
      continue;
    }

    const breakdown = s.per_strategy_yields;
    if (breakdown && Object.keys(breakdown).length > 0) {
      for (const strat of ALL_STRATEGIES) {
        const v = breakdown[strat];
        if (typeof v === "number" && v > 0) {
          out.set(strat, (out.get(strat) ?? 0) + v);
        }
      }
    } else {
      // Legacy fallback: distribute uniformly. Better than collapsing to one.
      const share = total / ALL_STRATEGIES.length;
      for (const strat of ALL_STRATEGIES) {
        out.set(strat, (out.get(strat) ?? 0) + share);
      }
    }
  }
  return out;
}

/**
 * Build a `dreamId -> strategy` lookup using:
 *  1. ValidationResult.strategy (when populated by the v8.3+ normalizer)
 *  2. ValidatedEdge.strategy (same)
 *  3. dreamGraphEdges (for items still in the dream graph)
 *
 * Returns a map keyed by dream artifact id.
 */
function buildStrategyLookup(
  candidates: ValidationResult[],
  validatedEdges: ValidatedEdge[],
  dreamGraphEdges: Array<{ id: string; strategy?: DreamStrategy }>,
): Map<string, Exclude<DreamStrategy, "all">> {
  const map = new Map<string, Exclude<DreamStrategy, "all">>();
  const accept = (id: string, strat: DreamStrategy | undefined) => {
    if (!strat || strat === "all") return;
    if (!map.has(id)) map.set(id, strat as Exclude<DreamStrategy, "all">);
  };
  for (const c of candidates) accept(c.dream_id, c.strategy);
  for (const v of validatedEdges) accept(v.id, v.strategy);
  for (const e of dreamGraphEdges) accept(e.id, e.strategy);
  return map;
}

// ---------------------------------------------------------------------------
// Strategy Metrics
// ---------------------------------------------------------------------------

function computeStrategyMetrics(
  sessions: DreamHistoryEntry[],
  candidates: ValidationResult[],
  validatedEdges: ValidatedEdge[],
  resolvedTensions: ResolvedTension[],
  strategyLookup: Map<string, Exclude<DreamStrategy, "all">>,
): StrategyMetrics[] {
  // Window time bounds for tension attribution
  const windowStart =
    sessions.length > 0 ? new Date(sessions[0].timestamp).getTime() : 0;
  const windowEnd =
    sessions.length > 0
      ? new Date(sessions[sessions.length - 1].timestamp).getTime()
      : Infinity;

  // Generated yield per strategy
  const generatedByStrategy = distributeYieldByStrategy(sessions);

  // Validated yield per strategy (true attribution via lookup)
  const validatedByStrategy = new Map<Exclude<DreamStrategy, "all">, number>();
  for (const s of ALL_STRATEGIES) validatedByStrategy.set(s, 0);
  for (const edge of validatedEdges) {
    const strat =
      (edge.strategy && edge.strategy !== "all"
        ? (edge.strategy as Exclude<DreamStrategy, "all">)
        : undefined) ?? strategyLookup.get(edge.id);
    if (!strat) continue;
    validatedByStrategy.set(strat, (validatedByStrategy.get(strat) ?? 0) + 1);
  }

  // Validation lag per strategy (avg cycles from generation to validation)
  const lagByStrategy = new Map<Exclude<DreamStrategy, "all">, number[]>();
  for (const s of ALL_STRATEGIES) lagByStrategy.set(s, []);
  for (const edge of validatedEdges) {
    const strat =
      (edge.strategy && edge.strategy !== "all"
        ? (edge.strategy as Exclude<DreamStrategy, "all">)
        : undefined) ?? strategyLookup.get(edge.id);
    if (!strat) continue;
    const lag = edge.normalization_cycle - edge.dream_cycle;
    if (Number.isFinite(lag) && lag >= 0) {
      lagByStrategy.get(strat)!.push(lag);
    }
  }

  // Tension-resolution share per strategy.
  // We have no direct "which strategy produced the resolving edge" link in
  // the historical data, so we apportion each session's
  // `tension_signals_resolved` count by the session's per-strategy yield
  // proportion. For non-"all" sessions this credits the single strategy.
  const tensionsByStrategy = new Map<Exclude<DreamStrategy, "all">, number>();
  for (const s of ALL_STRATEGIES) tensionsByStrategy.set(s, 0);
  for (const sess of sessions) {
    if (sess.tension_signals_resolved <= 0) continue;
    if (sess.strategy !== "all") {
      const key = sess.strategy as Exclude<DreamStrategy, "all">;
      tensionsByStrategy.set(
        key,
        (tensionsByStrategy.get(key) ?? 0) + sess.tension_signals_resolved,
      );
      continue;
    }
    const breakdown = sess.per_strategy_yields;
    if (breakdown) {
      const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
      if (total > 0) {
        for (const strat of ALL_STRATEGIES) {
          const share = (breakdown[strat] ?? 0) / total;
          if (share > 0) {
            tensionsByStrategy.set(
              strat,
              (tensionsByStrategy.get(strat) ?? 0) +
                sess.tension_signals_resolved * share,
            );
          }
        }
        continue;
      }
    }
    // Uniform fallback for legacy "all" sessions
    const share = sess.tension_signals_resolved / ALL_STRATEGIES.length;
    for (const strat of ALL_STRATEGIES) {
      tensionsByStrategy.set(strat, (tensionsByStrategy.get(strat) ?? 0) + share);
    }
  }

  const totalTensionsInWindow = resolvedTensions.filter((r) => {
    const ts = new Date(r.resolved_at).getTime();
    return ts >= windowStart && ts <= windowEnd;
  }).length;

  // Consecutive zero-yield: walk sessions newest-first and count cycles
  // that produced nothing for this strategy.
  function consecutiveZero(strategy: Exclude<DreamStrategy, "all">): number {
    let n = 0;
    for (let i = sessions.length - 1; i >= 0; i--) {
      const s = sessions[i];
      let strategyYield = 0;
      if (s.strategy === strategy) {
        strategyYield = s.generated_edges + s.generated_nodes;
      } else if (s.strategy === "all") {
        const breakdown = s.per_strategy_yields;
        if (breakdown) {
          strategyYield = breakdown[strategy] ?? 0;
        } else {
          // Legacy "all" without breakdown: cannot tell â€” bail out so we
          // don't penalise a strategy for missing instrumentation.
          break;
        }
      } else {
        // Different concrete strategy ran: doesn't count for this one
        // either way; skip.
        continue;
      }
      if (strategyYield === 0) n++;
      else break;
    }
    return n;
  }

  // candidates parameter unused in this function but kept for API stability;
  // bucket-level analysis happens in computeCalibrationBuckets.
  void candidates;

  return ALL_STRATEGIES.map((strategy): StrategyMetrics => {
    const totalGenerated = Math.round(generatedByStrategy.get(strategy) ?? 0);
    const totalValidated = validatedByStrategy.get(strategy) ?? 0;
    const precision = totalGenerated > 0 ? totalValidated / totalGenerated : 0;

    const lags = lagByStrategy.get(strategy) ?? [];
    const avgLag =
      lags.length > 0 ? lags.reduce((a, b) => a + b, 0) / lags.length : 0;

    const tensionsResolved = Math.round(tensionsByStrategy.get(strategy) ?? 0);
    const recall =
      totalTensionsInWindow > 0
        ? tensionsResolved / totalTensionsInWindow
        : 0;

    const cz = consecutiveZero(strategy);

    let weight = 1.0;
    if (precision > 0.5) weight += 0.3;
    if (precision > 0.3) weight += 0.1;
    if (cz >= 3) weight *= 0.5;
    if (cz >= 5) weight *= 0.2;
    if (totalGenerated === 0) weight = 0.3;
    weight = Math.round(Math.max(0.1, Math.min(2.0, weight)) * 100) / 100;

    return {
      strategy,
      total_generated: totalGenerated,
      total_validated: totalValidated,
      precision: Math.round(precision * 1000) / 1000,
      tensions_resolved: tensionsResolved,
      recall: Math.round(recall * 1000) / 1000,
      avg_validation_lag: Math.round(avgLag * 10) / 10,
      consecutive_zero_yield: cz,
      recommended_weight: weight,
    };
  });
}

// ---------------------------------------------------------------------------
// Promotion Threshold Calibration
// ---------------------------------------------------------------------------

/**
 * Bucket historical candidate edges by confidence and compute actual
 * validation rates per bucket. Honours the rolling window â€” only
 * candidates whose normalization_cycle falls within the window count.
 */
function computeCalibrationBuckets(
  candidates: ValidationResult[],
  validatedEdgeIds: Set<string>,
  cycleWindow: [number, number],
): CalibrationBucket[] {
  const [winStart, winEnd] = cycleWindow;
  const inWindow =
    winStart === 0 && winEnd === 0
      ? candidates
      : candidates.filter(
          (c) =>
            c.normalization_cycle >= winStart &&
            c.normalization_cycle <= winEnd,
        );

  const bucketRanges: [number, number][] = [
    [0.0, 0.3],
    [0.3, 0.4],
    [0.4, 0.5],
    [0.5, 0.6],
    [0.6, 0.7],
    [0.7, 0.8],
    [0.8, 0.9],
    [0.9, 1.01],
  ];

  return bucketRanges.map(([lo, hi]): CalibrationBucket => {
    const inBucket = inWindow.filter(
      (c) => c.confidence >= lo && c.confidence < hi,
    );
    const validated = inBucket.filter((c) => validatedEdgeIds.has(c.dream_id));
    return {
      confidence_range: [lo, hi >= 1.01 ? 1.0 : hi],
      total_edges: inBucket.length,
      eventually_validated: validated.length,
      validation_rate:
        inBucket.length > 0
          ? Math.round((validated.length / inBucket.length) * 1000) / 1000
          : 0,
    };
  });
}

/**
 * Generate threshold recommendations from calibration buckets, comparing
 * against the *effective* promotion config (policy + live overrides).
 */
function computeThresholdRecommendations(
  buckets: CalibrationBucket[],
  currentConfig: PromotionConfig,
): ThresholdRecommendation[] {
  const recommendations: ThresholdRecommendation[] = [];

  // Find the lowest confidence bucket with >=60% validation rate
  const highYieldBuckets = buckets.filter(
    (b) => b.total_edges >= 3 && b.validation_rate >= 0.6,
  );

  if (highYieldBuckets.length > 0) {
    const lowestHighYield = highYieldBuckets.sort(
      (a, b) => a.confidence_range[0] - b.confidence_range[0],
    )[0];
    const suggestedConfidence = lowestHighYield.confidence_range[0];

    if (suggestedConfidence < currentConfig.promotion_confidence - 0.02) {
      const clamped = Math.max(
        GUARDS.promotion_confidence.min,
        Math.min(GUARDS.promotion_confidence.max, suggestedConfidence),
      );
      recommendations.push({
        parameter: "promotion_confidence",
        current_value: currentConfig.promotion_confidence,
        recommended_value: Math.round(clamped * 100) / 100,
        basis:
          `Edges at confidence ${lowestHighYield.confidence_range[0]}-${lowestHighYield.confidence_range[1]} ` +
          `validate at ${(lowestHighYield.validation_rate * 100).toFixed(0)}% rate ` +
          `(${lowestHighYield.total_edges} edges in window). Lowering threshold would promote more genuine connections.`,
        confidence: Math.min(lowestHighYield.validation_rate, 0.9),
      });
    }
  }

  // Check if high-confidence edges unexpectedly fail
  const highConfBuckets = buckets.filter(
    (b) =>
      b.confidence_range[0] >= 0.7 &&
      b.total_edges >= 3 &&
      b.validation_rate < 0.5,
  );
  if (highConfBuckets.length > 0) {
    const worst = highConfBuckets.sort(
      (a, b) => a.validation_rate - b.validation_rate,
    )[0];
    const suggestedConfidence = worst.confidence_range[1];
    const clamped = Math.max(
      GUARDS.promotion_confidence.min,
      Math.min(GUARDS.promotion_confidence.max, suggestedConfidence),
    );
    if (clamped > currentConfig.promotion_confidence + 0.02) {
      recommendations.push({
        parameter: "promotion_confidence",
        current_value: currentConfig.promotion_confidence,
        recommended_value: Math.round(clamped * 100) / 100,
        basis:
          `High-confidence edges (${worst.confidence_range[0]}-${worst.confidence_range[1]}) ` +
          `validate at only ${(worst.validation_rate * 100).toFixed(0)}% rate. ` +
          `Raising threshold would reduce false promotions.`,
        confidence: 0.7,
      });
    }
  }

  return recommendations;
}

// ---------------------------------------------------------------------------
// Domain Decay Profiles
// ---------------------------------------------------------------------------

/**
 * Compute per-domain optimal decay rates from tension history. Resolution
 * time uses the timestamp delta (ms) converted to an approximate cycle
 * count via a default cadence assumption â€” better than the previous
 * `initialTtl - r.original.ttl` arithmetic, which always evaluated to 0
 * because TTL is reset on resolution.
 */
function computeDomainDecayProfiles(
  activeTensions: TensionSignal[],
  resolvedTensions: ResolvedTension[],
): DomainDecayProfile[] {
  const domains = new Set<TensionDomain>();
  for (const t of activeTensions) domains.add(t.domain);
  for (const r of resolvedTensions) domains.add(r.original.domain);

  // Estimate one cycle â‰ˆ 60 seconds. This is intentionally rough; the
  // result is only used to suggest TTL multipliers, not to gate behavior.
  const MS_PER_CYCLE = 60_000;
  const initialTtl = DEFAULT_TENSION_CONFIG.default_tension_ttl;

  return [...domains].map((domain): DomainDecayProfile => {
    const domainResolved = resolvedTensions.filter(
      (r) => r.original.domain === domain,
    );

    const resolutionCycles = domainResolved
      .map((r) => {
        const startMs = new Date(r.original.first_seen).getTime();
        const endMs = new Date(r.resolved_at).getTime();
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
        return Math.max(0, (endMs - startMs) / MS_PER_CYCLE);
      })
      .filter((v): v is number => v !== null);

    const avgResolution =
      resolutionCycles.length > 0
        ? resolutionCycles.reduce((a, b) => a + b, 0) /
          resolutionCycles.length
        : initialTtl;

    const falsePositives = domainResolved.filter(
      (r) => r.resolution_type === "false_positive",
    ).length;
    const fpRate =
      domainResolved.length > 0
        ? falsePositives / domainResolved.length
        : 0;

    const recommendedTtl = Math.round(
      Math.max(
        DECAY_GUARDS.ttl.min,
        Math.min(DECAY_GUARDS.ttl.max, avgResolution * 1.5),
      ),
    );

    const recommendedDecay =
      fpRate > 0.5
        ? Math.min(
            DECAY_GUARDS.urgency_decay.max,
            DEFAULT_TENSION_CONFIG.tension_urgency_decay * 1.5,
          )
        : fpRate < 0.2
          ? Math.max(
              DECAY_GUARDS.urgency_decay.min,
              DEFAULT_TENSION_CONFIG.tension_urgency_decay * 0.7,
            )
          : DEFAULT_TENSION_CONFIG.tension_urgency_decay;

    return {
      domain,
      avg_resolution_cycles: Math.round(avgResolution * 10) / 10,
      false_positive_rate: Math.round(fpRate * 1000) / 1000,
      recommended_ttl: recommendedTtl,
      recommended_urgency_decay: Math.round(recommendedDecay * 10000) / 10000,
      current_ttl: initialTtl,
      current_decay: DEFAULT_TENSION_CONFIG.tension_urgency_decay,
    };
  });
}

// ---------------------------------------------------------------------------
// Meta Log I/O
// ---------------------------------------------------------------------------

function emptyMetaLog(): MetaLogFile {
  return {
    metadata: {
      description: "Metacognitive Analysis Log â€” self-tuning audit trail.",
      schema_version: "1.1.0",
      total_entries: 0,
      last_analysis: null,
    },
    entries: [],
  };
}

async function loadMetaLog(): Promise<MetaLogFile> {
  try {
    if (!existsSync(metaLogPath())) return emptyMetaLog();
    const raw = await readFile(metaLogPath(), "utf-8");
    const p = JSON.parse(raw);
    const e = emptyMetaLog();
    return {
      metadata: { ...e.metadata, ...(p.metadata && typeof p.metadata === "object" ? p.metadata : {}) },
      entries: Array.isArray(p.entries) ? p.entries : [],
    };
  } catch {
    return emptyMetaLog();
  }
}

async function saveMetaLog(log: MetaLogFile): Promise<void> {
  log.metadata.total_entries = log.entries.length;
  log.metadata.schema_version = "1.1.0";
  log.metadata.last_analysis =
    log.entries.length > 0
      ? log.entries[log.entries.length - 1].timestamp
      : null;
  await atomicWriteFile(metaLogPath(), JSON.stringify(log, null, 2));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run metacognitive analysis and optionally auto-apply recommendations.
 *
 * @param windowSize Number of recent dream cycles to analyze (default 50).
 * @param autoApply  If true, apply recommended thresholds via in-memory
 *                   engine overrides. Overrides reset on restart.
 * @returns The analysis entry (also appended to meta_log.json).
 */
export async function runMetacognitiveAnalysis(
  windowSize: number = 50,
  autoApply: boolean = false,
): Promise<MetaLogEntry> {
  logger.info(
    `Metacognitive analysis: window=${windowSize}, auto_apply=${autoApply}`,
  );

  const [history, candidatesFile, validatedFile, tensionFile, dreamGraph] =
    await Promise.all([
      engine.loadDreamHistory(),
      engine.loadCandidateEdges(),
      engine.loadValidatedEdges(),
      engine.loadTensions(),
      engine.loadDreamGraph(),
    ]);

  const sessions = history.sessions.slice(-windowSize);
  const cycleWindow: [number, number] =
    sessions.length > 0
      ? [sessions[0].cycle_number, sessions[sessions.length - 1].cycle_number]
      : [0, 0];

  const candidates = candidatesFile.results;
  const validatedEdges = validatedFile.edges;
  const validatedEdgeIds = new Set(validatedEdges.map((e) => e.id));
  const activeTensions = tensionFile.signals;
  const resolvedTensions = tensionFile.resolved_tensions ?? [];

  const strategyLookup = buildStrategyLookup(
    candidates,
    validatedEdges,
    dreamGraph.edges,
  );

  // Snapshot the effective config at analysis-time (drives recommendations
  // and lands in the meta-log entry for transparency).
  const effectiveConfig = await engine.getEffectivePromotionConfig();

  // 1. Strategy performance
  const strategyMetrics = computeStrategyMetrics(
    sessions,
    candidates,
    validatedEdges,
    resolvedTensions,
    strategyLookup,
  );

  // 2. Promotion calibration
  const calibrationBuckets = computeCalibrationBuckets(
    candidates,
    validatedEdgeIds,
    cycleWindow,
  );
  const thresholdRecommendations = computeThresholdRecommendations(
    calibrationBuckets,
    effectiveConfig,
  );

  // 3. Domain decay profiles
  const domainDecayProfiles = computeDomainDecayProfiles(
    activeTensions,
    resolvedTensions,
  );

  // Auto-apply
  const actionsTaken: MetaLogEntry["actions_taken"] = [];
  if (autoApply) {
    for (const rec of thresholdRecommendations) {
      if (rec.confidence < AUTO_APPLY_MIN_CONFIDENCE) continue;
      const guard = GUARDS[rec.parameter];
      if (!guard) continue;
      const clamped = Math.max(
        guard.min,
        Math.min(guard.max, rec.recommended_value),
      );
      const before = effectiveConfig[rec.parameter];
      // Avoid no-op writes
      if (Math.abs((before as number) - clamped) < 1e-6) continue;

      try {
        engine.setPromotionOverride(
          rec.parameter,
          clamped as PromotionConfig[typeof rec.parameter],
        );
        actionsTaken.push({
          type: "threshold_adjustment",
          parameter: rec.parameter,
          old_value: before as number,
          new_value: clamped,
          basis: rec.basis,
        });
        logger.info(
          `Metacognitive auto-tune: ${rec.parameter} ${before} -> ${clamped} (${rec.basis})`,
        );
      } catch (err) {
        logger.warn(
          `Metacognitive auto-tune failed for ${rec.parameter}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  // Overall health verdict
  const measuredStrategies = strategyMetrics.filter(
    (m) => m.total_generated > 0,
  );
  const avgPrecision =
    measuredStrategies.length > 0
      ? measuredStrategies.reduce((s, m) => s + m.precision, 0) /
        measuredStrategies.length
      : 0;
  const zeroYieldStrategies = strategyMetrics.filter(
    (m) => m.consecutive_zero_yield >= 3,
  ).length;

  let overallHealth: string;
  if (sessions.length < 5) {
    overallHealth =
      "insufficient data â€” need more dream cycles for meaningful analysis";
  } else if (avgPrecision >= 0.4 && zeroYieldStrategies <= 3) {
    overallHealth = "healthy â€” strategies are producing valuable connections";
  } else if (avgPrecision >= 0.2) {
    overallHealth =
      "moderate â€” some strategies underperforming, consider rebalancing";
  } else {
    overallHealth =
      "attention needed â€” low overall precision, review promotion thresholds";
  }

  const entry: MetaLogEntry = {
    id: `meta_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    cycle_window: cycleWindow,
    window_size: sessions.length,
    effective_config: effectiveConfig,
    strategy_metrics: strategyMetrics,
    threshold_recommendations: thresholdRecommendations,
    domain_decay_profiles: domainDecayProfiles,
    calibration_buckets: calibrationBuckets,
    actions_taken: actionsTaken,
    overall_health: overallHealth,
  };

  const log = await loadMetaLog();
  log.entries.push(entry);
  if (log.entries.length > 100) {
    log.entries = log.entries.slice(-100);
  }
  await saveMetaLog(log);

  logger.info(
    `Metacognitive analysis complete: ${strategyMetrics.length} strategies, ` +
      `${thresholdRecommendations.length} recommendations, ` +
      `${actionsTaken.length} actions taken`,
  );

  return entry;
}

/** Load the full meta log file for resource serving. */
export async function getMetaLog(): Promise<MetaLogFile> {
  return loadMetaLog();
}
