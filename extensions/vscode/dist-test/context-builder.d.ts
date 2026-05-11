/**
 * DreamGraph Context Builder — Layer 2 (Context Orchestration).
 *
 * Assembles EditorContextEnvelope from editor state + DreamGraph knowledge.
 * Implements the §3.4 Context Assembly Pipeline and §3.7 Token Budget.
 *
 * @see TDD §3.2 (Context Envelope), §3.4 (Assembly Pipeline), §3.5 (Knowledge Integration), §3.7 (Token Budget)
 */
import type { McpClient } from "./mcp-client.js";
import type { DaemonClient } from "./daemon-client.js";
import type { EditorContextEnvelope, ResolvedInstance } from "./types.js";
export { shouldFetchDeepInsight, type BudgetCoordinatorReader, } from "./budget-coordinator-reader.js";
import { type BudgetCoordinatorReader } from "./budget-coordinator-reader.js";
export interface ContextBuilderOptions {
    maxContextTokens: number;
    instance: ResolvedInstance | null;
}
export declare class ContextBuilder {
    private _mcpClient;
    private _daemonClient;
    private _options;
    constructor(mcpClient: McpClient, daemonClient: DaemonClient, options: ContextBuilderOptions);
    updateOptions(options: Partial<ContextBuilderOptions>): void;
    private _environmentMetrics;
    private _previousStablePrefixHash;
    /**
     * Per-instance caches for hot-path context lookups.
     *
     * `buildEnvelope` runs synchronously in front of every LLM call — every cache miss
     * here directly delays the first visible token (and the first tool call) in the
     * chat panel. The {@link ContextCache} owns:
     *  - environment-snapshot slot (5 min TTL)
     *  - deep-insights slot (30 s TTL — dreams/causal/temporal/cognitive)
     *  - process-wide context-fetch timeout counter (F-14 observability)
     *  - the cognitive-mutating-tool list that drives {@link maybeInvalidateForTool}
     *  - the hard MCP fetch ceiling (F-07)
     */
    private readonly _cache;
    /** Read-only snapshot of context-fetch timeouts (tool -> count). */
    static getContextFetchTimeoutStats(): Record<string, number>;
    buildEnvelope(prompt?: string, commandSource?: string, 
    /**
     * Phase 3 of NEVER_FAIL_BUDGET_DEBT_PLAN — optional turn-scoped coordinator.
     * When supplied, `buildEnvelope` adapts deep-insights and environment fetches
     * to the coordinator's pressure label (the coordinator owns all pressure
     * decisions; this site only reads `getContextPressureLabel()`).
     *
     * Trim policy (Plan §3.1 — deep insights first, then environment):
     *  - 'low'    → full fidelity (no trim)
     *  - 'normal' → full fidelity (no trim — reserved for future tier-2 trims)
     *  - 'high'   → drop optional deep-insights tiers (temporal, cognitive_status,
     *               and feature/workflow when only optionally needed) and reduce
     *               the environment block to the runtime/package-manager header
     *               (no per-scope entries).
     *
     * ADR-097: the curated graph-evidence slice is NEVER trimmed here. Deep-insights
     * are advisory MCP fetches layered on top of the graph slice; trimming them
     * leaves the ADR-097 reserve intact.
     */
    coordinator?: BudgetCoordinatorReader): Promise<EditorContextEnvelope>;
    rehydrateStoredAnchors<T extends {
        anchor?: import("./types.js").SemanticAnchor;
    }>(messages: T[], graphContext: NonNullable<EditorContextEnvelope["graphContext"]> | null): Promise<T[]>;
    readActiveFileContent(options?: {
        allowFullFile?: boolean;
        reason?: string;
        explicitUserRequest?: boolean;
        debugMode?: boolean;
    }): string | null;
    readSelectionContent(): string | null;
    readFile(relativePath: string): Promise<string | null>;
    createContextPlan(envelope: EditorContextEnvelope, prompt?: string, commandSource?: string): Promise<import("./types.js").ContextPlan>;
    private _isPatchLikeRequest;
    private _buildImportContractEvidence;
    private _buildTypeContractEvidence;
    private _buildLocalConventionEvidence;
    private _resolveImportContractSummary;
    private _resolveTypeContractSummary;
    private _resolveImportPath;
    private _collectModuleExportSymbols;
    private _moduleCandidatePaths;
    private _candidateTypeFiles;
    private _extractTypeContractFromFile;
    resolveGraphContext(envelope: EditorContextEnvelope, plan: import("./types.js").ContextPlan, coordinator?: BudgetCoordinatorReader): Promise<EditorContextEnvelope["graphContext"]>;
    /**
     * Shared budget-allocation loop (§3.7).
     *
     * Iterates a pre-sorted evidence list and partitions items into included vs omitted
     * without exceeding `usableBudget` tokens. When `codeRetryOptions` is provided, a
     * code item that would bust the budget gets a `_trimActiveFile` retry before being
     * marked omitted — this preserves the `assembleContextBlock` behaviour.
     */
    private _applyBudget;
    /**
     * Inner budget-allocation loop. Iterates a pre-sorted evidence list and partitions
     * items into included vs omitted without exceeding `usableBudget` tokens. When
     * `codeRetryOptions` is provided, a code item that would bust the budget gets a
     * `_trimActiveFile` retry before being marked omitted.
     */
    private _runBudgetLoop;
    buildReasoningPacket(envelope: EditorContextEnvelope, options?: {
        prompt?: string;
        commandSource?: string;
        additionalSections?: Map<string, string>;
        /**
         * Phase 1 of NEVER_FAIL_BUDGET_DEBT_PLAN — optional turn-scoped coordinator.
         * When supplied, the context tier reports its actual graph and evidence
         * token consumption so component history is populated end-to-end.
         * The coordinator owns all pressure decisions; this site MUST NOT read
         * remaining budget back to alter behaviour in Phase 1.
         */
        coordinator?: {
            recordComponentActual(component: string, actualTokens: number): void;
            getContextPressureLabel?(): 'low' | 'normal' | 'high';
            getRemainingTargetTokens?(): number;
            flagGraphSliceEmergencyTrim?(): void;
        };
        /** Phase 2 — when false, suppress `contextPressure` on the packet. */
        pressureSignalEnabled?: boolean;
    }): Promise<import("./types.js").ReasoningPacket>;
    assembleContextBlock(envelope: EditorContextEnvelope, fileContent: string | null, additionalSections: Map<string, string>): Promise<{
        text: string;
        usedTokens: number;
        totalTokens: number;
        trimmedSections: string[];
    }>;
    renderReasoningPacket(packet: import("./types.js").ReasoningPacket): {
        text: string;
        usedTokens: number;
        totalTokens: number;
        trimmedSections: string[];
    };
    private _readPlannedCode;
    private _createContextPlan;
    private _createFallbackPlan;
    private _resolveGraphContext;
    private _getCachedEnvironmentSnapshot;
    /**
     * Invalidate the deep-insights cache so the next `buildEnvelope` re-fetches
     * dreams / causal / temporal / cognitive_status. Call after a graph-mutating
     * action so the chat panel does not assert "Verified" against stale state.
     */
    invalidateDeepInsights(reason?: string): void;
    /**
     * Convenience: invalidate when a tool name is known to mutate cognitive state.
     * Returns true if the cache was invalidated.
     */
    maybeInvalidateForTool(toolName: string): boolean;
    /** Drop every cached slot. Useful on workspace change or daemon reconnect. */
    clearAllCaches(): void;
    /**
     * Pre-scores anchor identity against the Pass-1 daemon feature list using the
     * same matchScore logic as _promoteAnchor. Returns the best candidate feature
     * ID and its score, or null when no candidate clears the minimum bar (0.5).
     *
     * Used by _resolveGraphContext to decide whether a targeted Pass-2 call
     * with feature_ids:[candidateId] is worth making (threshold: 0.75).
     *
     * Deliberately synchronous and allocation-light — called on every turn.
     */
    private _preScoreFeatureId;
    private _applyCanonicalAnchorIdsToGraphContext;
    private _resolvePrimaryAnchor;
    private _resolveSecondaryAnchors;
    private _collectEvidenceItems;
    private _trimActiveFile;
    private _deriveSelectionSemanticAnchor;
    private _deriveCursorSemanticAnchor;
    private _deriveSymbolAnchor;
    private _findBestSymbolAtPosition;
    private _buildSymbolPath;
    /**
     * Tries to match a symbol-level anchor to a graph entity (feature, workflow,
     * ADR, UI registry element). If a match is found, the anchor is upgraded with
     * canonicalId + canonicalKind and migrationStatus = "promoted".
     *
     * Resolution order (mirrors recommended anchor hierarchy):
     *   1. Graph entity IDs matched by name or symbol path
     *   2. Workflow IDs
     *   3. ADR IDs
     *   4. UI registry IDs
     *   5. No match → anchor returned unchanged (native / heuristic)
     */
    private _promoteAnchor;
    /**
     * Applies legacy migration rules to an anchor whose prior symbolPath / canonicalId
     * is being re-evaluated against current graph context and VS Code symbol reality.
     *
     * Rules (matches the recommended migration policy):
     *   - Exact symbol match              → migrationStatus = "native" (already correct)
     *   - Symbol name found, path changed → migrationStatus = "rebound", update symbolPath
     *   - Partial name match only         → migrationStatus = "drifted", lower confidence
     *   - No match found anywhere         → migrationStatus = "archived", historical = true
     */
    private _migrateAnchor;
    /**
     * Public entry point: given an anchor (typically loaded from stored state or a
     * prior conversation turn), re-evaluate it against the current editor + graph
     * context and return a migrated + optionally promoted anchor.
     */
    resolveAnchorMigration(anchor: import("./types.js").SemanticAnchor, graphContext: NonNullable<EditorContextEnvelope["graphContext"]> | null): Promise<import("./types.js").SemanticAnchor>;
}
//# sourceMappingURL=context-builder.d.ts.map