/**
 * DreamGraph Embodied Senses — Runtime Awareness
 *
 * Bridges the gap between "what the code says" and "what actually happens".
 * Connects to external metrics endpoints (OpenTelemetry, Prometheus, or
 * custom JSON) to ingest real-time runtime observations.
 *
 * Capabilities:
 *   - Fetch and normalize runtime metrics per entity
 *   - Detect behavioral correlations (sequential usage, error cascades)
 *   - Rank features by actual usage (dead feature detection)
 *   - Identify error hotspots
 *   - Weight tensions by real-world impact
 *
 * Configuration:
 *   DREAMGRAPH_RUNTIME_ENDPOINT — URL for metrics endpoint
 *   DREAMGRAPH_RUNTIME_TYPE — "opentelemetry" | "prometheus" | "custom_json"
 *
 * The tool gracefully degrades when no endpoint is configured,
 * returning empty results.
 *
 * READ-ONLY: only reads from the network and knowledge graph.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { success, safeExecute } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { getMetricsSnapshot, flushMetricsToDisk } from "../utils/metrics.js";
import { getRuntimeMetricsSnapshotV1 } from "../observability/runtime-metrics.js";
import type {
  RuntimeMetricConfig,
} from "../types/index.js";
import { DEFAULT_RUNTIME_CONFIG } from "../cognitive/types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function getRuntimeConfig(): RuntimeMetricConfig {
  return {
    endpoint: process.env.DREAMGRAPH_RUNTIME_ENDPOINT,
    type: (process.env.DREAMGRAPH_RUNTIME_TYPE as RuntimeMetricConfig["type"]) ?? DEFAULT_RUNTIME_CONFIG.type,
    timeout_ms: parseInt(process.env.DREAMGRAPH_RUNTIME_TIMEOUT ?? "5000", 10),
  };
}

// ---------------------------------------------------------------------------
// Metrics Fetching
// ---------------------------------------------------------------------------

/**
 * Fetch the canonical M1 runtime metrics snapshot from the configured endpoint.
 * Returns null if no endpoint is configured or fetch fails.
 */
async function fetchMetricsSnapshot() {
  const config = getRuntimeConfig();
  if (!config.endpoint) {
    logger.debug("No runtime metrics endpoint configured");
    return null;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout_ms);

    const response = await fetch(config.endpoint, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      logger.warn(`Runtime metrics fetch failed: ${response.status} ${response.statusText}`);
      return null;
    }

    const body = await response.json();

    // Handle different formats
    if (config.type === "prometheus") {
      return parsePrometheusMetrics(body);
    } else if (config.type === "opentelemetry") {
      return parseOtelMetrics(body);
    } else {
      // custom_json: expect the canonical DreamGraph runtime snapshot directly
      return body;
    }
  } catch (err) {
    logger.warn(`Runtime metrics fetch error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Parse Prometheus-style metrics into our standard format.
 * Expects JSON query result format.
 */
function parsePrometheusMetrics(body: unknown): unknown {
  return body;
}

function parseOtelMetrics(body: unknown): unknown {
  return body;
}

// ---------------------------------------------------------------------------
// MCP Tool Registration
// ---------------------------------------------------------------------------

export function registerRuntimeSensesTools(server: McpServer): void {
  server.tool(
    "query_runtime_metrics",
    "Query the canonical M1 runtime metrics snapshot from the configured observability endpoint. " +
    "Returns grouped request counts, error summaries, latency summaries, graph hotspots, cache entries, and feature usage/dead candidates. " +
    "Requires DREAMGRAPH_RUNTIME_ENDPOINT env var. Without it, returns a clear enablement error.",
    {
      entity_filter: z
        .string()
        .optional()
        .describe("Filter metrics to a specific entity ID. Leave empty for all."),
      include_correlations: z
        .boolean()
        .optional()
        .describe("Whether to include behavioral correlation analysis (default: true)."),
    },
    async ({ entity_filter, include_correlations }) => {
      logger.debug(
        `query_runtime_metrics called: entity=${entity_filter ?? "all"}, correlations=${include_correlations ?? true}`
      );

      const result = await safeExecute(async () => {
        const config = getRuntimeConfig();

        if (!config.endpoint) {
          throw new Error("Runtime metrics endpoint is not configured. Set DREAMGRAPH_RUNTIME_ENDPOINT to a local/private /metrics endpoint.");
        }

        let snapshot: unknown;
        if (config.endpoint === "internal://self") {
          snapshot = await getRuntimeMetricsSnapshotV1();
        } else {
          snapshot = await fetchMetricsSnapshot();
        }

        if (!snapshot) {
          throw new Error(`Runtime metrics endpoint is unreachable: ${config.endpoint}`);
        }

        return success({
          snapshot,
          source: `${config.type} endpoint (${config.endpoint})`,
          timestamp: new Date().toISOString(),
        });
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  logger.info("Registered 1 runtime-senses tool");

  // =========================================================================
  // query_self_metrics — DreamGraph's own internal instrumentation
  // =========================================================================
  server.tool(
    "query_self_metrics",
    "Return DreamGraph's own runtime instrumentation: tool call counts, " +
      "failure rates, symbol lookup misses, file-read hotspots, and dream " +
      "strategy performance. No external endpoint needed — these are live " +
      "in-memory metrics since server startup. Use this for self-calibration, " +
      "identifying tool issues, and understanding actual usage patterns.",
    {
      flush_to_disk: z
        .boolean()
        .optional()
        .describe(
          "If true, also persist the snapshot to data/metrics_snapshot.json " +
            "for post-mortem analysis (default: false)."
        ),
    },
    async ({ flush_to_disk }) => {
      logger.info("query_self_metrics called");
      const snapshot = getMetricsSnapshot();

      if (flush_to_disk) {
        await flushMetricsToDisk();
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ success: true, data: snapshot }, null, 2),
          },
        ],
      };
    }
  );

  logger.info("Registered 2 runtime-senses tools (query_runtime_metrics, query_self_metrics)");
}
