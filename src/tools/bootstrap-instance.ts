/**
 * `bootstrap_instance` MCP tool — ADR-098 Slice 2C.
 *
 * Manual escape hatch for the LLM-readiness bootstrap chain. Required by
 * ADR-098 guard rail #4 ("`dg bootstrap` CLI verb MUST remain available as
 * a manual override"). Backs the `dg bootstrap` CLI verb.
 *
 * Modes:
 *   - "auto" (default): run full bootstrap on a fresh instance, otherwise
 *     run re-enrichment only. Mirrors the auto-driver behavior.
 *   - "full":  always run the full chain (scan + enrich + ADR discovery +
 *     follow-up dreams). Use this when the operator explicitly wants a
 *     rescan; the tool will still skip if no LLM is configured.
 *   - "re_enrich": always run re-enrichment only — never rescan. Honors
 *     ADR-098 guard rail #2.
 *
 * The tool is idempotent on outcome (the bootstrap-registry records the
 * fingerprint either way), but `force=true` will run the work again even
 * when the registry already has an entry for the current fingerprint.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "../utils/logger.js";
import { success, error, safeExecute } from "../utils/errors.js";
import type { ToolResponse } from "../types/index.js";
import {
  bootstrapNewInstance,
  isFreshInstance,
  runReEnrichment,
} from "../instance/bootstrap.js";
import { probeLlmReadiness } from "../cognitive/llm-readiness.js";
import {
  hasFingerprintBeenSeen,
  recordBootstrap,
} from "../cognitive/bootstrap-registry.js";

interface BootstrapInstanceResult {
  mode: "auto" | "full" | "re_enrich";
  resolved_kind: "full" | "re_enrich" | "skipped_no_llm" | "skipped_already_done";
  llm_ready: boolean;
  fingerprint: string | null;
  was_fresh_instance: boolean;
  adrs_recorded?: number;
  message: string;
}

export function registerBootstrapInstanceTool(server: McpServer): void {
  server.tool(
    "bootstrap_instance",
    "ADR-098 manual bootstrap override. Forces the LLM-driven bootstrap chain " +
      "(or just the re-enrichment portion) regardless of whether the LLM-readiness " +
      "watcher has already auto-fired. Required by ADR-098 guard rail #4 as the " +
      "operator escape hatch. Modes: 'auto' picks full-or-re_enrich based on " +
      "instance freshness; 'full' always rescans + enriches + records ADRs; " +
      "'re_enrich' refreshes model-derived metadata only (no source rescan, " +
      "preserves entity ids — guard rails #2 and #3).",
    {
      mode: z
        .enum(["auto", "full", "re_enrich"])
        .default("auto")
        .describe(
          "auto: full on fresh instance, re_enrich on populated instance. " +
            "full: always rescan + enrich (only safe on stable codebases). " +
            "re_enrich: model metadata only, never rescans.",
        ),
      force: z
        .boolean()
        .default(false)
        .describe(
          "When true, bypass the bootstrap-registry's fingerprint dedupe and run the " +
            "selected mode even if it was already recorded for this fingerprint.",
        ),
    },
    async ({ mode, force }) => {
      logger.info(`bootstrap_instance: mode=${mode}, force=${force}`);

      const result = await safeExecute<BootstrapInstanceResult>(
        async (): Promise<ToolResponse<BootstrapInstanceResult>> => {
          // Force a fresh readiness probe so the operator's mental model
          // matches what the tool sees — don't rely on a stale 30s cache.
          const status = await probeLlmReadiness();
          const fingerprint = status.fingerprint;
          const llmReady = status.state === "ready";

          if (!llmReady) {
            const msg = `LLM not ready (state=${status.state}, reason=${status.reason}${
              status.last_error ? `: ${status.last_error}` : ""
            }). Configure provider credentials and try again.`;
            return error("LLM_NOT_READY", msg);
          }

          // ADR-098 guard rail #1: dedupe unless explicitly overridden.
          if (
            !force &&
            fingerprint &&
            (await hasFingerprintBeenSeen(fingerprint))
          ) {
            return success<BootstrapInstanceResult>({
              mode,
              resolved_kind: "skipped_already_done",
              llm_ready: true,
              fingerprint,
              was_fresh_instance: false,
              message:
                `Fingerprint ${fingerprint} already recorded in bootstrap registry. ` +
                "Pass force=true (CLI: --force) to re-run anyway.",
            });
          }

          const fresh = await isFreshInstance();
          let resolvedMode: "full" | "re_enrich";
          if (mode === "full") resolvedMode = "full";
          else if (mode === "re_enrich") resolvedMode = "re_enrich";
          else resolvedMode = fresh ? "full" : "re_enrich";

          let adrsRecorded: number | undefined;
          let outcome: string;
          let success_ = false;

          if (resolvedMode === "full") {
            try {
              await bootstrapNewInstance();
              success_ = true;
              outcome = "full bootstrap chain completed";
            } catch (err) {
              outcome = `full bootstrap failed: ${
                err instanceof Error ? err.message : String(err)
              }`;
              logger.error(`bootstrap_instance: ${outcome}`);
            }
          } else {
            const re = await runReEnrichment();
            adrsRecorded = re.adrs_recorded;
            success_ = re.ran;
            outcome = re.ran
              ? `re-enrichment ok: ${re.adrs_recorded} new ADRs (${re.total_adrs} total)`
              : `re-enrichment skipped: ${re.reason}`;
          }

          // Always record the manual run so the registry stays authoritative.
          if (fingerprint && status.effective) {
            await recordBootstrap({
              fingerprint,
              effective: {
                provider: status.effective.provider,
                base_url: status.effective.base_url,
                dreamer_model: status.effective.dreamer_model,
                normalizer_model: status.effective.normalizer_model,
              },
              kind: "manual",
              observed_at: new Date().toISOString(),
              outcome,
              success: success_,
            });
          }

          if (!success_) {
            return error("BOOTSTRAP_FAILED", outcome);
          }

          return success<BootstrapInstanceResult>({
            mode,
            resolved_kind: resolvedMode,
            llm_ready: true,
            fingerprint,
            was_fresh_instance: fresh,
            adrs_recorded: adrsRecorded,
            message: outcome,
          });
        },
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );
}
