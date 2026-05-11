// architect-v2/execution/inventory.ts
// Slice 4 — Live CapabilityInventory producer (replaces Slice 3 stub).
//
// STRICT ISOLATION (ADR-140): no import from v1.
//
// Per Slice 3 §3.G: this module supplies the live inventory. Slice 3
// `deriveNextAction()` consumes it via the `CapabilityInventory` contract.

import type { CapabilityInventory } from "../autonomy/capability.js";
import type { ToolDescriptor } from "./catalog.js";
import { NATIVE_TOOL_CATALOG } from "./catalog.js";
import type { Intent } from "./intents.js";
import type { Tier } from "./tiers.js";

/**
 * Pure interface over the live MCP roster. Production wiring asks
 * `McpClient.listTools()` once at session start and feeds the result here.
 */
export interface McpRosterProbe {
  has(toolName: string): boolean;
  list(): readonly string[];
}

/**
 * Pure interface over editor-side capabilities the agent might fall back to.
 * Production wiring inspects the `vscode` API at session start.
 */
export interface VsCodeCapabilityProbe {
  has(
    capability:
      | "editor.diagnostics"
      | "editor.symbol"
      | "editor.openFile"
      | "editor.command"
      | "lm.tool",
  ): boolean;
}

/**
 * Resolved snapshot of which catalog entries are callable right now.
 * Built once per session by `buildCapabilityInventory`.
 */
export interface ResolvedCatalog {
  readonly available: readonly ToolDescriptor[];
  readonly unavailable: readonly ToolDescriptor[];
  /**
   * MCP tools the live roster reports but the native catalog does not list.
   * Recorded for telemetry only — NOT auto-promoted (ADR-155).
   */
  readonly unknownRosterTools: readonly string[];
}

/**
 * Resolve `NATIVE_TOOL_CATALOG` against the live probes.
 * - MCP descriptors: available iff `mcp.has(tool)`.
 * - VS Code descriptors: available iff every `requires` capability is present.
 * - Shell descriptors: always available (the host runs in a Node/VS Code process).
 */
export function resolveCatalog(args: {
  mcp: McpRosterProbe;
  vscode: VsCodeCapabilityProbe;
}): ResolvedCatalog {
  const available: ToolDescriptor[] = [];
  const unavailable: ToolDescriptor[] = [];

  for (const desc of NATIVE_TOOL_CATALOG) {
    if (desc.kind === "mcp") {
      (args.mcp.has(desc.tool) ? available : unavailable).push(desc);
    } else if (desc.kind === "vscode") {
      const ok = (desc.requires ?? []).every((cap) =>
        args.vscode.has(
          cap as
            | "editor.diagnostics"
            | "editor.symbol"
            | "editor.openFile"
            | "editor.command"
            | "lm.tool",
        ),
      );
      (ok ? available : unavailable).push(desc);
    } else {
      // shell — always available in the host process.
      available.push(desc);
    }
  }

  const known = new Set(
    NATIVE_TOOL_CATALOG.filter((d) => d.kind === "mcp").map((d) => d.tool),
  );
  const unknownRosterTools = args.mcp.list().filter((t) => !known.has(t));

  return Object.freeze({
    available: Object.freeze(available),
    unavailable: Object.freeze(unavailable),
    unknownRosterTools: Object.freeze(unknownRosterTools),
  });
}

/**
 * Project a resolved catalog into the Slice 3 `CapabilityInventory` contract.
 * `has(intent)` answers true iff at least one available descriptor covers it,
 * regardless of tier. `list()` returns the sorted set of covered intents.
 */
export function buildCapabilityInventory(
  resolved: ResolvedCatalog,
): CapabilityInventory {
  const covered = new Set<string>();
  for (const d of resolved.available) covered.add(d.intent);
  return {
    has(capability: string): boolean {
      return covered.has(capability);
    },
    list(): readonly string[] {
      return Array.from(covered).sort();
    },
  };
}

/**
 * Helper: which tiers cover the given intent in this resolved catalog?
 * Used by `policy.selectExecutor` and by Slice 6's parity matrix.
 */
export function tiersCoveringIntent(
  resolved: ResolvedCatalog,
  intent: Intent,
): readonly Tier[] {
  const tiers = new Set<Tier>();
  for (const d of resolved.available) {
    if (d.intent === intent) tiers.add(d.tier);
  }
  return Array.from(tiers).sort((a, b) => a - b) as Tier[];
}
