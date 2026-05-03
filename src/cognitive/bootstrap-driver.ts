/**
 * Bootstrap driver (ADR-098, Slice 2B).
 *
 * Wires the LLM-readiness watcher to the legacy `bootstrapNewInstance()`
 * chain. Fires automatically on the first observed `→ ready` transition for
 * each unique LLM fingerprint, subject to ADR-098 guard rails:
 *
 *   1. Bootstrap fires at most once per fingerprint per instance — enforced
 *      by `llm_bootstrap_log.json` (bootstrap-registry).
 *   2. A fingerprint change (provider/model/endpoint rotation) MUST NOT
 *      trigger a full source re-scan. Until Slice 2C ships an enrich-only
 *      path, fingerprint rotations on already-populated instances are
 *      logged + skipped (operator can run `dg bootstrap` manually).
 *   3. Existing entity ids MUST be preserved across re-enrichment — for the
 *      first-bootstrap path this is implicit (the chain is upsert by id).
 *
 * The driver is stateless (registry is the source of truth); a daemon
 * restart re-evaluates fingerprint history on the next ready transition.
 */

import { logger } from "../utils/logger.js";
import { onLlmReadinessReady, type LlmReadinessStatus } from "./llm-readiness.js";
import {
  bootstrapNewInstance,
  isFreshInstance,
  runReEnrichment,
} from "../instance/bootstrap.js";
import {
  hasFingerprintBeenSeen,
  recordBootstrap,
  type BootstrapKind,
} from "./bootstrap-registry.js";

let _wired = false;

/**
 * Subscribe the bootstrap chain to the readiness watcher. Idempotent —
 * calling twice is a no-op so the daemon's startup chain stays safe under
 * test reloads.
 */
export function wireBootstrapOnReady(): void {
  if (_wired) return;
  _wired = true;

  onLlmReadinessReady(async (current, previous) => {
    if (current.state !== "ready" || !current.fingerprint || !current.effective) return;

    const fingerprint = current.fingerprint;
    const eff = current.effective;
    const wasReadyBefore = previous?.state === "ready";

    // ADR-098 guard rail #1 — exactly once per fingerprint.
    if (await hasFingerprintBeenSeen(fingerprint)) {
      logger.debug(
        `[bootstrap-driver] fingerprint ${fingerprint} already recorded — skipping`,
      );
      return;
    }

    // Determine the appropriate bootstrap kind.
    const fresh = await isFreshInstance();

    let kind: BootstrapKind;
    let success = false;
    let outcome = "";

    if (!fresh && !wasReadyBefore) {
      // Already-populated instance, daemon just came up with a working LLM
      // for the first time. No new chain to fire — record the fingerprint as
      // observed so we don't re-evaluate on every restart.
      kind = "skipped_not_fresh";
      success = true;
      outcome = "instance already populated; recording fingerprint without re-bootstrap";
      logger.info(
        `[bootstrap-driver] LLM ready (fingerprint=${fingerprint}) — instance already has seed data, skipping auto-bootstrap`,
      );
    } else if (!fresh && wasReadyBefore) {
      // Fingerprint rotated on a populated instance. ADR-098 guard rail #2
      // forbids a re-scan; Slice 2C delivers the re-enrichment-only path
      // (refreshes ADR discovery against the new model). Existing entity
      // ids are preserved automatically (guard rail #3).
      kind = "re_enrich_skipped"; // overwritten below if re-enrichment runs
      try {
        const re = await runReEnrichment();
        if (re.ran) {
          kind = "re_enrich_skipped"; // semantic: scan was skipped, enrich ran
          success = true;
          outcome = `fingerprint rotated → re-enrichment ok: ${re.adrs_recorded} new ADRs (${re.total_adrs} total)`;
          logger.info(
            `[bootstrap-driver] LLM fingerprint rotated to ${fingerprint} — ${outcome}`,
          );
        } else {
          success = false;
          outcome = `fingerprint rotated but re-enrichment did not run: ${re.reason}`;
          logger.warn(`[bootstrap-driver] ${outcome}`);
        }
      } catch (err) {
        success = false;
        outcome = `fingerprint rotated but re-enrichment threw: ${
          err instanceof Error ? err.message : String(err)
        }`;
        logger.error(`[bootstrap-driver] ${outcome}`);
      }
    } else {
      // Fresh instance + ready LLM: fire the full chain.
      kind = "full";
      logger.info(
        `[bootstrap-driver] Fresh instance + LLM ready (fingerprint=${fingerprint}) — firing bootstrap chain`,
      );
      try {
        await bootstrapNewInstance();
        success = true;
        outcome = "bootstrapNewInstance completed";
      } catch (err) {
        success = false;
        outcome = `bootstrapNewInstance failed: ${
          err instanceof Error ? err.message : String(err)
        }`;
        logger.error(`[bootstrap-driver] ${outcome}`);
      }
    }

    await recordBootstrap({
      fingerprint,
      effective: {
        provider: eff.provider,
        base_url: eff.base_url,
        dreamer_model: eff.dreamer_model,
        normalizer_model: eff.normalizer_model,
      },
      kind,
      observed_at: current.last_check_at ?? new Date().toISOString(),
      outcome,
      success,
    });
  });

  logger.info("[bootstrap-driver] Subscribed to LLM readiness transitions");
}

/**
 * Test/utility helper — exposes the driver state so tests can reset between
 * cases. Not part of the production surface.
 */
export function _resetBootstrapDriverForTests(): void {
  _wired = false;
}

/**
 * Re-export for convenience: callers that need to know whether the registry
 * has seen a given LLM config can use the registry directly.
 */
export type { LlmReadinessStatus };
