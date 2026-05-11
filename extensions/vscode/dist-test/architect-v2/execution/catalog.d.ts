import type { Tier } from "./tiers.js";
import type { Intent } from "./intents.js";
export type ToolKind = "mcp" | "vscode" | "shell";
export interface ToolDescriptor {
    /** Exact tool name as the dispatcher will invoke it. */
    readonly tool: string;
    readonly tier: Tier;
    readonly intent: Intent;
    readonly kind: ToolKind;
    /**
     * Optional VS Code capability requirement (e.g. `'lm.tool'`). Used by
     * `buildCapabilityInventory` to filter Tier-4 entries against the live
     * `VsCodeCapabilityProbe`.
     */
    readonly requires?: readonly string[];
    readonly notes?: string;
}
/**
 * The single source of truth for what tools v2 considers native or fallback.
 * Order within each tier is meaningful: ties at the same tier+intent are
 * resolved by declaration order in `selectExecutor`.
 */
export declare const NATIVE_TOOL_CATALOG: readonly ToolDescriptor[];
//# sourceMappingURL=catalog.d.ts.map