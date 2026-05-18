/**
 * DreamGraph Cognitive Engine — State machine and persistence.
 *
 * The engine manages the four cognitive states (AWAKE, REM, NORMALIZING, NIGHTMARE)
 * and enforces strict boundaries between them. It handles state transitions,
 * interruption protocol, dream graph I/O, and state introspection.
 *
 * State machine transitions:
 *   AWAKE → REM → NORMALIZING → AWAKE  (normal dream cycle)
 *   AWAKE → NIGHTMARE → AWAKE           (adversarial scan)
 *
 * Enhanced with:
 * - Dream decay: edges/nodes lose confidence and TTL each cycle
 * - Tension tracking: records what the system struggles with
 * - Dream history: audit trail of every cycle
 * - Strict promotion gate reporting
 *
 * Safety guarantees:
 * - FACT GRAPH is never modified by the cognitive system
 * - REM output is isolated to dream_graph.json
 * - Only normalization can promote edges to validated_edges.json
 * - Interrupted REM cycles quarantine in-progress data
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as appConfig } from "../config/config.js";
import { logger } from "../utils/logger.js";
import { dataPath } from "../utils/paths.js";
import { loadJsonArray, invalidateCache } from "../utils/cache.js";
import { loadIndexableUIElements } from "../utils/ui-index.js";
import { getActiveCognitiveTuning } from "../instance/index.js";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { withFileLock } from "../utils/mutex.js";
import { graphEventBus } from "../graph/events.js";
import { getLlmReadinessStatus } from "./llm-readiness.js";
import {
  buildTensionPlanContext,
  proposeResolutionCandidateFromPlan,
  type TensionPlanContext,
} from "./intervention.js";
import { executeEnrichSeedData } from "../tools/enrich-seed-data.js";
import type {
  CognitiveStateName,
  CognitiveState,
  DreamGraphFile,
  CandidateEdgesFile,
  ValidatedEdgesFile,
  DreamNode,
  DreamEdge,
  ValidationResult,
  ValidatedEdge,
  DecayConfig,
  TensionSignal,
  TensionFile,
  TensionDomain,
  TensionResolutionType,
  TensionResolutionAuthority,
  TensionResolutionStrategy,
  TensionResolutionCandidate,
  ResolvedTension,
  TensionConfig,
  DreamHistoryEntry,
  DreamHistoryFile,
  PromotionConfig,
  BootstrapState,
  BootstrapExitReason,
  BootstrapStatus,
} from "./types.js";
import type { Feature, Workflow, DataModelEntity, ResourceIndex, IndexEntry } from "../types/index.js";
import { DEFAULT_DECAY, DEFAULT_PROMOTION, DEFAULT_TENSION_CONFIG } from "./types.js";

// ---------------------------------------------------------------------------
// Path resolution (lazy — resolved at call time for instance mode support)
// ---------------------------------------------------------------------------

const dreamGraphPath     = () => dataPath("dream_graph.json");
const candidateEdgesPath = () => dataPath("candidate_edges.json");
const validatedEdgesPath = () => dataPath("validated_edges.json");
const tensionPath        = () => dataPath("tension_log.json");
const historyPath        = () => dataPath("dream_history.json");

// ---------------------------------------------------------------------------
// Cognitive Engine (Singleton)
// ---------------------------------------------------------------------------

/**
 * Reinforcement memory entry — survives edge expiry so re-generated
 * duplicates inherit accumulated evidence instead of starting at zero.
 */
interface ReinforcementMemory {
  /** Canonical edge key (sorted from|to + base relation) */
  key: string;
  /** Accumulated reinforcement count from all prior incarnations */
  reinforcement_count: number;
  /** Best confidence ever recorded for this edge */
  peak_confidence: number;
  /** Cycle when this memory was last updated */
  last_cycle: number;
}

type CanonicalProvenanceKind = "source_backed" | "derived_hub" | "human_asserted";

interface CanonicalPromotionProvenance {
  sourceRepo: string;
  sourceFiles: string[];
  kind: CanonicalProvenanceKind;
  derivedFromNodeIds: string[];
}

interface ProvenanceCarrier {
  id?: string;
  source_repo?: unknown;
  source_files?: unknown;
  provenance_kind?: unknown;
  derived_from_node_ids?: unknown;
  human_asserted?: unknown;
  inspiration?: unknown;
}

interface SourceLessFactQuarantineResult {
  quarantined_nodes: number;
  quarantined_validated_edges: number;
  quarantined_candidate_results: number;
  quarantined_dream_nodes: number;
  quarantined_dream_edges: number;
  quarantined_active_tensions: number;
  quarantined_resolved_tensions: number;
  affected_node_ids: string[];
  quarantine_file: string;
  timestamp: string;
}

class CognitiveEngine {
  private state: CognitiveStateName = "awake";
  private lastStateChange: string = new Date().toISOString();
  private totalDreamCycles = 0;
  private totalNormalizationCycles = 0;
  private lastDreamCycle: string | null = null;
  private lastNormalization: string | null = null;
  private decayConfig: DecayConfig = { ...DEFAULT_DECAY };
  private tensionConfig: TensionConfig = { ...DEFAULT_TENSION_CONFIG };

  /**
   * In-memory promotion-config overrides applied on top of the policy
   * profile's `cognitive_tuning`. Set by metacognitive auto-tuning. Resets
   * on restart by design — auto-tuning never persists to disk.
   */
  private promotionOverrides: Partial<PromotionConfig> = {};

  /**
   * Reinforcement memory — edge fingerprints survive expiry.
   * When an edge decays away, its reinforcement count and peak confidence
   * are stored here. When the same edge is re-generated, it inherits this
   * history so evidence actually accumulates across incarnations.
   * Memory entries expire after 30 cycles of inactivity.
   */
  private reinforcementMemory = new Map<string, ReinforcementMemory>();
  private static readonly MEMORY_TTL_CYCLES = Number(process.env.DG_MEMORY_TTL_CYCLES) || 30;

  // -------------------------------------------------------------------------
  // Cold-start bootstrap state — ADR-096
  // -------------------------------------------------------------------------
  // On a fresh instance the strict promotion gate is unreachable because
  // entity-existence is required as evidence but no entities exist yet.
  // Cold-start mode relaxes the gate until the dual exit condition trips:
  //   (A) entity-count threshold reached
  //   (B) bootstrap window elapsed (cycles or wall-clock)
  // exit_reason MUST be populated on every exit (ADR-096 guard rail).
  // -------------------------------------------------------------------------
  private bootstrapState: BootstrapState = "cold_start";
  private bootstrapStartedAt: string | null = null;
  private bootstrapExitedAt: string | null = null;
  private bootstrapExitReason: BootstrapExitReason | null = null;
  /** Dream cycle counter snapshot at the moment cold-start began. */
  private bootstrapStartCycle = 0;

  /**
   * Tunable cold-start floors. Overridable via env for testing/telemetry tuning.
   * ADR-096 guard rails: relaxed floor MUST NOT exceed 0.50 confidence;
   * window MUST NOT exceed 24h.
   */
  private static readonly BOOTSTRAP_MIN_ENTITIES =
    Number(process.env.DG_BOOTSTRAP_MIN_ENTITIES) || 50;
  private static readonly BOOTSTRAP_MIN_VALIDATED_EDGES =
    Number(process.env.DG_BOOTSTRAP_MIN_VALIDATED_EDGES) || 10;
  private static readonly BOOTSTRAP_MAX_CYCLES =
    Number(process.env.DG_BOOTSTRAP_MAX_CYCLES) || 20;
  private static readonly BOOTSTRAP_MAX_HOURS = Math.min(
    Number(process.env.DG_BOOTSTRAP_MAX_HOURS) || 24,
    24 // ADR-096 guard rail: never exceed 24h
  );
  /** ADR-096 guard rail: relaxed confidence floor MUST NOT exceed 0.50. */
  private static readonly BOOTSTRAP_RELAXED_CONFIDENCE = Math.min(
    Number(process.env.DG_BOOTSTRAP_RELAXED_CONFIDENCE) || 0.5,
    0.5
  );

  /**
   * Hydrate counters from the persisted dream graph.
   * Called once at startup so the engine doesn't restart counting from 0
   * after a server restart.
   */
  async hydrate(): Promise<void> {
    try {
      const graph = await this.loadDreamGraph();
      if (graph.metadata.total_cycles > 0) {
        this.totalDreamCycles = graph.metadata.total_cycles;
        this.lastDreamCycle = graph.metadata.last_dream_cycle;
      }
      if (graph.metadata.total_normalization_cycles > 0) {
        this.totalNormalizationCycles = graph.metadata.total_normalization_cycles;
        this.lastNormalization = graph.metadata.last_normalization;
      }
      // ADR-096: hydrate cold-start bootstrap state.
      // Default is "cold_start" if metadata is silent (i.e. instance pre-dates this field).
      this.bootstrapState = graph.metadata.bootstrap_state ?? "cold_start";
      this.bootstrapStartedAt = graph.metadata.bootstrap_started_at ?? null;
      this.bootstrapExitedAt = graph.metadata.bootstrap_exited_at ?? null;
      this.bootstrapExitReason = graph.metadata.bootstrap_exit_reason ?? null;
      // If a mature instance is being upgraded (has cycles + validated edges already),
      // graduate it on hydrate so it doesn't unnecessarily re-enter cold-start.
      if (
        this.bootstrapState === "cold_start" &&
        this.bootstrapStartedAt === null &&
        this.totalNormalizationCycles >= CognitiveEngine.BOOTSTRAP_MAX_CYCLES
      ) {
        this.bootstrapState = "graduated";
        this.bootstrapExitedAt = new Date().toISOString();
        this.bootstrapExitReason = "window";
        logger.info(
          `Cognitive hydrate: graduating mature instance (${this.totalNormalizationCycles} normalization cycles) out of cold-start (exit_reason=window)`
        );
      }
      if (this.totalDreamCycles > 0 || this.totalNormalizationCycles > 0) {
        logger.info(
          `Cognitive engine hydrated: ${this.totalDreamCycles} dream cycles, ${this.totalNormalizationCycles} normalization cycles, bootstrap=${this.bootstrapState}`
        );
      }
    } catch (err) {
      // Fresh start — no graph yet (file missing is OK, parse error is not)
      if (existsSync(dreamGraphPath())) {
        logger.warn(`Cognitive hydrate: dream_graph.json exists but failed to parse — possible corruption: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // State Machine
  // -------------------------------------------------------------------------

  /** Get current cognitive state name */
  getState(): CognitiveStateName {
    return this.state;
  }

  /** Assert that the engine is in a specific state */
  assertState(expected: CognitiveStateName, operation: string): void {
    if (this.state !== expected) {
      throw new Error(
        `COGNITIVE VIOLATION: "${operation}" requires state "${expected}" but current state is "${this.state}". ` +
          `State boundaries must be respected.`
      );
    }
  }

  /** Transition: AWAKE → REM */
  enterRem(): void {
    this.assertState("awake", "enterRem");
    this.state = "rem";
    this.lastStateChange = new Date().toISOString();
    logger.info("Cognitive state: AWAKE → REM (dreaming begins)");
  }

  /**
   * Apply cognitive tuning from the active policy profile.
   * Must be called after state transitions to sync decay/promotion config.
   * Safe to call multiple times — idempotent.
   */
  async applyCognitiveTuning(): Promise<void> {
    const tuning = await getActiveCognitiveTuning();
    this.decayConfig = {
      ttl: tuning.decay_ttl,
      decay_rate: tuning.decay_rate,
    };
    logger.debug(
      `Cognitive tuning applied: ttl=${tuning.decay_ttl}, decay_rate=${tuning.decay_rate}, ` +
      `promotion_confidence=${tuning.promotion_confidence}, evidence_count=${tuning.promotion_evidence_count}`
    );
  }

  /** Transition: REM → NORMALIZING */
  enterNormalizing(): void {
    this.assertState("rem", "enterNormalizing");
    this.state = "normalizing";
    this.lastStateChange = new Date().toISOString();
    logger.info("Cognitive state: REM → NORMALIZING (validation begins)");
  }

  /** Transition: NORMALIZING → AWAKE (natural wake) */
  wake(): void {
    this.assertState("normalizing", "wake");
    this.state = "awake";
    this.lastStateChange = new Date().toISOString();
    logger.info("Cognitive state: NORMALIZING → AWAKE (natural wake cycle complete)");
  }

  /** Transition: AWAKE → NIGHTMARE (adversarial dreaming) */
  enterNightmare(): void {
    this.assertState("awake", "enterNightmare");
    this.state = "nightmare";
    this.lastStateChange = new Date().toISOString();
    logger.info("Cognitive state: AWAKE → NIGHTMARE (adversarial scan begins)");
  }

  /** Transition: NIGHTMARE → AWAKE (adversarial scan complete) */
  wakeFromNightmare(): void {
    this.assertState("nightmare", "wakeFromNightmare");
    this.state = "awake";
    this.lastStateChange = new Date().toISOString();
    logger.info("Cognitive state: NIGHTMARE → AWAKE (adversarial scan complete)");
  }

  /** Transition: AWAKE → LUCID (interactive exploration) */
  enterLucid(): void {
    this.assertState("awake", "enterLucid");
    this.state = "lucid";
    this.lastStateChange = new Date().toISOString();
    logger.info("Cognitive state: AWAKE → LUCID (interactive exploration begins)");
  }

  /** Transition: LUCID → AWAKE (exploration complete) */
  wakeFromLucid(): void {
    this.assertState("lucid", "wakeFromLucid");
    this.state = "awake";
    this.lastStateChange = new Date().toISOString();
    logger.info("Cognitive state: LUCID → AWAKE (interactive exploration complete)");
  }

  /**
   * INTERRUPTION HANDLER
   *
   * If external input arrives during REM:
   * 1. Immediately stop REM processing
   * 2. Quarantine in-progress dream data
   * 3. Fast-normalize: mark unfinished items as interrupted
   * 4. Reset to AWAKE
   */
  async interrupt(): Promise<void> {
    if (this.state === "awake") return; // Already awake, nothing to do

    const previousState = this.state;
    logger.warn(`INTERRUPTION: Forcing wake from "${previousState}" state`);

    // Quarantine any in-progress dream data
    if (previousState === "rem" || previousState === "nightmare" || previousState === "lucid") {
      await this.quarantineDreams();
    }

    // Force to awake
    this.state = "awake";
    this.lastStateChange = new Date().toISOString();
    logger.info(`Cognitive state: ${previousState} → AWAKE (interrupted)`);
  }

  /** Mark all non-completed dream items as interrupted */
  private async quarantineDreams(): Promise<void> {
    try {
      const dreamGraph = await this.loadDreamGraph();
      let quarantined = 0;

      for (const edge of dreamGraph.edges) {
        if (edge.dream_cycle === this.totalDreamCycles && !edge.interrupted) {
          edge.interrupted = true;
          quarantined++;
        }
      }

      for (const node of dreamGraph.nodes) {
        if (node.dream_cycle === this.totalDreamCycles && !node.interrupted) {
          node.interrupted = true;
          quarantined++;
        }
      }

      if (quarantined > 0) {
        await this.saveDreamGraph(dreamGraph);
        logger.warn(`Quarantined ${quarantined} in-progress dream items`);
      }
    } catch {
      logger.error("Failed to quarantine dreams during interruption");
    }
  }

  // -------------------------------------------------------------------------
  // Cycle Tracking
  // -------------------------------------------------------------------------

  /** Increment dream cycle counter and return the new cycle number */
  nextDreamCycle(): number {
    this.totalDreamCycles++;
    this.lastDreamCycle = new Date().toISOString();
    return this.totalDreamCycles;
  }

  /** Increment normalization cycle counter */
  nextNormalizationCycle(): number {
    this.totalNormalizationCycles++;
    this.lastNormalization = new Date().toISOString();
    return this.totalNormalizationCycles;
  }

  /** Get current dream cycle number (without incrementing) */
  getCurrentDreamCycle(): number {
    return this.totalDreamCycles;
  }

  /** Get current normalization cycle number */
  getCurrentNormalizationCycle(): number {
    return this.totalNormalizationCycles;
  }

  // -------------------------------------------------------------------------
  // Cold-start bootstrap API — ADR-096
  // -------------------------------------------------------------------------

  /** Whether the engine is currently in cold-start bootstrap mode. */
  isColdStart(): boolean {
    return this.bootstrapState === "cold_start";
  }

  /**
   * Stamp the cold-start start timestamp the first time normalization runs
   * during cold-start. Idempotent: subsequent calls are no-ops.
   */
  markBootstrapStart(): void {
    if (this.bootstrapState !== "cold_start") return;
    if (this.bootstrapStartedAt !== null) return;
    this.bootstrapStartedAt = new Date().toISOString();
    this.bootstrapStartCycle = this.totalNormalizationCycles;
    logger.info(
      `Cold-start bootstrap started at ${this.bootstrapStartedAt} (cycle ${this.bootstrapStartCycle}); ` +
        `relaxed promotion gate active until exit (entities≥${CognitiveEngine.BOOTSTRAP_MIN_ENTITIES} & validated_edges≥${CognitiveEngine.BOOTSTRAP_MIN_VALIDATED_EDGES}, OR ${CognitiveEngine.BOOTSTRAP_MAX_CYCLES} cycles, OR ${CognitiveEngine.BOOTSTRAP_MAX_HOURS}h, whichever first)`
    );
  }

  /**
   * Evaluate the dual-condition exit (ADR-096). Pure function — does not
   * mutate engine state. Returns null if cold-start should continue, or
   * the exit reason if it should graduate.
   *
   * Dual condition (whichever fires first):
   *   (A) entity-count threshold reached
   *   (B) bootstrap window elapsed (cycles or wall-clock)
   */
  evaluateBootstrapExit(
    entityCount: number,
    validatedEdgeCount: number
  ): BootstrapExitReason | null {
    if (this.bootstrapState !== "cold_start") return null;
    // Defensive: if start was never marked, don't graduate yet.
    if (this.bootstrapStartedAt === null) return null;

    // Condition A — quality-based (entity-count + validated edges).
    if (
      entityCount >= CognitiveEngine.BOOTSTRAP_MIN_ENTITIES &&
      validatedEdgeCount >= CognitiveEngine.BOOTSTRAP_MIN_VALIDATED_EDGES
    ) {
      return "size";
    }

    // Condition B — window-based (cycles OR wall-clock).
    const cyclesInBootstrap = this.totalNormalizationCycles - this.bootstrapStartCycle;
    if (cyclesInBootstrap >= CognitiveEngine.BOOTSTRAP_MAX_CYCLES) return "window";
    const startedMs = Date.parse(this.bootstrapStartedAt);
    if (Number.isFinite(startedMs)) {
      const ageHours = (Date.now() - startedMs) / 3_600_000;
      if (ageHours >= CognitiveEngine.BOOTSTRAP_MAX_HOURS) return "window";
    }
    return null;
  }

  /**
   * Graduate from cold-start bootstrap. Records the exit timestamp and
   * reason in engine state and persists via the next saveDreamGraph().
   * exit_reason MUST be populated (ADR-096 guard rail).
   */
  async graduateBootstrap(reason: BootstrapExitReason): Promise<void> {
    if (this.bootstrapState !== "cold_start") return;
    this.bootstrapState = "graduated";
    this.bootstrapExitedAt = new Date().toISOString();
    this.bootstrapExitReason = reason;
    const cyclesInBootstrap =
      this.totalNormalizationCycles - this.bootstrapStartCycle;
    logger.info(
      `Cold-start bootstrap exited at ${this.bootstrapExitedAt} (exit_reason=${reason}, cycles_in_bootstrap=${cyclesInBootstrap}); ` +
        `strict promotion gate now active`
    );
    // Persist immediately by rewriting the dream graph (saveDreamGraph syncs
    // bootstrap fields). Caller may also save shortly after — that's fine,
    // saveDreamGraph is idempotent.
    try {
      const graph = await this.loadDreamGraph();
      await this.saveDreamGraph(graph);
    } catch (err) {
      logger.warn(
        `graduateBootstrap: failed to persist exit (will retry on next save): ${err instanceof Error ? err.message : err}`
      );
    }
  }

  /** Build the bootstrap status surfaced via cognitive_status. */
  getBootstrapStatus(): BootstrapStatus {
    let ageSeconds: number | null = null;
    if (this.bootstrapStartedAt) {
      const startedMs = Date.parse(this.bootstrapStartedAt);
      const endedMs = this.bootstrapExitedAt
        ? Date.parse(this.bootstrapExitedAt)
        : Date.now();
      if (Number.isFinite(startedMs) && Number.isFinite(endedMs)) {
        ageSeconds = Math.max(0, Math.round((endedMs - startedMs) / 1000));
      }
    }
    return {
      state: this.bootstrapState,
      started_at: this.bootstrapStartedAt,
      exited_at: this.bootstrapExitedAt,
      exit_reason: this.bootstrapExitReason,
      age_seconds: ageSeconds,
      cycles_in_bootstrap:
        this.bootstrapStartedAt === null
          ? 0
          : this.totalNormalizationCycles - this.bootstrapStartCycle,
      thresholds: {
        min_entities: CognitiveEngine.BOOTSTRAP_MIN_ENTITIES,
        min_validated_edges: CognitiveEngine.BOOTSTRAP_MIN_VALIDATED_EDGES,
        max_cycles: CognitiveEngine.BOOTSTRAP_MAX_CYCLES,
        max_hours: CognitiveEngine.BOOTSTRAP_MAX_HOURS,
        relaxed_confidence_floor:
          CognitiveEngine.BOOTSTRAP_RELAXED_CONFIDENCE,
      },
    };
  }

  /** Relaxed confidence floor in effect during cold-start (ADR-096). */
  getBootstrapRelaxedConfidenceFloor(): number {
    return CognitiveEngine.BOOTSTRAP_RELAXED_CONFIDENCE;
  }

  /** Get current decay config */
  getDecayConfig(): DecayConfig {
    return { ...this.decayConfig };
  }

  /** Get current tension config */
  getTensionConfig(): TensionConfig {
    return { ...this.tensionConfig };
  }

  /**
   * Resolve the effective `PromotionConfig`: policy-profile tuning merged
   * with any in-memory overrides set by metacognitive auto-tuning.
   */
  async getEffectivePromotionConfig(): Promise<PromotionConfig> {
    const tuning = await getActiveCognitiveTuning();
    const base: PromotionConfig = {
      promotion_confidence: tuning.promotion_confidence,
      promotion_plausibility: tuning.promotion_plausibility,
      promotion_evidence: tuning.promotion_evidence,
      promotion_evidence_count: tuning.promotion_evidence_count,
      retention_plausibility: tuning.retention_plausibility,
      max_contradiction: tuning.max_contradiction,
    };
    return { ...base, ...this.promotionOverrides };
  }

  /**
   * Read the currently active overrides (shallow copy). Empty object means
   * the engine is running with pure policy-profile tuning.
   */
  getPromotionOverrides(): Partial<PromotionConfig> {
    return { ...this.promotionOverrides };
  }

  /**
   * Apply a single in-memory override to the active promotion config.
   * Used by metacognitive auto-tuning. Caller is expected to clamp to
   * safe guard rails before calling.
   */
  setPromotionOverride<K extends keyof PromotionConfig>(
    parameter: K,
    value: PromotionConfig[K],
  ): void {
    this.promotionOverrides[parameter] = value;
    logger.info(`Promotion override set: ${String(parameter)} = ${value}`);
  }

  /** Drop all in-memory promotion overrides. */
  clearPromotionOverrides(): void {
    this.promotionOverrides = {};
    logger.info("Promotion overrides cleared — reverting to policy-profile tuning");
  }

  // -------------------------------------------------------------------------
  // File I/O — Dream Graph
  // -------------------------------------------------------------------------

  async loadDreamGraph(): Promise<DreamGraphFile> {
    try {
      if (!existsSync(dreamGraphPath())) return this.emptyDreamGraphFile();
      const raw = await readFile(dreamGraphPath(), "utf-8");
      const p = JSON.parse(raw);
      const e = this.emptyDreamGraphFile();
      return {
        metadata: { ...e.metadata, ...(p.metadata && typeof p.metadata === "object" ? p.metadata : {}) },
        nodes: Array.isArray(p.nodes) ? p.nodes : [],
        edges: Array.isArray(p.edges) ? p.edges : [],
      };
    } catch (err) {
      logger.warn(
        `loadDreamGraph: failed to read/parse dream_graph.json — returning empty graph. ` +
        `Error: ${err instanceof Error ? err.message : err}`
      );
      return this.emptyDreamGraphFile();
    }
  }

  private emptyDreamGraphFile(): DreamGraphFile {
    return {
      metadata: {
        description: "Dream Graph — REM-generated speculative nodes and edges. UNTRUSTED.",
        schema_version: "1.0.0",
        last_dream_cycle: null,
        total_cycles: this.totalDreamCycles,
        last_normalization: null,
        total_normalization_cycles: this.totalNormalizationCycles,
        created_at: new Date().toISOString(),
        bootstrap_state: this.bootstrapState,
        bootstrap_started_at: this.bootstrapStartedAt,
        bootstrap_exited_at: this.bootstrapExitedAt,
        bootstrap_exit_reason: this.bootstrapExitReason,
      },
      nodes: [],
      edges: [],
    };
  }

  async saveDreamGraph(data: DreamGraphFile): Promise<void> {
    // Always sync both lifecycle counters into metadata before persisting
    data.metadata.total_cycles = this.totalDreamCycles;
    data.metadata.total_normalization_cycles = this.totalNormalizationCycles;
    if (this.lastNormalization) data.metadata.last_normalization = this.lastNormalization;
    // ADR-096: persist cold-start bootstrap state alongside cycle counters.
    data.metadata.bootstrap_state = this.bootstrapState;
    data.metadata.bootstrap_started_at = this.bootstrapStartedAt;
    data.metadata.bootstrap_exited_at = this.bootstrapExitedAt;
    data.metadata.bootstrap_exit_reason = this.bootstrapExitReason;
    await withFileLock("dream_graph.json", async () => {
      await atomicWriteFile(dreamGraphPath(), JSON.stringify(data, null, 2));
    });
    logger.debug("Dream graph saved to disk");
  }

  async appendDreamNodes(nodes: DreamNode[]): Promise<void> {
    this.assertState("rem", "appendDreamNodes");
    const graph = await this.loadDreamGraph();
    graph.nodes.push(...nodes);
    graph.metadata.last_dream_cycle = new Date().toISOString();
    graph.metadata.total_cycles = this.totalDreamCycles;
    await this.saveDreamGraph(graph);
  }

  async appendDreamEdges(edges: DreamEdge[]): Promise<void> {
    this.assertState("rem", "appendDreamEdges");
    const graph = await this.loadDreamGraph();
    graph.edges.push(...edges);
    graph.metadata.last_dream_cycle = new Date().toISOString();
    graph.metadata.total_cycles = this.totalDreamCycles;
    await this.saveDreamGraph(graph);
  }

  // -------------------------------------------------------------------------
  // Dream Decay — edges/nodes lose confidence each cycle
  // -------------------------------------------------------------------------

  /**
   * Apply decay to all dream edges and nodes.
   * - Confidence reduced by decay_rate
   * - TTL decremented by 1
   * - Items with TTL <= 0 OR confidence <= 0 are removed (expired)
   * - **Expired edges are saved to reinforcement memory** so their
   *   evidence survives for future re-generation.
   *
   * Returns { decayedEdges, decayedNodes } = count of removed items.
   * Must be called during REM, before new dreams are appended.
   */
  async applyDecay(): Promise<{ decayedEdges: number; decayedNodes: number }> {
    this.assertState("rem", "applyDecay");
    const graph = await this.loadDreamGraph();
    const currentCycle = this.totalDreamCycles;

    let decayedEdges = 0;
    let decayedNodes = 0;

    // Build tension relevance set: entities mentioned in active tensions.
    // Edges/nodes involving these entities decay at half rate — they're
    // actively relevant and shouldn't expire before the system resolves them.
    const tensionEntityIds = new Set<string>();
    try {
      const tensions = await this.getUnresolvedTensions();
      for (const t of tensions) {
        for (const eid of t.entities) tensionEntityIds.add(eid);
      }
    } catch (err) {
      logger.debug(`applyDecay: could not load tensions for decay protection: ${err instanceof Error ? err.message : err}`);
    }

    // Decay edges
    const survivingEdges: DreamEdge[] = [];
    for (const edge of graph.edges) {
      // Skip edges reinforced this cycle (they just got refreshed)
      if (edge.last_reinforced_cycle === currentCycle) {
        survivingEdges.push(edge);
        continue;
      }

      // Tension-aware decay: halve rate for edges involving tension entities
      const tensionRelevant = tensionEntityIds.has(edge.from) || tensionEntityIds.has(edge.to);
      // Rejected-edge fast decay: 2x rate, 2x ttl drain — overrides tension protection
      // so normalizer-rejected hypotheses can actually expire instead of being
      // re-reinforced into permanence by deterministic strategies.
      const isRejected = edge.status === "rejected";
      const baseDecay = edge.decay_rate ?? this.decayConfig.decay_rate;
      const decayRate = isRejected
        ? baseDecay * 2
        : tensionRelevant
          ? baseDecay * 0.5
          : baseDecay;
      const ttlDecrement = isRejected ? 2 : tensionRelevant ? 0.5 : 1;

      // Apply decay
      const newTtl = (edge.ttl ?? this.decayConfig.ttl) - ttlDecrement;
      const newConfidence = edge.confidence - decayRate;

      if (newTtl <= 0 || newConfidence <= 0) {
        // SAVE TO REINFORCEMENT MEMORY before expiring
        const key = normalizeEdgeKey(edge);
        const existing = this.reinforcementMemory.get(key);
        const prevCount = existing?.reinforcement_count ?? 0;
        const prevPeak = existing?.peak_confidence ?? 0;
        this.reinforcementMemory.set(key, {
          key,
          reinforcement_count: prevCount + (edge.reinforcement_count ?? 0) + 1,
          peak_confidence: Math.max(prevPeak, edge.confidence + (edge.decay_rate ?? this.decayConfig.decay_rate)),
          last_cycle: currentCycle,
        });

        decayedEdges++;
        logger.debug(`Dream edge expired: ${edge.id} (ttl=${newTtl}, conf=${newConfidence.toFixed(2)}) — saved to reinforcement memory (count=${prevCount + (edge.reinforcement_count ?? 0) + 1})`);
        continue;
      }

      edge.ttl = newTtl;
      edge.confidence = Math.round(newConfidence * 100) / 100;
      survivingEdges.push(edge);
    }

    // Decay nodes
    const survivingNodes: DreamNode[] = [];
    for (const node of graph.nodes) {
      if (node.last_reinforced_cycle === currentCycle) {
        survivingNodes.push(node);
        continue;
      }

      // Tension-aware decay: halve rate for nodes related to tension entities
      const nodeTensionRelevant = node.inspiration.some(id => tensionEntityIds.has(id));
      const nodeDecayRate = nodeTensionRelevant
        ? (node.decay_rate ?? this.decayConfig.decay_rate) * 0.5
        : (node.decay_rate ?? this.decayConfig.decay_rate);
      const nodeTtlDecrement = nodeTensionRelevant ? 0.5 : 1;

      const newTtl = (node.ttl ?? this.decayConfig.ttl) - nodeTtlDecrement;
      const newConfidence = node.confidence - nodeDecayRate;

      if (newTtl <= 0 || newConfidence <= 0) {
        decayedNodes++;
        logger.debug(`Dream node expired: ${node.id} (ttl=${newTtl}, conf=${newConfidence.toFixed(2)})`);
        continue;
      }

      node.ttl = newTtl;
      node.confidence = Math.round(newConfidence * 100) / 100;
      survivingNodes.push(node);
    }

    graph.edges = survivingEdges;
    graph.nodes = survivingNodes;
    await this.saveDreamGraph(graph);

    // Evict stale reinforcement memory entries (older than MEMORY_TTL_CYCLES)
    for (const [key, mem] of this.reinforcementMemory) {
      if (currentCycle - mem.last_cycle > CognitiveEngine.MEMORY_TTL_CYCLES) {
        this.reinforcementMemory.delete(key);
      }
    }

    if (decayedEdges > 0 || decayedNodes > 0) {
      logger.info(
        `Decay pass: removed ${decayedEdges} edges, ${decayedNodes} nodes ` +
        `(reinforcement memory: ${this.reinforcementMemory.size} entries)`
      );
    }

    return { decayedEdges, decayedNodes };
  }

  // -------------------------------------------------------------------------
  // Duplicate Suppression — merge similar edges by reinforcing existing
  // -------------------------------------------------------------------------

  /**
   * Check for a similar existing edge and reinforce it instead of appending.
   * Similarity: same from/to (either direction) AND same relation prefix.
   *
   * **Enhanced**: New edges that match a reinforcement memory entry
   * inherit the accumulated reinforcement count and get a confidence
   * boost — evidence finally survives across edge incarnations.
   *
   * Returns the list of truly new edges (not duplicates).
   * Duplicates get their existing counterpart reinforced.
   */
  async deduplicateAndAppendEdges(newEdges: DreamEdge[]): Promise<{ appended: DreamEdge[]; merged: number }> {
    this.assertState("rem", "deduplicateAndAppendEdges");
    const graph = await this.loadDreamGraph();
    const currentCycle = this.totalDreamCycles;

    // Build lookup of existing edges by normalized key
    const existingByKey = new Map<string, DreamEdge>();
    for (const edge of graph.edges) {
      const key = normalizeEdgeKey(edge);
      existingByKey.set(key, edge);
    }

    const trulyNew: DreamEdge[] = [];
    let mergeCount = 0;
    let memoryInherited = 0;

    for (const candidate of newEdges) {
      const key = normalizeEdgeKey(candidate);
      const existing = existingByKey.get(key);

      if (existing) {
        // REJECTED edges must NEVER be reinforced. Deterministic strategies
        // (symmetry_completion, gap_detection, causal_replay, …) re-derive the
        // same edge every cycle; without this guard, +0.12 reinforcement bumps
        // outpace the −0.05 decay and saturate confidence at 1.0 even though
        // the normalizer already judged the edge unsupported. Drop the duplicate
        // silently — the existing rejected edge will continue to decay.
        if (existing.status === "rejected") {
          mergeCount++;
          logger.debug(
            `Duplicate suppressed (rejected, no reinforcement): "${candidate.id}" → "${existing.id}" ` +
              `(conf=${existing.confidence}, reinf_count=${existing.reinforcement_count ?? 0})`
          );
          continue;
        }

        // Diminishing-returns reinforcement curve. Same-edge re-derivation
        // contributes proportionally less the more often it has already been
        // counted, so confidence asymptotes well below 1.0 unless distinct
        // evidence keeps arriving. Formula: bump = base * (1 / (1 + n * 0.1))
        // → after 10 reinforcements the per-merge boost is halved; after 40
        // it's roughly 1/5th of the original.
        const priorCount = existing.reinforcement_count ?? 0;
        const dampening = 1 / (1 + priorCount * 0.1);
        const bump = candidate.confidence * 0.3 * dampening;
        existing.confidence = Math.min(
          Math.round((existing.confidence + bump) * 100) / 100,
          1.0
        );
        existing.ttl = this.decayConfig.ttl; // Reset TTL
        existing.reinforcement_count = priorCount + 1;
        existing.last_reinforced_cycle = currentCycle;
        mergeCount++;
        logger.debug(
          `Duplicate suppressed: "${candidate.id}" merged into "${existing.id}" ` +
            `(reinforcement #${existing.reinforcement_count}, +${bump.toFixed(3)}, conf=${existing.confidence})`
        );
      } else {
        // CHECK REINFORCEMENT MEMORY — inherit evidence from expired incarnations
        const memory = this.reinforcementMemory.get(key);
        if (memory) {
          candidate.reinforcement_count = memory.reinforcement_count;
          candidate.last_reinforced_cycle = currentCycle;
          // Confidence boost: base + 5% per remembered reinforcement (capped at +0.20)
          const memoryBoost = Math.min(memory.reinforcement_count * 0.05, 0.20);
          candidate.confidence = Math.min(
            Math.round((candidate.confidence + memoryBoost) * 100) / 100,
            1.0
          );
          // Give it extended TTL since it has proven persistent
          candidate.ttl = this.decayConfig.ttl + Math.min(memory.reinforcement_count, 4);
          memoryInherited++;
          logger.debug(
            `Memory inherited: "${candidate.id}" carries ${memory.reinforcement_count} prior reinforcements ` +
              `(conf boosted to ${candidate.confidence}, ttl=${candidate.ttl})`
          );
          // Clear the memory entry — it has been consumed
          this.reinforcementMemory.delete(key);
        }

        trulyNew.push(candidate);
        existingByKey.set(key, candidate); // Prevent duplicates within the same batch
      }
    }

    // Save reinforced existing edges + append truly new ones
    graph.edges = [...graph.edges.filter(e => !existingByKey.has(normalizeEdgeKey(e)) || graph.edges.includes(e))];
    // Actually simpler: we mutated the existing edges in-place, just append new ones
    graph.edges.push(...trulyNew);
    graph.metadata.last_dream_cycle = new Date().toISOString();
    graph.metadata.total_cycles = this.totalDreamCycles;
    await this.saveDreamGraph(graph);

    if (mergeCount > 0 || memoryInherited > 0) {
      logger.info(
        `Duplicate suppression: ${mergeCount} merged, ${trulyNew.length} truly new` +
        (memoryInherited > 0 ? `, ${memoryInherited} inherited from reinforcement memory` : "")
      );
    }

    return { appended: trulyNew, merged: mergeCount };
  }

  /**
   * Same for nodes — deduplicate by name similarity.
   */
  async deduplicateAndAppendNodes(newNodes: DreamNode[]): Promise<{ appended: DreamNode[]; merged: number }> {
    this.assertState("rem", "deduplicateAndAppendNodes");
    const graph = await this.loadDreamGraph();
    const currentCycle = this.totalDreamCycles;

    const existingByName = new Map<string, DreamNode>();
    for (const node of graph.nodes) {
      existingByName.set(node.name.toLowerCase(), node);
    }

    const trulyNew: DreamNode[] = [];
    let mergeCount = 0;

    for (const candidate of newNodes) {
      const key = candidate.name.toLowerCase();
      const existing = existingByName.get(key);

      if (existing) {
        // Mirror edge logic: skip rejected, dampened reinforcement curve.
        if (existing.status === "rejected") {
          mergeCount++;
          continue;
        }
        const priorCount = existing.reinforcement_count ?? 0;
        const dampening = 1 / (1 + priorCount * 0.1);
        const bump = candidate.confidence * 0.3 * dampening;
        existing.confidence = Math.min(
          Math.round((existing.confidence + bump) * 100) / 100,
          1.0
        );
        existing.ttl = this.decayConfig.ttl;
        existing.reinforcement_count = priorCount + 1;
        existing.last_reinforced_cycle = currentCycle;
        mergeCount++;
      } else {
        trulyNew.push(candidate);
        existingByName.set(key, candidate);
      }
    }

    graph.nodes.push(...trulyNew);
    graph.metadata.last_dream_cycle = new Date().toISOString();
    graph.metadata.total_cycles = this.totalDreamCycles;
    await this.saveDreamGraph(graph);

    return { appended: trulyNew, merged: mergeCount };
  }

  // -------------------------------------------------------------------------
  // File I/O — Candidate Edges (normalization results)
  // -------------------------------------------------------------------------

  async loadCandidateEdges(): Promise<CandidateEdgesFile> {
    try {
      if (!existsSync(candidateEdgesPath())) return this.emptyCandidateEdgesFile();
      const raw = await readFile(candidateEdgesPath(), "utf-8");
      const p = JSON.parse(raw);
      const e = this.emptyCandidateEdgesFile();
      return {
        metadata: { ...e.metadata, ...(p.metadata && typeof p.metadata === "object" ? p.metadata : {}) },
        results: Array.isArray(p.results) ? p.results : [],
      };
    } catch (err) {
      logger.warn(
        `loadCandidateEdges: failed to read/parse candidate_edges.json — returning empty. ` +
        `Error: ${err instanceof Error ? err.message : err}`
      );
      return this.emptyCandidateEdgesFile();
    }
  }

  private emptyCandidateEdgesFile(): CandidateEdgesFile {
    return {
      metadata: {
        description: "Normalization results — validation judgments on dream artifacts.",
        schema_version: "1.0.0",
        last_normalization: null,
        total_cycles: this.totalNormalizationCycles,
        created_at: new Date().toISOString(),
      },
      results: [],
    };
  }

  async saveCandidateEdges(data: CandidateEdgesFile): Promise<void> {
    await withFileLock("candidate_edges.json", async () => {
      await atomicWriteFile(candidateEdgesPath(), JSON.stringify(data, null, 2));
    });
    logger.debug("Candidate edges saved to disk");
  }

  async appendValidationResults(results: ValidationResult[]): Promise<void> {
    this.assertState("normalizing", "appendValidationResults");
    const candidates = await this.loadCandidateEdges();
    candidates.results.push(...results);
    candidates.metadata.last_normalization = new Date().toISOString();
    candidates.metadata.total_cycles = this.totalNormalizationCycles;
    await this.saveCandidateEdges(candidates);
    // Phase 3 / Slice 2: emit one event per latent candidate so the
    // Explorer can pulse the affected dream edge.
    const latent = results.filter((r) => r.status === "latent");
    for (const r of latent) {
      graphEventBus.emit("candidate.added", {
        affected_ids: [r.dream_id],
        payload: {
          dream_id: r.dream_id,
          dream_type: r.dream_type,
          confidence: r.confidence,
        },
      });
    }
  }

  // -------------------------------------------------------------------------
  // File I/O — Validated Edges (promoted dreams)
  // -------------------------------------------------------------------------

  async loadValidatedEdges(): Promise<ValidatedEdgesFile> {
    try {
      if (!existsSync(validatedEdgesPath())) return this.emptyValidatedEdgesFile();
      const raw = await readFile(validatedEdgesPath(), "utf-8");
      const p = JSON.parse(raw);
      const e = this.emptyValidatedEdgesFile();
      return {
        metadata: { ...e.metadata, ...(p.metadata && typeof p.metadata === "object" ? p.metadata : {}) },
        edges: Array.isArray(p.edges) ? p.edges : [],
      };
    } catch (err) {
      logger.warn(
        `loadValidatedEdges: failed to read/parse validated_edges.json — returning empty. ` +
        `Error: ${err instanceof Error ? err.message : err}`
      );
      return this.emptyValidatedEdgesFile();
    }
  }

  private emptyValidatedEdgesFile(): ValidatedEdgesFile {
    return {
      metadata: {
        description: "Validated edges — dream-originated connections that passed normalization.",
        schema_version: "1.0.0",
        last_validation: null,
        total_validated: 0,
        created_at: new Date().toISOString(),
      },
      edges: [],
    };
  }

  async saveValidatedEdges(data: ValidatedEdgesFile): Promise<void> {
    await withFileLock("validated_edges.json", async () => {
      await atomicWriteFile(validatedEdgesPath(), JSON.stringify(data, null, 2));
    });
    logger.debug("Validated edges saved to disk");
  }

  async promoteEdges(edges: ValidatedEdge[]): Promise<void> {
    this.assertState("normalizing", "promoteEdges");
    const validated = await this.loadValidatedEdges();
    validated.edges.push(...edges);
    validated.metadata.last_validation = new Date().toISOString();
    validated.metadata.total_validated = validated.edges.length;
    await this.saveValidatedEdges(validated);
    logger.info(`Promoted ${edges.length} dream edges to validated status`);
    // Phase 3 / Slice 2: pulse both endpoints of each promoted edge.
    for (const e of edges) {
      graphEventBus.emit("candidate.promoted", {
        affected_ids: [e.from, e.to].filter(Boolean) as string[],
        payload: {
          from: e.from,
          to: e.to,
          confidence: e.confidence,
        },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Entity Promotion — Dream nodes → Fact graph seed files
  // -------------------------------------------------------------------------

  private stringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      : [];
  }

  private stringValue(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
  }

  private buildGroundedEntityIndex(
    features: Feature[],
    workflows: Workflow[],
    dataModel: DataModelEntity[]
  ): { groundedIds: Set<string>; reposById: Map<string, string> } {
    const all = [...features, ...workflows, ...dataModel] as ProvenanceCarrier[];
    const byId = new Map<string, ProvenanceCarrier>();
    const groundedIds = new Set<string>();
    const reposById = new Map<string, string>();

    for (const entity of all) {
      if (!entity.id) continue;
      byId.set(entity.id, entity);
      const repo = this.stringValue(entity.source_repo);
      if (repo) reposById.set(entity.id, repo);
      if (repo && this.stringArray(entity.source_files).length > 0) {
        groundedIds.add(entity.id);
      }
      if (repo && entity.human_asserted === true) {
        groundedIds.add(entity.id);
      }
    }

    // Derived hubs are grounded only when their declared supports already have
    // a repo-grounded path. Iterate to a fixed point so hubs can derive from hubs.
    let changed = true;
    while (changed) {
      changed = false;
      for (const entity of all) {
        if (!entity.id || groundedIds.has(entity.id)) continue;
        const repo = reposById.get(entity.id) ?? "";
        const supports = this.stringArray(entity.derived_from_node_ids);
        if (repo && supports.length > 0 && supports.every((id) => groundedIds.has(id))) {
          groundedIds.add(entity.id);
          changed = true;
        }
      }
    }

    return { groundedIds, reposById };
  }

  private resolveCanonicalPromotionProvenance(
    node: DreamNode,
    groundedIds: Set<string>,
    reposById: Map<string, string>
  ): CanonicalPromotionProvenance | null {
    const carrier = node as ProvenanceCarrier;
    const sourceFiles = this.stringArray(carrier.source_files);
    const explicitRepo = this.stringValue(carrier.source_repo);
    const declaredSupports = this.stringArray(carrier.derived_from_node_ids);
    const inspirationSupports = this.stringArray(carrier.inspiration);
    const derivedFromNodeIds = declaredSupports.length > 0 ? declaredSupports : inspirationSupports;

    // Middle route: a hub may lack direct source files, but it still must be
    // scoped to a repository. If the dream node did not carry source_repo yet,
    // infer it only when all grounded support nodes point to exactly one repo.
    const supportRepos = new Set(
      derivedFromNodeIds
        .filter((id) => groundedIds.has(id))
        .map((id) => reposById.get(id) ?? "")
        .filter((repo) => repo.length > 0)
    );
    const sourceRepo = explicitRepo || (supportRepos.size === 1 ? [...supportRepos][0] : "");
    if (!sourceRepo) return null;

    if (sourceFiles.length > 0) {
      return { sourceRepo, sourceFiles, kind: "source_backed", derivedFromNodeIds: [] };
    }

    if (carrier.human_asserted === true) {
      return { sourceRepo, sourceFiles: [], kind: "human_asserted", derivedFromNodeIds: [] };
    }

    if (derivedFromNodeIds.length > 0 && derivedFromNodeIds.every((id) => groundedIds.has(id))) {
      return { sourceRepo, sourceFiles: [], kind: "derived_hub", derivedFromNodeIds };
    }

    return null;
  }

  /**
   * Promote validated dream nodes into the fact graph.
   *
   * Promotion is not validation-by-density. A canonical entity must belong to a
   * repository and must have a provenance path back to real evidence: direct
   * source files, explicit human assertion, or a derived-hub chain whose support
   * nodes are already grounded. This preserves useful semantic hubs while
   * preventing self-consistent fictional clouds from becoming facts.
   *
   * Each grounded node is written to the appropriate seed file based on its
   * category (feature, workflow, or data_model), then the resource index is
   * rebuilt.
   *
   * The dream node is marked with `promoted_at` so it won't be
   * promoted again, but remains in dream_graph.json as provenance.
   */
  async promoteNodesToFactGraph(nodes: DreamNode[]): Promise<{ promoted: number; skipped: number }> {
    this.assertState("normalizing", "promoteNodesToFactGraph");

    if (nodes.length === 0) return { promoted: 0, skipped: 0 };

    // Load current seed files
    const [features, workflows, dataModel] = await Promise.all([
      loadJsonArray<Feature>("features.json"),
      loadJsonArray<Workflow>("workflows.json"),
      loadJsonArray<DataModelEntity>("data_model.json"),
    ]);

    // Build existing ID sets to prevent duplicates and provenance indexes for
    // validating derived hubs. Every canonical node must be repo-scoped, and a
    // source-less hub must derive from already-grounded nodes rather than from
    // other ungrounded dreams.
    const existingIds = new Set<string>([
      ...features.map(f => f.id),
      ...workflows.map(w => w.id),
      ...dataModel.map(d => d.id),
    ]);
    const { groundedIds, reposById } = this.buildGroundedEntityIndex(features, workflows, dataModel);

    let promoted = 0;
    let skipped = 0;
    const now = new Date().toISOString();

    for (const node of nodes) {
      // Strip dream_ prefix for the fact graph ID
      const factId = node.id.replace(/^dream_(llm_)?/, "");

      if (existingIds.has(factId) || existingIds.has(node.id)) {
        skipped++;
        continue;
      }

      const provenance = this.resolveCanonicalPromotionProvenance(node, groundedIds, reposById);
      if (!provenance) {
        skipped++;
        logger.warn(
          `Entity promotion blocked for "${node.id}": missing repository-scoped source evidence, ` +
          `human assertion, or grounded derived-hub support`
        );
        continue;
      }

      const category = node.category ?? "feature";
      // Intent enriches the description, but canonical status comes from provenance.
      const description = node.intent
        ? `${node.description}. Intent: ${node.intent}`
        : node.description;
      const provenanceFields = {
        source_repo: provenance.sourceRepo,
        source_files: provenance.sourceFiles,
        provenance_kind: provenance.kind,
        ...(provenance.derivedFromNodeIds.length > 0
          ? { derived_from_node_ids: provenance.derivedFromNodeIds }
          : {}),
      };

      if (category === "feature") {
        features.push({
          id: factId,
          name: node.name,
          description,
          ...provenanceFields,
          status: "discovered",
          category: node.domain ?? "dream-promoted",
          tags: ["dream-promoted", provenance.kind],
          domain: node.domain ?? "",
          keywords: node.keywords ?? [],
          links: [],
        });
      } else if (category === "workflow") {
        workflows.push({
          id: factId,
          name: node.name,
          description,
          ...provenanceFields,
          trigger: provenance.kind === "derived_hub" ? "derived from grounded behavioral evidence" : "source evidence",
          steps: [],
          domain: node.domain ?? "",
          keywords: node.keywords ?? [],
          status: "discovered",
          links: [],
        });
      } else {
        dataModel.push({
          id: factId,
          name: node.name,
          description,
          ...provenanceFields,
          key_fields: [],
          relationships: [],
          domain: node.domain ?? "",
          keywords: node.keywords ?? [],
          status: "discovered",
          links: [],
        });
      }

      groundedIds.add(factId);
      reposById.set(factId, provenance.sourceRepo);

      // Mark the dream node as promoted
      node.promoted_at = now;
      existingIds.add(factId);
      promoted++;
    }

    if (promoted === 0) return { promoted: 0, skipped };

    // Write updated seed files
    const writes: Promise<void>[] = [];

    const writeSeed = async (filename: string, data: unknown) => {
      await withFileLock(filename, async () => {
        await atomicWriteFile(dataPath(filename), JSON.stringify(data, null, 2));
      });
      invalidateCache(filename);
    };

    writes.push(writeSeed("features.json", features));
    writes.push(writeSeed("workflows.json", workflows));
    writes.push(writeSeed("data_model.json", dataModel));
    await Promise.all(writes);

    // Rebuild resource index
    const entities: Record<string, IndexEntry> = {};
    for (const f of features.filter(e => !("_schema" in e))) {
      entities[f.id] = { type: "feature", uri: `dreamgraph://resource/feature/${f.id}`, name: f.name, source_repo: f.source_repo };
    }
    for (const w of workflows.filter(e => !("_schema" in e))) {
      entities[w.id] = { type: "workflow", uri: `dreamgraph://resource/workflow/${w.id}`, name: w.name, source_repo: w.source_repo };
    }
    for (const d of dataModel.filter(e => !("_schema" in e))) {
      entities[d.id] = { type: "data_model", uri: `dreamgraph://resource/data_model/${d.id}`, name: d.name, source_repo: d.source_repo };
    }
    // Slice 1 — first-class UI graph citizens. Only source-bound entries.
    for (const u of await loadIndexableUIElements()) {
      entities[u.id] = {
        type: "ui_element",
        uri: `dreamgraph://resource/ui_element/${u.id}`,
        name: u.name,
        source_repo: u.source_repo,
      };
    }
    const index: ResourceIndex = { entities };
    await withFileLock("index.json", async () => {
      await atomicWriteFile(dataPath("index.json"), JSON.stringify(index, null, 2));
    });
    invalidateCache("index.json");

    // Save dream graph with promoted_at markers
    const dreamGraph = await this.loadDreamGraph();
    const promotedIds = new Set(nodes.filter(n => n.promoted_at).map(n => n.id));
    for (const n of dreamGraph.nodes) {
      if (promotedIds.has(n.id)) n.promoted_at = now;
    }
    await this.saveDreamGraph(dreamGraph);

    logger.info(
      `Entity promotion: ${promoted} dream nodes became fact entities ` +
      `(${skipped} skipped as duplicates) — intent is now factual`
    );

    return { promoted, skipped };
  }

  /** Get the N most recently validated edges (for LLM dream context). */
  async getRecentValidatedEdges(n: number = 10): Promise<ValidatedEdge[]> {
    const validated = await this.loadValidatedEdges();
    return validated.edges
      .sort((a, b) => (b.validated_at ?? "").localeCompare(a.validated_at ?? ""))
      .slice(0, n);
  }

  // -------------------------------------------------------------------------
  // File I/O — Tension Log
  // -------------------------------------------------------------------------

  async loadTensions(): Promise<TensionFile> {
    try {
      if (!existsSync(tensionPath())) {
        return this.emptyTensionFile();
      }
      const raw = await readFile(tensionPath(), "utf-8");
      const p = JSON.parse(raw);
      const e = this.emptyTensionFile();
      return {
        metadata: { ...e.metadata, ...(p.metadata && typeof p.metadata === "object" ? p.metadata : {}) },
        signals: Array.isArray(p.signals) ? p.signals : [],
        resolved_tensions: Array.isArray(p.resolved_tensions) ? p.resolved_tensions : [],
      };
    } catch (err) {
      logger.warn(
        `loadTensions: failed to read/parse tension_log.json — returning empty. ` +
        `Error: ${err instanceof Error ? err.message : err}`
      );
      return this.emptyTensionFile();
    }
  }

  async saveTensions(data: TensionFile): Promise<void> {
    data.metadata.total_signals = data.signals.length;
    data.metadata.total_resolved = data.resolved_tensions?.length ?? 0;
    data.metadata.last_updated = new Date().toISOString();
    await withFileLock("tension_log.json", async () => {
      await atomicWriteFile(tensionPath(), JSON.stringify(data, null, 2));
    });
    logger.debug("Tension log saved to disk");
  }

  /**
   * Record a tension signal. If a similar tension already exists,
   * increment its occurrence count and urgency.
   * New: assigns domain group and TTL for decay.
   */
  async recordTension(signal: Omit<TensionSignal, "id" | "occurrences" | "first_seen" | "last_seen" | "attempted" | "resolved" | "ttl" | "domain"> & { domain?: TensionDomain }): Promise<TensionSignal> {
    const tensions = await this.loadTensions();
    const now = new Date().toISOString();

    // Check for existing similar tension (same type + BOTH entities match)
    // Previously used .some() which caused greedy merging — 27+ separate
    // rejections would collapse into 1 mega-tension. Now require ALL
    // entities from the new signal to already exist in the existing tension.
    const existing = tensions.signals.find(
      (s) =>
        s.type === signal.type &&
        !s.resolved &&
        signal.entities.every((e) => s.entities.includes(e))
    );

    // If no existing match, enforce max_active_tensions cap
    // Merging into existing tensions (occurrences++) is always allowed.
    if (!existing) {
      const activeCount = tensions.signals.filter((s) => !s.resolved).length;
      if (activeCount >= this.tensionConfig.max_active_tensions) {
        logger.debug(`Tension cap reached (${activeCount}/${this.tensionConfig.max_active_tensions}), skipping new tension for [${signal.entities.join(", ")}]`);
        // Return a stub so callers don't break — but don't persist
        return {
          id: "capped",
          type: signal.type,
          domain: "general",
          entities: signal.entities,
          description: signal.description,
          occurrences: 0,
          urgency: 0,
          first_seen: now,
          last_seen: now,
          attempted: false,
          resolved: true,
          ttl: 0,
        } as TensionSignal;
      }
    }

    if (existing) {
      existing.occurrences++;
      existing.last_seen = now;
      existing.urgency = Math.min(
        Math.round((existing.urgency + 0.1) * 100) / 100,
        1.0
      );
      // Reset TTL on re-observation (tension is still alive)
      existing.ttl = this.tensionConfig.default_tension_ttl;
      await this.saveTensions(tensions);
      return existing;
    }

    // Infer domain from entity IDs if not provided
    const domain = signal.domain ?? this.inferTensionDomain(signal.entities, signal.description);

    const newSignal: TensionSignal = {
      id: `tension_${Date.now()}_${tensions.signals.length + 1}`,
      type: signal.type,
      domain,
      entities: signal.entities,
      description: signal.description,
      occurrences: 1,
      urgency: signal.urgency,
      first_seen: now,
      last_seen: now,
      attempted: false,
      resolved: false,
      ttl: this.tensionConfig.default_tension_ttl,
    };

    tensions.signals.push(newSignal);
    await this.saveTensions(tensions);
    // Phase 3 / Slice 2: notify Explorer that a brand-new tension exists.
    // Merge-into-existing and capped paths above intentionally don't emit —
    // there's no new graph topology in those cases.
    graphEventBus.emit("tension.created", {
      affected_ids: [newSignal.id, ...newSignal.entities],
      payload: {
        tension_id: newSignal.id,
        type: newSignal.type,
        domain: newSignal.domain,
        urgency: newSignal.urgency,
      },
    });
    return newSignal;
  }

  /**
   * Resolve a tension with full authority and reason tracking.
   * Moves the tension to resolved_tensions archive instead of deleting.
   * Sets urgency to 0 and marks resolved so it stops driving dreams.
   */
  async resolveTension(
    tensionId: string,
    resolvedBy: TensionResolutionAuthority = "system",
    resolutionType: TensionResolutionType = "confirmed_fixed",
    evidence?: string,
    recheckTtl?: number
  ): Promise<ResolvedTension | null> {
    const tensions = await this.loadTensions();
    const idx = tensions.signals.findIndex((s) => s.id === tensionId);
    if (idx === -1) return null;

    const signal = tensions.signals[idx];
    const now = new Date().toISOString();

    // Create archive entry
    const resolved: ResolvedTension = {
      tension_id: tensionId,
      resolved_at: now,
      resolved_by: resolvedBy,
      resolution_type: resolutionType,
      evidence,
      recheck_ttl: recheckTtl,
      original: { ...signal },
    };

    // Mark as resolved (urgency drops to 0)
    signal.resolved = true;
    signal.urgency = 0;

    // Move to resolved archive
    if (!tensions.resolved_tensions) {
      tensions.resolved_tensions = [];
    }
    tensions.resolved_tensions.push(resolved);

    // Remove from active signals
    tensions.signals.splice(idx, 1);

    await this.saveTensions(tensions);
    logger.info(
      `Tension resolved: "${tensionId}" by ${resolvedBy} as ${resolutionType}` +
      (evidence ? ` (evidence: ${evidence})` : "")
    );
    // Phase 3 / Slice 2: notify Explorer that the tension is gone.
    graphEventBus.emit("tension.resolved", {
      affected_ids: [tensionId, ...(resolved.original.entities ?? [])],
      payload: {
        tension_id: tensionId,
        resolved_by: resolvedBy,
        resolution_type: resolutionType,
      },
    });
    return resolved;
  }

  /**
   * Apply decay to all active tensions.
   * - Urgency reduced by tension_urgency_decay per cycle
   * - TTL decremented by 1
   * - Tensions with TTL <= 0 or urgency below threshold are auto-expired
   * - Auto-expired tensions are moved to resolved_tensions as "false_positive"
   *
   * Returns count of expired tensions.
   */
  async applyTensionDecay(): Promise<{ expired: number; decayed: number }> {
    const tensions = await this.loadTensions();
    const surviving: TensionSignal[] = [];
    let expired = 0;
    let decayed = 0;

    if (!tensions.resolved_tensions) {
      tensions.resolved_tensions = [];
    }

    for (const signal of tensions.signals) {
      if (signal.resolved) continue; // Already resolved, skip

      // Decay
      signal.ttl = (signal.ttl ?? this.tensionConfig.default_tension_ttl) - 1;
      signal.urgency = Math.round(
        Math.max(signal.urgency - this.tensionConfig.tension_urgency_decay, 0) * 100
      ) / 100;

      // Check expiry conditions
      if (
        signal.ttl <= 0 ||
        signal.urgency < this.tensionConfig.min_urgency_threshold
      ) {
        // Auto-expire: move to resolved as false_positive (noise that faded)
        tensions.resolved_tensions.push({
          tension_id: signal.id,
          resolved_at: new Date().toISOString(),
          resolved_by: "system",
          resolution_type: "false_positive",
          evidence: signal.ttl <= 0
            ? "TTL expired without re-observation"
            : "Urgency decayed below threshold (" + signal.urgency + ")",
          original: { ...signal },
        });
        expired++;
        logger.debug(
          `Tension expired: "${signal.id}" (ttl=${signal.ttl}, urgency=${signal.urgency})`
        );
        continue;
      }

      decayed++;
      surviving.push(signal);
    }

    tensions.signals = surviving;
    await this.saveTensions(tensions);

    if (expired > 0) {
      logger.info(
        `Tension decay: ${expired} expired, ${surviving.length} surviving`
      );
    }

    return { expired, decayed };
  }

  /**
   * Check resolved tensions for recheck_ttl expiry.
   *
   * Contradictory-evidence hook (F-02):
   *   While a resolved tension's recheck window is still open
   *   (recheck_ttl > 0), scan currently active tensions for any signal that
   *   overlaps with the resolved tension's original entities AND shares its
   *   domain. Such an overlap means the system has independently re-raised
   *   the same concern after we marked it resolved — strong evidence the
   *   resolution was premature. The original tension is restored to the
   *   active list (with a fresh TTL and a small urgency bump) and removed
   *   from the resolved archive. Reactivations are logged.
   *
   *   Resolutions that are explicitly `wont_fix` are NOT reactivated — the
   *   user accepted the risk. `confirmed_fixed` and `false_positive` may be
   *   reactivated.
   */
  async processRecheckWindows(): Promise<number> {
    const tensions = await this.loadTensions();
    if (!tensions.resolved_tensions || tensions.resolved_tensions.length === 0) {
      return 0;
    }

    const activeSignals = tensions.signals.filter((s) => !s.resolved);
    let reactivated = 0;
    const stillResolved: ResolvedTension[] = [];

    for (const resolved of tensions.resolved_tensions) {
      // Closed window — keep archived as-is.
      if (resolved.recheck_ttl === undefined || resolved.recheck_ttl <= 0) {
        stillResolved.push(resolved);
        continue;
      }

      const original = resolved.original;
      const originalEntities = new Set(original.entities ?? []);
      const contradicted =
        resolved.resolution_type !== "wont_fix" &&
        activeSignals.some(
          (sig) =>
            sig.id !== original.id &&
            sig.domain === original.domain &&
            (sig.entities ?? []).some((e) => originalEntities.has(e))
        );

      if (contradicted) {
        // Reactivate: restore the original signal with refreshed TTL and a
        // small urgency bump so the dreamer notices it on the next cycle.
        const reborn: TensionSignal = {
          ...original,
          attempted: false,
          resolved: false,
          ttl: this.tensionConfig.default_tension_ttl,
          urgency: Math.min(1, (original.urgency ?? 0.5) + 0.1),
          last_seen: new Date().toISOString(),
        };
        tensions.signals.push(reborn);
        reactivated++;
        logger.info(
          `Tension reactivated by contradictory evidence: "${original.id}" ` +
            `(domain=${original.domain}, recheck_ttl was ${resolved.recheck_ttl})`
        );
        continue; // Drop from resolved archive.
      }

      resolved.recheck_ttl--;
      stillResolved.push(resolved);
    }

    tensions.resolved_tensions = stillResolved;
    if (reactivated > 0) {
      await this.saveTensions(tensions);
    }
    return reactivated;
  }

  /** Get unresolved tensions sorted by urgency, capped at max_active_tensions */
  async getUnresolvedTensions(): Promise<TensionSignal[]> {
    const tensions = await this.loadTensions();
    return tensions.signals
      .filter((s) => !s.resolved)
      .sort((a, b) => b.urgency - a.urgency)
      .slice(0, this.tensionConfig.max_active_tensions);
  }

  /** Get resolved tensions archive */
  async getResolvedTensions(): Promise<ResolvedTension[]> {
    const tensions = await this.loadTensions();
    return tensions.resolved_tensions ?? [];
  }

  /** Get tension stats grouped by domain */
  async getTensionsByDomain(): Promise<Record<string, { count: number; avg_urgency: number }>> {
    const tensions = await this.loadTensions();
    const groups: Record<string, { count: number; total_urgency: number }> = {};

    for (const s of tensions.signals) {
      if (s.resolved) continue;
      const d = s.domain ?? "general";
      if (!groups[d]) groups[d] = { count: 0, total_urgency: 0 };
      groups[d].count++;
      groups[d].total_urgency += s.urgency;
    }

    const result: Record<string, { count: number; avg_urgency: number }> = {};
    for (const [domain, stats] of Object.entries(groups)) {
      result[domain] = {
        count: stats.count,
        avg_urgency: Math.round((stats.total_urgency / stats.count) * 100) / 100,
      };
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Tension Resolution Lifecycle (Phase 4 #8)
  //
  // A two-phase pipeline that lets the system *propose* a fix for an open
  // tension and then *validate* whether the fix actually landed.
  //
  //   1. proposeTensionResolution  → stamps a candidate on the tension.
  //   2. runTensionResolverCycle   → bulk proposer (heuristic or injected LLM).
  //   3. validateResolutionCandidates → after the validation_window expires:
  //        - confirms (resolveTension/confirmed_fixed) when bridging evidence
  //          appears in validated_edges,
  //        - accepts wont_fix candidates as resolved/wont_fix,
  //        - escalates everything else (urgency bump, candidate cleared,
  //          attempted=true).
  //   4. getResolutionPipelineStats surfaces queue depth for cognitive_status.
  // -------------------------------------------------------------------------

  /** Stamp a resolution candidate onto an open tension (idempotent — overwrites). */
  async proposeTensionResolution(
    tensionId: string,
    candidate: Omit<TensionResolutionCandidate, "proposed_at"> & { proposed_at?: string }
  ): Promise<TensionSignal | null> {
    let updated: TensionSignal | null = null;
    await withFileLock("tension_log.json", async () => {
      const tensions = await this.loadTensions();
      const idx = tensions.signals.findIndex((s) => s.id === tensionId);
      if (idx === -1) return;
      const signal = tensions.signals[idx];
      if (signal.resolved) return;
      signal.resolution_candidate = {
        strategy: candidate.strategy,
        rationale: candidate.rationale,
        validation_window: Math.max(1, candidate.validation_window),
        source: candidate.source,
        proposed_at: candidate.proposed_at ?? new Date().toISOString(),
      };
      tensions.signals[idx] = signal;
      await atomicWriteFile(tensionPath(), JSON.stringify(tensions, null, 2));
      updated = signal;
    });
    return updated;
  }

  /**
   * Heuristic candidate generator. Maps tension type → a sensible default
   * strategy + rationale. Used when no LLM proposer is supplied.
   */
  private heuristicCandidate(sig: TensionSignal): Omit<TensionResolutionCandidate, "proposed_at"> {
    const window = 3;
    switch (sig.type) {
      case "missing_link":
        return {
          strategy: "merge",
          rationale: `Entities ${sig.entities.slice(0, 2).join(" / ")} repeatedly co-occur without a graph link — propose a direct edge or identity merge.`,
          validation_window: window,
          source: "heuristic",
        };
      case "weak_connection":
        return {
          strategy: "mediator",
          rationale: `Connection between ${sig.entities.slice(0, 2).join(" / ")} is weak — look for a third entity sitting on the bridge.`,
          validation_window: window,
          source: "heuristic",
        };
      case "ungrounded_dream":
        return {
          strategy: "wont_fix",
          rationale: `Dream remains ungrounded after ${sig.occurrences} observation(s); accept as speculative and close.`,
          validation_window: window,
          source: "heuristic",
        };
      case "hard_query":
        return {
          strategy: "reframe",
          rationale: `Query repeatedly fails to land — the question or expected schema may need restating.`,
          validation_window: window,
          source: "heuristic",
        };
      case "code_insight":
      default:
        return {
          strategy: "split",
          rationale: `Code-level signal suggests ${sig.entities[0] ?? "this entity"} is doing too much; consider splitting responsibilities.`,
          validation_window: window,
          source: "heuristic",
        };
    }
  }

  /**
   * Bulk proposer pass. Picks the top-N most urgent open tensions that don't
   * already carry a candidate and stamps one on each.
   *
   * v8.2.6 — the heuristic path now defers to the intervention engine
   * (`proposeResolutionCandidateFromPlan`) so each candidate carries a
   * concrete `proposed_action` (an `enrich_seed_data` payload or a
   * `resolve_tension` call) instead of a strategy keyword. When
   * `DREAMGRAPH_AUTO_APPLY_RESOLUTION_PLANS=1` is set, `graph_enrichment`
   * payloads are executed immediately so the next dream cycle can observe
   * the new edge and the validation pass can confirm it.
   */
  async runTensionResolverCycle(opts?: {
    maxSamples?: number;
    proposer?: (sig: TensionSignal) => Promise<Omit<TensionResolutionCandidate, "proposed_at"> | null> | Omit<TensionResolutionCandidate, "proposed_at"> | null;
  }): Promise<{ proposed: number; skipped: number; auto_applied: number }> {
    const maxSamples = Math.max(1, opts?.maxSamples ?? 5);
    const tensions = await this.loadTensions();
    const candidates = tensions.signals
      .filter((s) => !s.resolved && !s.resolution_candidate && !s.attempted)
      .sort((a, b) => b.urgency - a.urgency)
      .slice(0, maxSamples);

    if (candidates.length === 0) return { proposed: 0, skipped: 0, auto_applied: 0 };

    // Build the per-cycle planner context once (loads data_model + dream_graph).
    let planCtx: TensionPlanContext | null = null;
    try {
      planCtx = await buildTensionPlanContext();
    } catch (err) {
      logger.warn(
        `runTensionResolverCycle: failed to build plan context — falling back to keyword heuristic. ` +
        `Error: ${err instanceof Error ? err.message : err}`
      );
    }

    const autoApply = process.env.DREAMGRAPH_AUTO_APPLY_RESOLUTION_PLANS === "1"
      || process.env.DREAMGRAPH_AUTO_APPLY_RESOLUTION_PLANS === "true";

    let proposed = 0;
    let skipped = 0;
    let auto_applied = 0;
    for (const sig of candidates) {
      let candidate: Omit<TensionResolutionCandidate, "proposed_at"> | null = null;
      if (opts?.proposer) {
        try {
          candidate = await opts.proposer(sig);
        } catch (err) {
          logger.warn(
            `runTensionResolverCycle: proposer threw for ${sig.id} — falling back to heuristic. ` +
            `Error: ${err instanceof Error ? err.message : err}`
          );
        }
      }
      if (!candidate && planCtx) {
        try {
          candidate = proposeResolutionCandidateFromPlan(sig, planCtx);
        } catch (err) {
          logger.warn(
            `runTensionResolverCycle: intervention bridge threw for ${sig.id} — falling back to keyword heuristic. ` +
            `Error: ${err instanceof Error ? err.message : err}`
          );
        }
      }
      if (!candidate) candidate = this.heuristicCandidate(sig);
      if (!candidate) { skipped++; continue; }
      await this.proposeTensionResolution(sig.id, candidate);
      proposed++;

      // Auto-apply: execute graph_enrichment payloads immediately.
      if (
        autoApply &&
        candidate.proposed_action &&
        "tool" in candidate.proposed_action &&
        candidate.proposed_action.tool === "enrich_seed_data"
      ) {
        try {
          const action = candidate.proposed_action;
          const result = await executeEnrichSeedData({
            target: action.target,
            entries: action.entries,
            mode: action.mode,
          });
          if (result.success) {
            auto_applied++;
            logger.info(
              `runTensionResolverCycle: auto-applied enrich_seed_data for ${sig.id} — ` +
              `${(result.data as { entries_inserted: number; entries_updated: number }).entries_inserted} new, ` +
              `${(result.data as { entries_inserted: number; entries_updated: number }).entries_updated} updated`
            );
          } else {
            logger.warn(
              `runTensionResolverCycle: auto-apply for ${sig.id} failed — ${result.error?.code}: ${result.error?.message}`
            );
          }
        } catch (err) {
          logger.warn(
            `runTensionResolverCycle: auto-apply for ${sig.id} threw — ` +
            `${err instanceof Error ? err.message : err}`
          );
        }
      }
    }
    return { proposed, skipped, auto_applied };
  }

  /**
   * Validation pass — runs each cycle. Decrements validation_window; when
   * window hits 0, classifies the candidate as confirmed / accepted / escalated
   * based on the current validated-edges graph.
   */
  async validateResolutionCandidates(): Promise<{
    confirmed: number;
    accepted_wont_fix: number;
    escalated: number;
    awaiting: number;
  }> {
    const validated = await this.loadValidatedEdges();

    // v8.2.6 — index bridges by entity-pair AND by validation timestamp so
    // we can require the bridge to have appeared *after* the candidate was
    // proposed. A pre-existing bridge no longer counts as evidence that the
    // resolution worked.
    const bridgeFirstSeen = new Map<string, number>(); // key -> earliest validated_at ms
    for (const e of validated.edges) {
      if (!e.from || !e.to) continue;
      const ts = e.validated_at ? Date.parse(e.validated_at) : NaN;
      const stamp = Number.isFinite(ts) ? ts : 0;
      const k1 = `${e.from}\u0000${e.to}`;
      const k2 = `${e.to}\u0000${e.from}`;
      const prev1 = bridgeFirstSeen.get(k1);
      const prev2 = bridgeFirstSeen.get(k2);
      if (prev1 === undefined || stamp < prev1) bridgeFirstSeen.set(k1, stamp);
      if (prev2 === undefined || stamp < prev2) bridgeFirstSeen.set(k2, stamp);
    }

    const decisions: Array<{ id: string; outcome: "confirmed" | "wont_fix" | "escalate" }> = [];
    const tensions = await this.loadTensions();

    for (const sig of tensions.signals) {
      if (sig.resolved || !sig.resolution_candidate) continue;
      sig.resolution_candidate.validation_window -= 1;
      if (sig.resolution_candidate.validation_window > 0) continue;

      const proposedAtMs = Date.parse(sig.resolution_candidate.proposed_at);
      const proposedThreshold = Number.isFinite(proposedAtMs) ? proposedAtMs : 0;

      const ents = sig.entities;
      const hasFreshBridge = ents.length >= 2 && (() => {
        for (let i = 0; i < ents.length; i++) {
          for (let j = i + 1; j < ents.length; j++) {
            const ts = bridgeFirstSeen.get(`${ents[i]}\u0000${ents[j]}`);
            if (ts === undefined) continue;
            // Strict: bridge must have first appeared at or after proposal.
            // Allow a small clock-skew tolerance of 1 second.
            if (ts >= proposedThreshold - 1000) return true;
          }
        }
        return false;
      })();

      if (hasFreshBridge) {
        decisions.push({ id: sig.id, outcome: "confirmed" });
      } else if (sig.resolution_candidate.strategy === "wont_fix") {
        decisions.push({ id: sig.id, outcome: "wont_fix" });
      } else {
        decisions.push({ id: sig.id, outcome: "escalate" });
      }
    }

    // Persist the window-decrement first so the counters above are durable
    // even if the resolveTension calls below short-circuit.
    await this.saveTensions(tensions);

    let confirmed = 0;
    let accepted_wont_fix = 0;
    let escalated = 0;

    for (const d of decisions) {
      if (d.outcome === "confirmed") {
        await this.resolveTension(d.id, "system", "confirmed_fixed", "validated_edges contains a bridging connection between tension entities");
        confirmed++;
      } else if (d.outcome === "wont_fix") {
        await this.resolveTension(d.id, "system", "wont_fix", "resolution candidate proposed wont_fix and validation window expired");
        accepted_wont_fix++;
      } else {
        // Escalate: bump urgency, mark attempted, clear the failed candidate.
        await withFileLock("tension_log.json", async () => {
          const t = await this.loadTensions();
          const idx = t.signals.findIndex((s) => s.id === d.id);
          if (idx === -1) return;
          const s = t.signals[idx];
          s.urgency = Math.min(1, Math.round((s.urgency + 0.05) * 100) / 100);
          s.attempted = true;
          delete s.resolution_candidate;
          t.signals[idx] = s;
          await atomicWriteFile(tensionPath(), JSON.stringify(t, null, 2));
        });
        escalated++;
      }
    }

    const awaiting = (await this.loadTensions()).signals.filter(
      (s) => !s.resolved && !!s.resolution_candidate
    ).length;

    return { confirmed, accepted_wont_fix, escalated, awaiting };
  }

  /** Pipeline stats for cognitive_status. */
  async getResolutionPipelineStats(): Promise<{
    pending_candidates: number;
    by_strategy: Record<TensionResolutionStrategy, number>;
    awaiting_validation: number;
  }> {
    const tensions = await this.loadTensions();
    const by_strategy: Record<TensionResolutionStrategy, number> = {
      merge: 0, mediator: 0, split: 0, reframe: 0, wont_fix: 0,
    };
    let pending = 0;
    let awaiting = 0;
    for (const s of tensions.signals) {
      if (s.resolved || !s.resolution_candidate) continue;
      pending++;
      by_strategy[s.resolution_candidate.strategy]++;
      if (s.resolution_candidate.validation_window > 0) awaiting++;
    }
    return { pending_candidates: pending, by_strategy, awaiting_validation: awaiting };
  }

  /**
   * Infer the domain of a tension from the entity IDs and description.
   * Simple keyword-based heuristic.
   */
  private inferTensionDomain(entities: string[], description: string): TensionDomain {
    const text = [...entities, description].join(" ").toLowerCase();

    if (text.match(/rls|auth|login|jwt|password|session/)) return "security";
    if (text.match(/invoice|finvoice|billing|maventa|stamp_credit/)) return "invoicing";
    if (text.match(/sync|cloud_sync|bidirectional|realtime/)) return "sync";
    if (text.match(/stripe|resend|netvisor|openai|firebase|fcm|maventa|open_meteo/)) return "integration";
    if (text.match(/payroll|salary|worker_payroll|netvisor.*payroll/)) return "payroll";
    if (text.match(/report|pdf|export_pdf|export_history/)) return "reporting";
    if (text.match(/api_key|api_usage|pdf_as_a_service/)) return "api";
    if (text.match(/mobile|onboarding|dictation|gps|photo/)) return "mobile";
    if (text.match(/table|column|constraint|schema|migration|data_model/)) return "data_model";
    if (text.match(/signup|user_signup|account_deletion/)) return "auth";

    return "general";
  }

  private emptyTensionFile(): TensionFile {
    return {
      metadata: {
        description: "Tension Log -- signals that direct goal-oriented dreaming, with resolution archive.",
        schema_version: "2.0.0",
        total_signals: 0,
        total_resolved: 0,
        last_updated: null,
      },
      signals: [],
      resolved_tensions: [],
    };
  }

  // -------------------------------------------------------------------------
  // File I/O — Dream History
  // -------------------------------------------------------------------------

  async loadDreamHistory(): Promise<DreamHistoryFile> {
    try {
      if (!existsSync(historyPath())) {
        return this.emptyHistoryFile();
      }
      const raw = await readFile(historyPath(), "utf-8");
      const p = JSON.parse(raw);
      const e = this.emptyHistoryFile();
      return {
        metadata: { ...e.metadata, ...(p.metadata && typeof p.metadata === "object" ? p.metadata : {}) },
        sessions: Array.isArray(p.sessions) ? p.sessions : [],
      };
    } catch (err) {
      logger.warn(
        `loadDreamHistory: failed to read/parse dream_history.json — returning empty. ` +
        `Error: ${err instanceof Error ? err.message : err}`
      );
      return this.emptyHistoryFile();
    }
  }

  async appendHistoryEntry(entry: DreamHistoryEntry): Promise<void> {
    const history = await this.loadDreamHistory();
    history.sessions.push(entry);
    history.metadata.total_sessions = history.sessions.length;
    await withFileLock("dream_history.json", async () => {
      await atomicWriteFile(historyPath(), JSON.stringify(history, null, 2));
    });
    logger.debug(`Dream history entry recorded: session ${entry.session_id}`);
    // Phase 3 / Slice 2: appendHistoryEntry is the canonical "a cycle just
    // finished" signal — every dream/normalization/nightmare path funnels
    // through here at the end. Cheaper than instrumenting each strategy.
    graphEventBus.emit("dream.cycle.completed", {
      affected_ids: [],
      payload: {
        session_id: entry.session_id,
        strategy: (entry as { strategy?: string }).strategy ?? null,
      },
    });
  }

  private emptyHistoryFile(): DreamHistoryFile {
    return {
      metadata: {
        description: "Dream History — audit trail of every cognitive cycle.",
        schema_version: "1.0.0",
        total_sessions: 0,
        created_at: new Date().toISOString(),
      },
      sessions: [],
    };
  }

  // -------------------------------------------------------------------------
  // Clear / Reset
  // -------------------------------------------------------------------------

  private repoValues(value: unknown): string[] {
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed ? [trimmed] : [];
    }
    if (Array.isArray(value)) {
      return value
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
    }
    return [];
  }

  private hasRepoScope(entity: ProvenanceCarrier): boolean {
    return this.repoValues(entity.source_repo).length > 0;
  }

  private isDirectlyGrounded(entity: ProvenanceCarrier): boolean {
    return this.hasRepoScope(entity) && (
      this.stringArray(entity.source_files).length > 0 ||
      entity.human_asserted === true
    );
  }

  private buildGroundedCanonicalIdSet(entities: ProvenanceCarrier[]): Set<string> {
    const byId = new Map<string, ProvenanceCarrier>();
    const groundedIds = new Set<string>();

    for (const entity of entities) {
      if (!entity.id) continue;
      byId.set(entity.id, entity);
      if (this.isDirectlyGrounded(entity)) groundedIds.add(entity.id);
    }

    // Hubs are valid connective tissue when they are repo-scoped and their
    // supports already have a grounding path. Iterate to a fixed point so
    // hub→hub chains survive when their ends ultimately reach real nodes.
    let changed = true;
    while (changed) {
      changed = false;
      for (const entity of entities) {
        if (!entity.id || groundedIds.has(entity.id)) continue;
        if (!this.hasRepoScope(entity)) continue;
        const supports = this.stringArray(entity.derived_from_node_ids);
        if (supports.length > 0 && supports.every((id) => groundedIds.has(id))) {
          groundedIds.add(entity.id);
          changed = true;
        }
      }
    }

    return groundedIds;
  }

  private artifactTouchesIds(artifact: unknown, ids: Set<string>): boolean {
    if (ids.size === 0 || !artifact || typeof artifact !== "object") return false;
    const record = artifact as Record<string, unknown>;
    const scalarKeys = ["id", "dream_id", "from", "to", "source", "target"];
    for (const key of scalarKeys) {
      const value = record[key];
      if (typeof value === "string" && ids.has(value)) return true;
    }
    const arrayKeys = ["entities", "inspiration", "derived_from_node_ids", "affected_ids"];
    for (const key of arrayKeys) {
      const value = record[key];
      if (Array.isArray(value) && value.some((v) => typeof v === "string" && ids.has(v))) {
        return true;
      }
    }
    return false;
  }

  /**
   * Quarantine existing canonical/cognitive artifacts with no repository scope
   * or no provenance path back to repo evidence.
   *
   * This intentionally does NOT hard-code DreamGraph's own repository or any
   * assumed managed-project structure. The instance graph may describe any
   * project. The invariant is project-agnostic: canonical facts need at least
   * one `source_repo`, and source-less hubs are kept only when already
   * repo-scoped and derived from grounded source-backed/human/hub nodes.
   */
  async quarantineSourceLessFacts(): Promise<SourceLessFactQuarantineResult> {
    const timestamp = new Date().toISOString();
    const quarantineFilename = `source_less_fact_quarantine_${timestamp.replace(/[:.]/g, "-")}.json`;
    const quarantineFile = dataPath(quarantineFilename);

    const [features, workflows, dataModel, dreamGraph, candidates, validated, tensions] = await Promise.all([
      loadJsonArray<Feature>("features.json"),
      loadJsonArray<Workflow>("workflows.json"),
      loadJsonArray<DataModelEntity>("data_model.json"),
      this.loadDreamGraph(),
      this.loadCandidateEdges(),
      this.loadValidatedEdges(),
      this.loadTensions(),
    ]);

    const canonicalEntities = [
      ...features.filter((e) => !("_schema" in e)),
      ...workflows.filter((e) => !("_schema" in e)),
      ...dataModel.filter((e) => !("_schema" in e)),
    ] as ProvenanceCarrier[];
    const groundedIds = this.buildGroundedCanonicalIdSet(canonicalEntities);
    const canonicalIds = new Set(canonicalEntities.map((e) => e.id).filter((id): id is string => typeof id === "string"));
    const affectedNodeIds = new Set<string>();

    for (const entity of canonicalEntities) {
      if (!entity.id) continue;
      if (!groundedIds.has(entity.id)) affectedNodeIds.add(entity.id);
    }

    const invalidCanonical = (entity: ProvenanceCarrier): boolean => !!entity.id && affectedNodeIds.has(entity.id);
    const keepFeature = (entity: Feature): boolean => ("_schema" in entity) || !invalidCanonical(entity as ProvenanceCarrier);
    const keepWorkflow = (entity: Workflow): boolean => ("_schema" in entity) || !invalidCanonical(entity as ProvenanceCarrier);
    const keepDataModel = (entity: DataModelEntity): boolean => ("_schema" in entity) || !invalidCanonical(entity as ProvenanceCarrier);

    const nextFeatures = features.filter(keepFeature);
    const nextWorkflows = workflows.filter(keepWorkflow);
    const nextDataModel = dataModel.filter(keepDataModel);
    const quarantinedNodes = [
      ...features.filter((e) => !keepFeature(e)),
      ...workflows.filter((e) => !keepWorkflow(e)),
      ...dataModel.filter((e) => !keepDataModel(e)),
    ];

    // Dream artifacts are not canonical facts, but a source-less phantom cloud
    // can keep regenerating invalid facts/tensions. Quarantine dream nodes that
    // either are the invalid canonical IDs or are source-less and disconnected
    // from a grounded canonical support path.
    const quarantinedDreamNodes = dreamGraph.nodes.filter((node) => {
      if (affectedNodeIds.has(node.id)) return true;
      if (this.artifactTouchesIds(node, affectedNodeIds)) return true;
      const carrier = node as ProvenanceCarrier;
      if (this.hasRepoScope(carrier)) return false;
      const supports = this.stringArray(carrier.inspiration).concat(this.stringArray(carrier.derived_from_node_ids));
      return supports.length === 0 || !supports.every((id) => groundedIds.has(id));
    });
    for (const node of quarantinedDreamNodes) affectedNodeIds.add(node.id);

    const quarantinedDreamNodeIds = new Set(quarantinedDreamNodes.map((node) => node.id));
    const quarantinedDreamEdges = dreamGraph.edges.filter((edge) =>
      affectedNodeIds.has(edge.from) ||
      affectedNodeIds.has(edge.to) ||
      this.artifactTouchesIds(edge, affectedNodeIds) ||
      (!canonicalIds.has(edge.from) && !groundedIds.has(edge.from) && quarantinedDreamNodeIds.has(edge.from)) ||
      (!canonicalIds.has(edge.to) && !groundedIds.has(edge.to) && quarantinedDreamNodeIds.has(edge.to))
    );
    for (const edge of quarantinedDreamEdges) affectedNodeIds.add(edge.id);

    const quarantinedValidatedEdges = validated.edges.filter((edge) =>
      affectedNodeIds.has(edge.from) ||
      affectedNodeIds.has(edge.to) ||
      (canonicalIds.has(edge.from) && !groundedIds.has(edge.from)) ||
      (canonicalIds.has(edge.to) && !groundedIds.has(edge.to))
    );
    for (const edge of quarantinedValidatedEdges) affectedNodeIds.add(edge.id);

    const quarantinedCandidateResults = candidates.results.filter((result) =>
      this.artifactTouchesIds(result, affectedNodeIds)
    );

    const quarantinedActiveTensions = tensions.signals.filter((signal) =>
      this.artifactTouchesIds(signal, affectedNodeIds)
    );
    const quarantinedResolvedTensions = (tensions.resolved_tensions ?? []).filter((resolved) =>
      this.artifactTouchesIds(resolved, affectedNodeIds) ||
      this.artifactTouchesIds(resolved.original, affectedNodeIds)
    );

    const quarantineReport = {
      timestamp,
      invariant: "Canonical nodes require repo scope plus direct source files, explicit human assertion, or a grounded derived-hub chain. Hubs may connect to hubs when the chain reaches grounded repo nodes.",
      affected_node_ids: [...affectedNodeIds].sort(),
      canonical_nodes: quarantinedNodes,
      dream_nodes: quarantinedDreamNodes,
      dream_edges: quarantinedDreamEdges,
      validated_edges: quarantinedValidatedEdges,
      candidate_results: quarantinedCandidateResults,
      active_tensions: quarantinedActiveTensions,
      resolved_tensions: quarantinedResolvedTensions,
    };

    await withFileLock(quarantineFilename, async () => {
      await atomicWriteFile(quarantineFile, JSON.stringify(quarantineReport, null, 2));
    });

    const writeSeed = async (filename: string, data: unknown) => {
      await withFileLock(filename, async () => {
        await atomicWriteFile(dataPath(filename), JSON.stringify(data, null, 2));
      });
      invalidateCache(filename);
    };

    await Promise.all([
      writeSeed("features.json", nextFeatures),
      writeSeed("workflows.json", nextWorkflows),
      writeSeed("data_model.json", nextDataModel),
    ]);

    dreamGraph.nodes = dreamGraph.nodes.filter((node) => !quarantinedDreamNodes.some((q) => q.id === node.id));
    dreamGraph.edges = dreamGraph.edges.filter((edge) => !quarantinedDreamEdges.some((q) => q.id === edge.id));
    await this.saveDreamGraph(dreamGraph);

    candidates.results = candidates.results.filter((result) => !quarantinedCandidateResults.includes(result));
    await this.saveCandidateEdges(candidates);

    validated.edges = validated.edges.filter((edge) => !quarantinedValidatedEdges.includes(edge));
    validated.metadata.total_validated = validated.edges.length;
    await this.saveValidatedEdges(validated);

    tensions.signals = tensions.signals.filter((signal) => !quarantinedActiveTensions.includes(signal));
    tensions.resolved_tensions = (tensions.resolved_tensions ?? []).filter((resolved) => !quarantinedResolvedTensions.includes(resolved));
    await this.saveTensions(tensions);

    const entities: Record<string, IndexEntry> = {};
    for (const f of nextFeatures.filter((e) => !("_schema" in e))) {
      entities[f.id] = { type: "feature", uri: `dreamgraph://resource/feature/${f.id}`, name: f.name, source_repo: f.source_repo };
    }
    for (const w of nextWorkflows.filter((e) => !("_schema" in e))) {
      entities[w.id] = { type: "workflow", uri: `dreamgraph://resource/workflow/${w.id}`, name: w.name, source_repo: w.source_repo };
    }
    for (const d of nextDataModel.filter((e) => !("_schema" in e))) {
      entities[d.id] = { type: "data_model", uri: `dreamgraph://resource/data_model/${d.id}`, name: d.name, source_repo: d.source_repo };
    }
    // Slice 1 — first-class UI graph citizens. Only source-bound entries.
    for (const u of await loadIndexableUIElements()) {
      entities[u.id] = {
        type: "ui_element",
        uri: `dreamgraph://resource/ui_element/${u.id}`,
        name: u.name,
        source_repo: u.source_repo,
      };
    }
    const index: ResourceIndex = { entities };
    await withFileLock("index.json", async () => {
      await atomicWriteFile(dataPath("index.json"), JSON.stringify(index, null, 2));
    });
    invalidateCache("index.json");

    const result: SourceLessFactQuarantineResult = {
      quarantined_nodes: quarantinedNodes.length,
      quarantined_validated_edges: quarantinedValidatedEdges.length,
      quarantined_candidate_results: quarantinedCandidateResults.length,
      quarantined_dream_nodes: quarantinedDreamNodes.length,
      quarantined_dream_edges: quarantinedDreamEdges.length,
      quarantined_active_tensions: quarantinedActiveTensions.length,
      quarantined_resolved_tensions: quarantinedResolvedTensions.length,
      affected_node_ids: [...affectedNodeIds].sort(),
      quarantine_file: quarantineFile,
      timestamp,
    };

    logger.warn(
      `Source-less fact quarantine complete: ${result.quarantined_nodes} canonical nodes, ` +
      `${result.quarantined_dream_nodes} dream nodes, ${result.quarantined_dream_edges} dream edges, ` +
      `${result.quarantined_validated_edges} validated edges, ${result.quarantined_candidate_results} candidates, ` +
      `${result.quarantined_active_tensions + result.quarantined_resolved_tensions} tensions. Report: ${quarantineFile}`
    );

    return result;
  }

  async clearDreamGraph(): Promise<void> {
    await this.saveDreamGraph(this.emptyDreamGraphFile());
    logger.info("Dream graph cleared");
  }

  async clearCandidateEdges(): Promise<void> {
    await this.saveCandidateEdges(this.emptyCandidateEdgesFile());
    logger.info("Candidate edges cleared");
  }

  async clearValidatedEdges(): Promise<void> {
    await this.saveValidatedEdges(this.emptyValidatedEdgesFile());
    logger.info("Validated edges cleared");
  }

  async clearTensions(): Promise<void> {
    await this.saveTensions(this.emptyTensionFile());
    logger.info("Tension log cleared");
  }

  async clearHistory(): Promise<void> {
    await withFileLock("dream_history.json", async () => {
      await atomicWriteFile(historyPath(), JSON.stringify(this.emptyHistoryFile(), null, 2));
    });
    logger.info("Dream history cleared");
  }

  // -------------------------------------------------------------------------
  // Introspection (enhanced)
  // -------------------------------------------------------------------------

  async getStatus(): Promise<CognitiveState> {
    let dreamStats: CognitiveState["dream_graph_stats"] = {
      total_nodes: 0,
      total_edges: 0,
      latent_edges: 0,
      latent_nodes: 0,
      expiring_next_cycle: 0,
      avg_confidence: 0,
      avg_reinforcement: 0,
      avg_activation: 0,
    };
    let validatedStats = { validated: 0, latent: 0, rejected: 0 };
    let tensionStats: CognitiveState["tension_stats"] = {
      total: 0,
      unresolved: 0,
      top_urgency: null,
    };

    try {
      const dreamGraph = await this.loadDreamGraph();
      const edges = dreamGraph.edges;
      const nodes = dreamGraph.nodes;
      const allItems = [...edges, ...nodes];

      const expiringEdges = edges.filter((e) => (e.ttl ?? 3) <= 1).length;
      const expiringNodes = nodes.filter((n) => (n.ttl ?? 3) <= 1).length;

      const avgConf =
        allItems.length > 0
          ? allItems.reduce((sum, item) => sum + item.confidence, 0) / allItems.length
          : 0;

      const avgReinf =
        allItems.length > 0
          ? allItems.reduce((sum, item) => sum + (item.reinforcement_count ?? 0), 0) / allItems.length
          : 0;

      const latentEdges = edges.filter((e) => e.status === "latent").length;
      const latentNodes = nodes.filter((n) => n.status === "latent").length;

      const activationItems = allItems.filter((i) => (i.activation_score ?? 0) > 0);
      const avgActivation =
        activationItems.length > 0
          ? activationItems.reduce((sum, i) => sum + (i.activation_score ?? 0), 0) / activationItems.length
          : 0;

      dreamStats = {
        total_nodes: nodes.length,
        total_edges: edges.length,
        latent_edges: latentEdges,
        latent_nodes: latentNodes,
        expiring_next_cycle: expiringEdges + expiringNodes,
        avg_confidence: Math.round(avgConf * 100) / 100,
        avg_reinforcement: Math.round(avgReinf * 100) / 100,
        avg_activation: Math.round(avgActivation * 100) / 100,
      };
    } catch (err) {
      logger.debug(`getStatus: dream graph stats unavailable: ${err instanceof Error ? err.message : err}`);
    }

    try {
      const candidates = await this.loadCandidateEdges();
      for (const r of candidates.results) {
        if (r.status === "validated") validatedStats.validated++;
        else if (r.status === "latent") validatedStats.latent++;
        else validatedStats.rejected++;
      }
    } catch (err) {
      logger.debug(`getStatus: candidate edges stats unavailable: ${err instanceof Error ? err.message : err}`);
    }

    try {
      const tensions = await this.loadTensions();
      const unresolved = tensions.signals.filter((s) => !s.resolved);
      tensionStats = {
        total: tensions.signals.length,
        unresolved: unresolved.length,
        top_urgency:
          unresolved.length > 0
            ? unresolved.sort((a, b) => b.urgency - a.urgency)[0]
            : null,
      };
      // Phase 4 #8 — surface resolver pipeline stats. Best-effort.
      try {
        const pipeline = await this.getResolutionPipelineStats();
        if (pipeline.pending_candidates > 0 || pipeline.awaiting_validation > 0) {
          tensionStats.resolution_pipeline = pipeline;
        }
      } catch (err) {
        logger.debug(`getStatus: resolution pipeline stats unavailable: ${err instanceof Error ? err.message : err}`);
      }
    } catch (err) {
      logger.debug(`getStatus: tension stats unavailable: ${err instanceof Error ? err.message : err}`);
    }

    return {
      current_state: this.state,
      last_state_change: this.lastStateChange,
      total_dream_cycles: this.totalDreamCycles,
      total_normalization_cycles: this.totalNormalizationCycles,
      dream_graph_stats: dreamStats,
      validated_stats: validatedStats,
      tension_stats: tensionStats,
      last_dream_cycle: this.lastDreamCycle,
      last_normalization: this.lastNormalization,
      promotion_config: await (async () => {
        try {
          return await this.getEffectivePromotionConfig();
        } catch (err) {
          logger.debug(`getStatus: promotion config unavailable: ${err instanceof Error ? err.message : err}`);
          return DEFAULT_PROMOTION;
        }
      })(),
      decay_config: this.decayConfig,
      llm: await (async () => {
        try {
          const { getLlmProvider, getLlmConfig, getDreamerLlmConfig } = await import("./llm.js");
          const cfg = getLlmConfig();
          const provider = getLlmProvider();
          const available = await provider.isAvailable();
          return {
            provider: cfg.provider,
            model: getDreamerLlmConfig().model,
            available,
          };
        } catch (err) {
          logger.debug(`getStatus: LLM info unavailable: ${err instanceof Error ? err.message : err}`);
          return { provider: "none", model: "", available: false };
        }
      })(),
      // ADR-096: surface cold-start bootstrap status only once normalization
      // has actually run at least once (otherwise the field would be
      // misleading on a fresh, dormant instance).
      bootstrap:
        this.bootstrapStartedAt !== null || this.bootstrapState === "graduated"
          ? this.getBootstrapStatus()
          : undefined,
      // ADR-098 (Slice 2A): surface live LLM-readiness probe state. May be
      // null if the watcher hasn't completed its first probe yet.
      llm_readiness: getLlmReadinessStatus() ?? undefined,
      // ADR-098 (Slice 2B): per-fingerprint bootstrap audit log. Compact
      // tail (last 5 entries) keeps `cognitive_status` light for dashboards;
      // forensic consumers should read `data/llm_bootstrap_log.json`.
      bootstrap_history: await (async () => {
        try {
          const { getBootstrapHistory } = await import("./bootstrap-registry.js");
          const all = await getBootstrapHistory();
          return {
            total: all.length,
            recent: all.slice(-5),
          };
        } catch (err) {
          logger.debug(
            `getStatus: bootstrap history unavailable: ${err instanceof Error ? err.message : err}`,
          );
          return undefined;
        }
      })(),
    };
  }

  // -------------------------------------------------------------------------
  // Curated user mutations (Explorer Phase 4 / Slice 2)
  //
  // These three methods bypass the normal `assertState("normalizing")` gate
  // because they're driven by a human reviewer through the Explorer, not by
  // the autonomous dream loop. They are the *only* engine entry points the
  // mutation service is allowed to call. Each one:
  //   - leaves the state machine untouched
  //   - persists with the same locks the autonomous paths use
  //   - emits the same graph events (so existing consumers keep working)
  //   - returns enough data for the audit row (`affected_ids`)
  // -------------------------------------------------------------------------

  /**
   * Resolve a tension on behalf of a human operator. Wraps the existing
   * `resolveTension` (which already has no state precondition) so the
   * Explorer can call it from AWAKE.
   */
  async userResolveTension(
    tensionId: string,
    opts: {
      resolution_type?: TensionResolutionType;
      evidence?: string;
    } = {},
  ): Promise<{ resolved: ResolvedTension | null; affected_ids: string[] }> {
    const resolved = await this.resolveTension(
      tensionId,
      "human",
      opts.resolution_type ?? "confirmed_fixed",
      opts.evidence,
    );
    if (!resolved) return { resolved: null, affected_ids: [tensionId] };
    return {
      resolved,
      affected_ids: [tensionId, ...(resolved.original.entities ?? [])],
    };
  }

  /**
   * Promote a candidate (latent dream edge) into the validated edge store.
   * Locates the originating `DreamEdge` by `dream_id`, builds the
   * `ValidatedEdge`, removes the candidate's `ValidationResult`, persists
   * both files, and emits `candidate.promoted`.
   */
  async userPromoteCandidate(
    dreamId: string,
  ): Promise<{
    edge: ValidatedEdge | null;
    affected_ids: string[];
    candidate?: ValidationResult;
  }> {
    const candidates = await this.loadCandidateEdges();
    const idx = candidates.results.findIndex((r) => r.dream_id === dreamId);
    if (idx === -1) return { edge: null, affected_ids: [dreamId] };
    const candidate = candidates.results[idx];

    const dreamGraph = await this.loadDreamGraph();
    const dreamEdge = dreamGraph.edges.find((e) => e.id === dreamId);
    if (!dreamEdge) {
      logger.warn(
        `userPromoteCandidate: dream edge ${dreamId} missing from dream_graph.json — cannot promote`,
      );
      return { edge: null, affected_ids: [dreamId], candidate };
    }

    // Build a ValidatedEdge from the dream edge + the candidate's score.
    const promotedAt = new Date().toISOString();
    const validatedType: ValidatedEdge["type"] =
      dreamEdge.type === "feature" || dreamEdge.type === "workflow" || dreamEdge.type === "data_model"
        ? dreamEdge.type
        : "feature";
    const validatedEdge: ValidatedEdge = {
      id: `validated_${dreamEdge.id}`,
      from: dreamEdge.from,
      to: dreamEdge.to,
      type: validatedType,
      relation: dreamEdge.relation,
      description: dreamEdge.reason,
      confidence: candidate.confidence,
      plausibility: candidate.plausibility,
      evidence_score: candidate.evidence_score,
      origin: "rem",
      status: "validated",
      evidence_summary: candidate.reason,
      evidence_count: candidate.evidence_count,
      reinforcement_count: dreamEdge.reinforcement_count,
      dream_cycle: dreamEdge.dream_cycle,
      normalization_cycle: candidate.normalization_cycle,
      validated_at: promotedAt,
    };

    const validated = await this.loadValidatedEdges();
    validated.edges.push(validatedEdge);
    validated.metadata.last_validation = promotedAt;
    validated.metadata.total_validated = validated.edges.length;
    await this.saveValidatedEdges(validated);

    candidates.results.splice(idx, 1);
    candidates.metadata.last_normalization = promotedAt;
    await this.saveCandidateEdges(candidates);

    logger.info(`User-promoted candidate ${dreamId} → validated edge`);
    graphEventBus.emit("candidate.promoted", {
      affected_ids: [validatedEdge.from, validatedEdge.to].filter(Boolean) as string[],
      payload: {
        from: validatedEdge.from,
        to: validatedEdge.to,
        confidence: validatedEdge.confidence,
        actor: "user",
      },
    });

    return {
      edge: validatedEdge,
      affected_ids: [dreamId, validatedEdge.from, validatedEdge.to].filter(Boolean) as string[],
      candidate,
    };
  }

  /**
   * Reject a candidate (flip its `ValidationResult.status` to "rejected"
   * and persist). Does not delete — provenance is preserved. Emits
   * `candidate.rejected`.
   */
  async userRejectCandidate(
    dreamId: string,
  ): Promise<{ candidate: ValidationResult | null; affected_ids: string[] }> {
    const candidates = await this.loadCandidateEdges();
    const candidate = candidates.results.find((r) => r.dream_id === dreamId);
    if (!candidate) return { candidate: null, affected_ids: [dreamId] };

    candidate.status = "rejected";
    candidates.metadata.last_normalization = new Date().toISOString();
    await this.saveCandidateEdges(candidates);

    logger.info(`User-rejected candidate ${dreamId}`);
    graphEventBus.emit("candidate.rejected", {
      affected_ids: [dreamId],
      payload: {
        dream_id: dreamId,
        dream_type: candidate.dream_type,
      },
    });

    return { candidate, affected_ids: [dreamId] };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize an edge into a canonical key for deduplication.
 *  Key = sorted(from, to) + relation base (strip "strengthened_", "reverse_of_", etc.)
 */
function normalizeEdgeKey(edge: DreamEdge): string {
  const pair = [edge.from, edge.to].sort().join("|");
  // Strip common prefixes that indicate the same underlying relationship
  const baseRelation = edge.relation
    .replace(/^strengthened_/, "")
    .replace(/^reverse_of_/, "")
    .replace(/^potential_/, "")
    .replace(/^cross_domain_bridge_\w+_\w+$/, "cross_domain_bridge");
  return `${pair}:${baseRelation}`;
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const engine = new CognitiveEngine();
