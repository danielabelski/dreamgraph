/**
 * `dg bootstrap` — manual bootstrap override (ADR-098 Slice 2C / guard rail #4).
 *
 * Calls the `bootstrap_instance` MCP tool on the running daemon. Use this
 * when:
 *   - The auto-driver hasn't fired (instance pre-dates Slice 2A or LLM
 *     was already ready before the watcher subscribed).
 *   - The operator wants to force a re-enrichment after a model upgrade.
 *   - The operator wants a clean rescan (--mode full --force).
 */

import type { ParsedArgs } from "../dg.js";
import {
  resolveInstanceForCommand,
  readServerMeta,
  isProcessAlive,
} from "../utils/daemon.js";
import { mcpCallTool } from "../utils/mcp-call.js";

type BootstrapMode = "auto" | "full" | "re_enrich";

export async function cmdBootstrap(
  positional: string[],
  flags: ParsedArgs["flags"],
): Promise<void> {
  if (flags.help) {
    console.log(`
dg bootstrap — Manual bootstrap override (ADR-098 #4)

Usage:
  dg bootstrap <uuid|name> [options]

Forces the LLM-driven bootstrap chain (or just the re-enrichment portion)
on a running instance. Required by ADR-098 as the operator escape hatch
for the auto-readiness watcher.

Options:
  --mode <auto|full|re_enrich>  Bootstrap mode (default: auto)
                                  auto:      full on fresh, re_enrich on populated
                                  full:      always rescan + enrich + ADR discovery
                                  re_enrich: refresh model-derived metadata only
                                             (no source rescan; ADR-098 #2 + #3)
  --force                       Bypass the bootstrap-registry's fingerprint
                                  dedupe (re-run even if already recorded)
  --json                        Output raw JSON result
  --master-dir <path>           Override master directory

Examples:
  dg bootstrap dreamgraph                    # smart default
  dg bootstrap dreamgraph --mode re_enrich   # refresh ADRs against new model
  dg bootstrap dreamgraph --mode full --force  # full re-bootstrap
`);
    return;
  }

  const query = positional[0];
  const jsonOutput = flags.json === true;

  // Mode validation
  const modeStr =
    typeof flags.mode === "string" ? flags.mode : "auto";
  const VALID_MODES: BootstrapMode[] = ["auto", "full", "re_enrich"];
  if (!VALID_MODES.includes(modeStr as BootstrapMode)) {
    console.error(
      `Invalid --mode '${modeStr}'. Use one of: ${VALID_MODES.join(", ")}.`,
    );
    process.exit(1);
  }
  const mode = modeStr as BootstrapMode;
  const force = flags.force === true;

  // Resolve + verify daemon
  const { entry, instanceRoot } = await resolveInstanceForCommand(query, flags);
  const meta = await readServerMeta(instanceRoot);
  if (!meta || !isProcessAlive(meta.pid) || meta.port == null) {
    console.error(
      `Instance '${entry.name}' is not running. Start it first: dg start ${entry.name}`,
    );
    process.exit(1);
  }

  if (!jsonOutput) {
    console.log(
      `Bootstrapping instance '${entry.name}' (mode=${mode}${force ? ", force" : ""})…`,
    );
    if (mode === "full") {
      console.log("This may take a while if LLM enrichment is enabled.\n");
    }
  }

  try {
    // Generous timeout — full mode runs scan + LLM enrichment + ADR discovery.
    const result = await mcpCallTool(
      meta.port,
      "bootstrap_instance",
      { mode, force },
      mode === "full" ? 600_000 : 120_000,
    );

    const text = result.content?.[0]?.text ?? "{}";
    if (jsonOutput) {
      console.log(text);
      return;
    }

    let parsed: { success?: boolean; data?: Record<string, unknown>; error?: { message?: string; code?: string } };
    try {
      parsed = JSON.parse(text);
    } catch {
      console.error(`Unparseable response from daemon:\n${text}`);
      process.exit(1);
    }

    if (parsed.success === false) {
      const code = parsed.error?.code ?? "ERROR";
      const msg = parsed.error?.message ?? "unknown error";
      console.error(`Bootstrap failed [${code}]: ${msg}`);
      process.exit(1);
    }

    const d = (parsed.data ?? parsed) as Record<string, unknown>;
    console.log("Bootstrap complete.");
    console.log(`  Mode requested:    ${d.mode}`);
    console.log(`  Resolved kind:     ${d.resolved_kind}`);
    console.log(`  LLM ready:         ${d.llm_ready}`);
    console.log(`  Was fresh:         ${d.was_fresh_instance}`);
    if (typeof d.fingerprint === "string") {
      console.log(`  Fingerprint:       ${d.fingerprint}`);
    }
    if (typeof d.adrs_recorded === "number") {
      console.log(`  ADRs recorded:     ${d.adrs_recorded}`);
    }
    if (typeof d.message === "string") {
      console.log(`  ${d.message}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Bootstrap call failed: ${msg}`);
    process.exit(1);
  }
}
