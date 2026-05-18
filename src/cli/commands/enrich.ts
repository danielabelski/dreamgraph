/**
 * `dg enrich` — High-level graph coverage operation.
 *
 * Calls scan_project (deep mode by default) and enrich_parser_nodes on a
 * running daemon to expand graph coverage and add semantic data (intent,
 * purpose, tags, feature anchors) to every parser-discovered entry in a
 * single autonomous batch pass.
 */

import type { ParsedArgs } from "../dg.js";
import {
  resolveInstanceForCommand,
  readServerMeta,
  isProcessAlive,
} from "../utils/daemon.js";
import { mcpCallTool } from "../utils/mcp-call.js";

/** Deep project scans can be expensive on large repos; allow ~10 minutes. */
const SCAN_TIMEOUT_MS = 600_000;
/** Enrichment hits the LLM in batches; large graphs can take a while. Allow ~30 minutes. */
const ENRICH_TIMEOUT_MS = 1_800_000;

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
 * Map the comma-separated `--targets` flag onto the enrich_parser_nodes
 * `target` enum. The tool only enriches `features` and `data_model`
 * (workflows are not parser-discovered entities with EnrichableFields).
 */
function mapEnrichTarget(flag: unknown): {
  target: "features" | "data_model" | "both";
  ignoredTargets: string[];
} {
  if (typeof flag !== "string" || flag.trim() === "") {
    return { target: "both", ignoredTargets: [] };
  }
  const requested = flag.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  const supported = new Set(["features", "data_model"]);
  const matched = requested.filter((t) => supported.has(t));
  const ignored = requested.filter((t) => !supported.has(t));
  let target: "features" | "data_model" | "both";
  if (matched.length === 0 || matched.length === supported.size) {
    target = "both";
  } else {
    target = matched[0] as "features" | "data_model";
  }
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

Runs a deep scan followed by autonomous batch enrichment on a running
daemon. This is a convenience command that chains scan_project +
enrich_parser_nodes for comprehensive graph coverage expansion: every
parser-discovered features.json / data_model.json entry gets semantic
data (description rewrite, intent, purpose, tags, feature anchors) in a
single LLM batch pass.

Options:
  --depth <shallow|deep>    Scan depth (default: deep)
  --targets <list>          Comma-separated. Scan targets: features,workflows,data_model.
                            Enrichment targets: features,data_model (workflows ignored).
  --batch-size <n>          Nodes per LLM call during enrichment (default: 10, max: 50).
  --max-nodes <n>           Hard cap on nodes enriched per invocation (default: 500).
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
      const scanResult = await mcpCallTool(meta.port, "scan_project", scanArgs, SCAN_TIMEOUT_MS);
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

  // Pass 2: Enrich parser-discovered nodes (autonomous batch semantic enrichment)
  if (!skipEnrich) {
    const { target, ignoredTargets } = mapEnrichTarget(flags.targets);

    if (!jsonOutput) {
      console.log(`\nPass 2: enriching parser-discovered nodes (target=${target})...`);
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

    try {
      const enrichResult = await mcpCallTool(
        meta.port,
        "enrich_parser_nodes",
        enrichArgs,
        ENRICH_TIMEOUT_MS,
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
