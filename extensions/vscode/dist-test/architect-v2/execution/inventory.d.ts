import type { CapabilityInventory } from "../autonomy/capability.js";
import type { ToolDescriptor } from "./catalog.js";
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
    has(capability: "editor.diagnostics" | "editor.symbol" | "editor.openFile" | "editor.command" | "lm.tool"): boolean;
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
export declare function resolveCatalog(args: {
    mcp: McpRosterProbe;
    vscode: VsCodeCapabilityProbe;
}): ResolvedCatalog;
/**
 * Project a resolved catalog into the Slice 3 `CapabilityInventory` contract.
 * `has(intent)` answers true iff at least one available descriptor covers it,
 * regardless of tier. `list()` returns the sorted set of covered intents.
 */
export declare function buildCapabilityInventory(resolved: ResolvedCatalog): CapabilityInventory;
/**
 * Helper: which tiers cover the given intent in this resolved catalog?
 * Used by `policy.selectExecutor` and by Slice 6's parity matrix.
 */
export declare function tiersCoveringIntent(resolved: ResolvedCatalog, intent: Intent): readonly Tier[];
//# sourceMappingURL=inventory.d.ts.map