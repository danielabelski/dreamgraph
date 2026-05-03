/**
 * LLM-readiness watcher (ADR-098, Slice 2A).
 *
 * Periodically tests whether the configured LLM is actually usable, not just
 * whether env vars are populated. "Ready" requires three conditions, in this
 * order (cheapest first, short-circuited):
 *
 *   1. Effective base model resolves to a non-empty string.
 *   2. Effective dreamer model resolves to a non-empty string.
 *      (Falls back to base via parseComponentConfig when no override set.)
 *   3. Effective normalizer model resolves to a non-empty string.
 *      (Same fallback rule.)
 *   4. A real `complete()` call against the provider returns successfully.
 *
 * The completion call is deliberately tiny (≤ 8 output tokens, single-token
 * answer) to keep token cost trivial. ADR-098 guard rail #1 mandates a real
 * call — env-var presence is not sufficient evidence.
 *
 * Slice 2A scope: probe + status surfacing only. Bootstrap-firing on the
 * ready transition is Slice 2B.
 *
 * Fingerprint: sha256(provider | baseUrl | dreamerModel | normalizerModel).
 * It deliberately excludes the API key (so key rotation doesn't force a
 * re-bootstrap) and includes baseUrl (so endpoint changes — local dev → cloud
 * — DO trigger re-enrichment, per ADR-098 risk mitigation).
 */

import { createHash } from "node:crypto";
import { logger } from "../utils/logger.js";
import {
  getDreamerLlmConfig,
  getLlmConfig,
  getLlmProvider,
  getNormalizerLlmConfig,
  type LlmMessage,
} from "./llm.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LlmReadinessState = "unknown" | "not_ready" | "ready";

export type LlmReadinessReason =
  | "missing_base_model"
  | "missing_dreamer_model"
  | "missing_normalizer_model"
  | "completion_failed"
  | "ok";

export interface LlmReadinessEffectiveConfig {
  provider: string;
  base_url: string;
  base_model: string;
  dreamer_model: string;
  normalizer_model: string;
}

export interface LlmReadinessStatus {
  state: LlmReadinessState;
  /** sha256 over provider+url+dreamer_model+normalizer_model. */
  fingerprint: string | null;
  /** Snapshot of resolved models — useful for dashboards. */
  effective: LlmReadinessEffectiveConfig | null;
  /** Last machine-readable reason. */
  reason: LlmReadinessReason;
  /** Last human-readable error (provider message), if any. */
  last_error: string | null;
  last_check_at: string | null;
  /** ISO timestamp of the last state CHANGE (not every probe). */
  transitioned_at: string | null;
  /** Consecutive failed probes since the last successful one. */
  consecutive_failures: number;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _status: LlmReadinessStatus | null = null;
let _timer: NodeJS.Timeout | null = null;
let _inFlight = false;

/**
 * Subscribers fired on every transition INTO the `ready` state OR while
 * already ready when the fingerprint changes. They receive both the new and
 * previous status so they can decide between "first-time bootstrap" and
 * "config change while populated". Errors thrown by subscribers are caught
 * and logged so one bad subscriber can't stall the watcher.
 */
export type ReadyTransitionHandler = (
  current: LlmReadinessStatus,
  previous: LlmReadinessStatus | null,
) => void | Promise<void>;

const _readySubscribers: ReadyTransitionHandler[] = [];

const DEFAULT_INTERVAL_MS = 30_000;
const MIN_INTERVAL_MS = 5_000;
const PROBE_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

export function computeLlmFingerprint(cfg: LlmReadinessEffectiveConfig): string {
  const material = [cfg.provider, cfg.base_url, cfg.dreamer_model, cfg.normalizer_model].join("|");
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

function snapshotEffectiveConfig(): LlmReadinessEffectiveConfig {
  const base = getLlmConfig();
  const dreamer = getDreamerLlmConfig();
  const normalizer = getNormalizerLlmConfig();
  return {
    provider: base.provider,
    base_url: base.baseUrl ?? "",
    base_model: base.model ?? "",
    dreamer_model: dreamer.model ?? "",
    normalizer_model: normalizer.model ?? "",
  };
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/**
 * Run one readiness probe. Pure-ish: mutates the singleton status and logs
 * transitions, but does not fire any side effects (events, bootstrap chain).
 * Returns the resulting status.
 */
export async function probeLlmReadiness(): Promise<LlmReadinessStatus> {
  const effective = snapshotEffectiveConfig();
  const fingerprint = computeLlmFingerprint(effective);
  const now = new Date().toISOString();
  const previous = _status;

  // Step 1-3: model resolution check (cheap, no network).
  let reason: LlmReadinessReason = "ok";
  let lastError: string | null = null;
  if (!effective.base_model.trim()) reason = "missing_base_model";
  else if (!effective.dreamer_model.trim()) reason = "missing_dreamer_model";
  else if (!effective.normalizer_model.trim()) reason = "missing_normalizer_model";

  let state: LlmReadinessState = "not_ready";

  if (reason === "ok") {
    // Step 4: real completion call. Tiny prompt, tiny output.
    const probeMessages: LlmMessage[] = [
      { role: "user", content: "Reply with exactly: ok" },
    ];
    try {
      const provider = getLlmProvider();
      const probeOnce = provider.complete(probeMessages, { maxTokens: 8, temperature: 0 });
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`probe timeout after ${PROBE_TIMEOUT_MS}ms`)), PROBE_TIMEOUT_MS);
      });
      await Promise.race([probeOnce, timeout]);
      state = "ready";
    } catch (err) {
      state = "not_ready";
      reason = "completion_failed";
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  const consecutiveFailures =
    state === "ready" ? 0 : (previous?.consecutive_failures ?? 0) + 1;

  const transitioned =
    !previous ||
    previous.state !== state ||
    previous.fingerprint !== fingerprint;

  const next: LlmReadinessStatus = {
    state,
    fingerprint,
    effective,
    reason,
    last_error: lastError,
    last_check_at: now,
    transitioned_at: transitioned ? now : (previous?.transitioned_at ?? now),
    consecutive_failures: consecutiveFailures,
  };

  _status = next;

  // Fire ready-transition subscribers (ADR-098 Slice 2B). We notify on:
  //   (a) any ↑ ready transition (was not ready, now ready), AND
  //   (b) ready → ready when the fingerprint changed (config rotation).
  // Subscribers are fire-and-forget; their errors are logged, not propagated.
  const becameReady = state === "ready" && previous?.state !== "ready";
  const fingerprintRotated =
    state === "ready" &&
    previous?.state === "ready" &&
    previous.fingerprint !== fingerprint;
  if (becameReady || fingerprintRotated) {
    for (const handler of _readySubscribers) {
      Promise.resolve()
        .then(() => handler(next, previous))
        .catch((err) => {
          logger.error(
            `LLM readiness subscriber error: ${err instanceof Error ? err.message : err}`,
          );
        });
    }
  }

  if (transitioned) {
    if (previous) {
      logger.info(
        `LLM readiness: ${previous.state} → ${state} ` +
          `(reason=${reason}, fingerprint=${fingerprint}, models=${effective.dreamer_model}/${effective.normalizer_model})` +
          (lastError ? ` — ${lastError}` : "")
      );
    } else {
      logger.info(
        `LLM readiness: initial state=${state} ` +
          `(reason=${reason}, fingerprint=${fingerprint}, models=${effective.dreamer_model}/${effective.normalizer_model})` +
          (lastError ? ` — ${lastError}` : "")
      );
    }
  }

  return next;
}

// ---------------------------------------------------------------------------
// Public getters
// ---------------------------------------------------------------------------

/** Returns the most recent readiness status, or null if no probe has run yet. */
export function getLlmReadinessStatus(): LlmReadinessStatus | null {
  return _status;
}

/**
 * Register a handler invoked whenever the watcher observes a transition into
 * `ready` (or a fingerprint rotation while already ready). Returns an
 * unsubscribe function. Subscribers are not invoked retroactively for
 * transitions that happened before they registered.
 */
export function onLlmReadinessReady(handler: ReadyTransitionHandler): () => void {
  _readySubscribers.push(handler);
  return () => {
    const idx = _readySubscribers.indexOf(handler);
    if (idx >= 0) _readySubscribers.splice(idx, 1);
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Start the periodic readiness watcher. Idempotent — calling twice replaces
 * the existing timer. Runs an immediate probe (non-blocking) on start.
 */
export function startLlmReadinessWatcher(intervalMs?: number): void {
  const envInterval = process.env.DREAMGRAPH_LLM_READINESS_INTERVAL_MS
    ? parseInt(process.env.DREAMGRAPH_LLM_READINESS_INTERVAL_MS, 10)
    : undefined;
  const requested = intervalMs ?? envInterval ?? DEFAULT_INTERVAL_MS;
  const interval = Math.max(MIN_INTERVAL_MS, requested);

  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }

  const runOnce = (): void => {
    if (_inFlight) return;
    _inFlight = true;
    probeLlmReadiness()
      .catch((err) => {
        logger.error(`LLM readiness probe error: ${err instanceof Error ? err.message : err}`);
      })
      .finally(() => {
        _inFlight = false;
      });
  };

  // Immediate probe so cognitive_status reflects state on first call.
  runOnce();

  _timer = setInterval(runOnce, interval);
  if (typeof _timer === "object" && _timer && "unref" in _timer) {
    _timer.unref();
  }

  logger.info(`LLM readiness watcher started (interval=${interval}ms)`);
}

export function stopLlmReadinessWatcher(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    logger.info("LLM readiness watcher stopped");
  }
}
