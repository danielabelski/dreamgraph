import type { CapabilityInventory } from "../autonomy/index.js";
import { type DensityProbe } from "../capabilities/index.js";
import type { CallProviderInput, ClockPort, ExecuteCapabilityInput, ExecutorPort } from "../orchestrator/index.js";
import type { McpClient } from "../orchestrator/index.js";
import type { ProviderProposal } from "../orchestrator/types.js";
import type { ProviderConfig, ProviderProfile, ToolDefinition as ProviderToolDefinition } from "../providers/index.js";
import type { ModelDescriptor } from "../providers/index.js";
import { type ResolvedCatalog, type VsCodeCapabilityProbe } from "./inventory.js";
import { type ToolOutcome } from "./outcome.js";
/**
 * Editor-side bridge. The host wires this against the live `vscode`
 * namespace; Milestone 5 supplies the production implementation.
 *
 * Each method returns a serializable result object (the executor wraps
 * it into a ToolOutcome). On unrecoverable host errors the method MUST
 * throw — the executor maps the throw into a FailureOutcome.
 */
export interface EditorBridge {
    invoke(toolName: string, args: Readonly<Record<string, unknown>>): Promise<unknown>;
}
/** Shell bridge. Same contract as EditorBridge — wired by Milestone 5. */
export interface ShellBridge {
    invoke(toolName: string, args: Readonly<Record<string, unknown>>): Promise<unknown>;
}
export interface ExecutorAdapterOptions {
    readonly providerProfile: ProviderProfile;
    readonly model: ModelDescriptor;
    readonly providerConfig: ProviderConfig;
    /** Bound MCP transport (already used by DreamGraph reader/recorder). */
    readonly mcpClient: McpClient;
    /**
     * Resolved catalog snapshot taken once at host startup. The executor
     * uses it for every capability resolution; if MCP roster changes
     * mid-session, build a new ExecutorAdapter.
     */
    readonly resolvedCatalog: ResolvedCatalog;
    /**
     * Per-pass density probe. For v10.0.0 the host supplies a single
     * static probe (from the last graph snapshot); future versions may
     * inject a probe-source that refreshes between passes.
     */
    readonly densityProbe: DensityProbe;
    /** Optional editor bridge; defaults to an unavailable stub. */
    readonly editorBridge?: EditorBridge;
    /** Optional shell bridge; defaults to an unavailable stub. */
    readonly shellBridge?: ShellBridge;
    readonly clock?: ClockPort;
    /**
     * Confidence assigned to ActionCandidates parsed from provider tool
     * calls. Default 0.7 — high enough to clear typical mode thresholds
     * but not so high that a single hallucinated call dominates ranking.
     */
    readonly toolCallConfidence?: number;
    /**
     * Confidence assigned to the synthetic 'reply' ActionCandidate when
     * the provider returns text without tool calls. Default 0.4.
     */
    readonly textReplyConfidence?: number;
}
/**
 * Walk the live MCP roster once and return a frozen ResolvedCatalog. The
 * host calls this at startup and feeds the result into ExecutorAdapter.
 *
 * On listTools() failure the function returns a catalog where every MCP
 * descriptor is marked unavailable; the executor still resolves vscode/
 * shell tiers normally.
 */
export declare function resolveLiveCatalog(args: {
    mcpClient: McpClient;
    vscodeCapabilities?: VsCodeCapabilityProbe;
}): Promise<ResolvedCatalog>;
export declare class ExecutorAdapter implements ExecutorPort {
    private readonly opts;
    private readonly providerAdapter;
    private readonly clock;
    private readonly editor;
    private readonly shell;
    private readonly toolCallConfidence;
    private readonly textReplyConfidence;
    constructor(opts: ExecutorAdapterOptions);
    callProvider(input: CallProviderInput): Promise<ProviderProposal>;
    executeCapability(input: ExecuteCapabilityInput): Promise<ToolOutcome>;
    private invokeDescriptor;
    private makeSuccess;
    private makeFailure;
}
/**
 * Project the live catalog into the provider tool list.
 *
 * Earlier revisions filtered by `inventory.has(desc.intent)`, but the
 * inventory is keyed by CapabilityId (e.g. "read.file") while
 * descriptors carry Intents (e.g. "file.read") — a vocabulary mismatch
 * that always returned empty, leaving the model with zero tools and
 * forcing it to hallucinate tool_use JSON in prose. The catalog snapshot
 * already filtered by live MCP roster, so liveness is the gate; the
 * inventory still trims candidate dispatch downstream.
 *
 * Tool descriptions are intentionally short — the catalog is a long flat
 * list and bloated descriptions push the request over the budget brake.
 */
export declare function sanitizeProviderToolName(name: string): string;
export interface ProviderToolBundle {
    readonly tools: ProviderToolDefinition[];
    /** sanitized provider name -> original catalog tool id */
    readonly sanitizedToOriginal: Map<string, string>;
}
export declare function providerToolsForInventory(resolved: ResolvedCatalog, _inventory: CapabilityInventory): ProviderToolBundle;
//# sourceMappingURL=executor-adapter.d.ts.map