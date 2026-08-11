/**
 * `dg enrich` — High-level graph coverage operation.
 *
 * Calls scan_project (deep mode by default) and enrich_parser_nodes on a
 * running daemon to expand graph coverage and refresh rich semantic data for
 * every canonical graph node.
 */

import type { ParsedArgs } from "../dg.js";
import {
  resolveInstanceForCommand,
  readServerMeta,
  isProcessAlive,
} from "../utils/daemon.js";
import { mcpCallTool } from "../utils/mcp-call.js";

/** Deep project scans and mandatory per-node enrichment can be expensive. */
const SCAN_TIMEOUT_MS = 7_200_000;
/** Enrichment hits the LLM in batches; large graphs can take a while. */
const ENRICH_TIMEOUT_MS = 7_200_000;

/**
 * Parse the text payload of an MCP tool response. Tool errors (e.g. schema
 * validation failures, daemon errors) arrive as plain strings prefixed with
 * `MCP error <code>:` — not JSON. Surface those verbatim rather than letting
 * `JSON.parse` blow up with an opaque "Unexpected token" message.
 */
function parseToolPayload(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }
  throw new Error(trimmed);
}

/**
 * Map the comma-separated `--targets` flag onto the graph-wide enrichment
 * target enum. Multiple stores deliberately resolve to `all` so relation
 * discovery retains complete cross-store context.
 */
function mapEnrichTarget(flag: unknown): {
  target: "features" | "workflows" | "data_model" | "capabilities" | "ui" | "datastores" | "auxiliary" | "all";
  ignoredTargets: string[];
} {
  if (typeof flag !== "string" || flag.trim() === "") {
    return { target: "all", ignoredTargets: [] };
  }
  const requested = flag.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  const supported = new Set(["features", "workflows", "data_model", "capabilities", "ui", "datastores", "auxiliary"]);
  const matched = requested.filter((t) => supported.has(t));
  const ignored = requested.filter((t) => !supported.has(t));
  const target = matched.length === 1
    ? matched[0] as "features" | "workflows" | "data_model" | "capabilities" | "ui" | "datastores" | "auxiliary"
    : "all";
  return { target, ignoredTargets: ignored };
}

export async function cmdEnrich(
  positional: string[],
  flags: ParsedArgs["flags"],
): Promise<void> {
  if (flags.help) {
    console.log(`
dg enrich — Expand graph coverage

Usage:
  dg enrich <uuid|name> [options]

Runs a deep scan followed by autonomous multi-hop batch enrichment on a
running daemon. Every canonical graph node receives a substantive description,
intent, purpose, tags, and evidenced relations; UI nodes also receive contract,
interaction, appearance, and layout knowledge.

Options:
  --depth <shallow|deep>    Scan depth (default: deep)
  --targets <list>          Comma-separated: features,workflows,data_model,capabilities,ui,datastores,auxiliary.
                            Multiple targets enrich the complete graph for relation context.
  --batch-size <n>          Nodes per LLM call during enrichment (default: 10, max: 50).
  --max-nodes <n>           Hard cap on nodes enriched per invocation (default: 1000000).
  --model-source <source>   auto, standalone, or architect (default: auto).
  --no-semantic-cache      Disable enriched-neighborhood evidence reuse.
  --semantic-cache-min-confidence <n>
                            Minimum cache confidence from 0 to 1 (default: 0.72).
  --semantic-cache-min-coverage <n>
                            Minimum cache coverage from 0 to 1 (default: 0.75).
  --force                   Re-enrich entries that have already been enriched.
  --dry-run                 Run the LLM but do not persist any changes.
  --skip-scan               Skip the scan pass, only run enrichment
  --skip-enrich             Skip enrichment, only run the scan pass
  --json                    Output raw JSON result
  --master-dir <path>       Override master directory
`);
    return;
  }

  const query = positional[0];
  const jsonOutput = flags.json === true;
  const skipScan = flags["skip-scan"] === true;
  const skipEnrich = flags["skip-enrich"] === true;

  // Resolve instance
  const { entry, instanceRoot } = await resolveInstanceForCommand(query, flags);

  // Verify daemon is running
  const meta = await readServerMeta(instanceRoot);
  if (!meta || !isProcessAlive(meta.pid) || meta.port == null) {
    console.error(
      `Instance '${entry.name}' is not running. Start it first: dg start ${entry.name}`,
    );
    process.exit(1);
  }

  const depth = typeof flags.depth === "string" && ["shallow", "deep"].includes(flags.depth)
    ? flags.depth
    : "deep";

  const results: Record<string, unknown> = {};

  // Pass 1: Scan for coverage
  if (!skipScan) {
    if (!jsonOutput) {
      console.log("Graph operation: enrich");
      console.log(`Target: ${entry.name}`);
      console.log(`Pass 1: scanning (${depth} mode)...`);
    }

    const scanArgs: Record<string, unknown> = { depth };
    if (typeof flags.targets === "string") {
      scanArgs.targets = flags.targets.split(",").map((t) => t.trim());
    }

    try {
      let lastScanProgress = "";
      const scanResult = await mcpCallTool(meta.port, "scan_project", scanArgs, SCAN_TIMEOUT_MS, (update) => {
        if (jsonOutput || !update.message || update.message === lastScanProgress) return;
        lastScanProgress = update.message;
        console.log(`  ${update.message}`);
      });
      const text = scanResult.content?.[0]?.text ?? "{}";
      const parsed = parseToolPayload(text) as Record<string, unknown>;
      results.scan = (parsed?.data as Record<string, unknown> | undefined) ?? parsed;

      if (!jsonOutput) {
        const d = results.scan as Record<string, unknown>;
        console.log("  Scan complete.");
        if (d.repos_scanned) console.log(`  Repos scanned:     ${d.repos_scanned}`);
        if (d.files_discovered) console.log(`  Files discovered:  ${d.files_discovered}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!jsonOutput) {
        console.error(`  Scan failed: ${msg}`);
      }
      results.scan = { error: msg };
    }
  }

  // Pass 2: refresh graph-wide semantic knowledge. scan_project also performs
  // this mandatory pass; a second forced pass remains useful for explicit
  // re-enrichment and --skip-scan workflows.
  if (!skipEnrich) {
    const { target, ignoredTargets } = mapEnrichTarget(flags.targets);

    if (!jsonOutput) {
      console.log(`\nPass 2: enriching graph nodes (target=${target})...`);
      if (ignoredTargets.length > 0) {
        console.log(`  Note: ignoring unsupported enrichment targets: ${ignoredTargets.join(", ")}`);
      }
    }

    const enrichArgs: Record<string, unknown> = { target };
    if (typeof flags["batch-size"] === "string" || typeof flags["batch-size"] === "number") {
      const n = Number(flags["batch-size"]);
      if (Number.isFinite(n) && n > 0) enrichArgs.batch_size = Math.floor(n);
    }
    if (typeof flags["max-nodes"] === "string" || typeof flags["max-nodes"] === "number") {
      const n = Number(flags["max-nodes"]);
      if (Number.isFinite(n) && n > 0) enrichArgs.max_nodes = Math.floor(n);
    }
    if (flags.force === true) enrichArgs.force = true;
    if (flags["dry-run"] === true) enrichArgs.dry_run = true;
    if (flags["no-semantic-cache"] === true) enrichArgs.semantic_cache = false;
    for (const [flag, argument] of [
      ["semantic-cache-min-confidence", "semantic_cache_min_confidence"],
      ["semantic-cache-min-coverage", "semantic_cache_min_coverage"],
    ] as const) {
      const raw = flags[flag];
      if (typeof raw !== "string") continue;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        console.error(`Invalid --${flag}: '${raw}'. Use a number from 0 to 1.`);
        process.exit(1);
      }
      enrichArgs[argument] = value;
    }
    if (typeof flags["model-source"] === "string") {
      const source = flags["model-source"].toLowerCase();
      if (!["auto", "standalone", "architect"].includes(source)) {
        console.error(`Invalid model source: '${flags["model-source"]}'. Use auto, standalone, or architect.`);
        process.exit(1);
      }
      enrichArgs.model_source = source;
    }

    try {
      const enrichResult = await mcpCallTool(
        meta.port,
        "enrich_parser_nodes",
        enrichArgs,
        ENRICH_TIMEOUT_MS,
        (() => {
          let lastEnrichmentProgress = "";
          return (update: { message?: string }) => {
            if (jsonOutput || !update.message || update.message === lastEnrichmentProgress) return;
            lastEnrichmentProgress = update.message;
            console.log(`  ${update.message}`);
          };
        })(),
      );
      const text = enrichResult.content?.[0]?.text ?? "{}";
      const parsed = parseToolPayload(text) as Record<string, unknown>;
      const payload = (parsed?.data as Record<string, unknown> | undefined) ?? parsed;
      results.enrich = payload;

      if (!jsonOutput) {
        const d = payload as Record<string, unknown>;
        console.log("  Enrichment complete.");
        if (d.total_eligible != null) console.log(`  Eligible nodes:     ${d.total_eligible}`);
        if (d.total_enriched != null) console.log(`  Nodes enriched:     ${d.total_enriched}`);
        if (d.total_skipped != null) console.log(`  Nodes skipped:      ${d.total_skipped}`);
        if (d.feature_anchors_written != null)
          console.log(`  Anchors written:    ${d.feature_anchors_written}`);
        if (d.relations_written != null) console.log(`  Relations written:  ${d.relations_written}`);
        const coverage = d.semantic_coverage as Record<string, unknown> | undefined;
        if (coverage) console.log(`  Semantic coverage:  ${coverage.llm_enriched ?? 0}/${coverage.total_nodes ?? 0}`);
        const semanticCache = d.semantic_cache as Record<string, unknown> | undefined;
        if (semanticCache?.enabled === true) {
          console.log(`  Cache-served nodes: ${semanticCache.nodes_served_from_cache ?? 0}`);
          console.log(`  Source reads saved: ${semanticCache.source_reads_avoided ?? 0}`);
          console.log(`  Physical reads:     ${semanticCache.source_file_reads ?? 0}`);
          console.log(`  Shared prompt refs: ${semanticCache.prompt_source_reuses ?? 0}`);
        }
        if (d.batches_run != null) console.log(`  Batches run:        ${d.batches_run}`);
        if (d.llm_calls != null) console.log(`  LLM calls:          ${d.llm_calls}`);
        if (d.tokens_used != null) console.log(`  Tokens used:        ${d.tokens_used}`);
        if (Array.isArray(d.errors) && d.errors.length > 0) {
          console.log(`  Errors (${d.errors.length}):`);
          for (const e of d.errors.slice(0, 5)) console.log(`    - ${String(e)}`);
          if (d.errors.length > 5) console.log(`    ... and ${d.errors.length - 5} more`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!jsonOutput) {
        console.error(`  Enrichment failed: ${msg}`);
      }
      results.enrich = { error: msg };
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify({ ok: true, mode: "enrich", target: entry.name, ...results }, null, 2));
    return;
  }

  console.log("\nEnrichment pipeline complete.");
  console.log("Tip: run 'dg curate' to identify remaining quality issues, or use DreamGraph Architect for multi-pass guided enrichment.");
}
