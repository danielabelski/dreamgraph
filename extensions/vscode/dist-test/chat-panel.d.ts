/**
 * DreamGraph Chat Panel — M5 WebviewPanel controller.
 *
 * Owns all chat state (messages, streaming, model selection).
 * The webview is a dumb renderer — the extension host is the single source of truth.
 *
 * Chat history is persisted in ChatMemory and re-hydrated whenever the webview
 * is recreated or becomes visible again, so switching to another tool tab does
 * not erase the conversation.
 */
import * as vscode from 'vscode';
import type { ChatMemory } from './chat-memory';
import type { GraphSignalProvider } from './graph-signal';
import { type ArchitectLlm } from './architect-llm';
import type { McpClient } from './mcp-client';
import type { ContextBuilder } from './context-builder';
import type { ChangedFilesView } from './changed-files-view';
import { BudgetCoordinator } from './budget-coordinator.js';
type ChatRole = 'user' | 'assistant' | 'system';
interface ActionExecutionRecord {
    timestamp: string;
    actionType: string;
    sourceMessageId: string;
    outcome: 'completed' | 'failed' | 'cancelled';
    detail?: string;
}
export declare class ChatPanel implements vscode.WebviewViewProvider, vscode.Disposable {
    private readonly context;
    static readonly viewType = "dreamgraph.chatView";
    private view;
    private readonly disposables;
    private readonly messages;
    private memory?;
    private graphSignal?;
    private architectLlm?;
    private contextBuilder?;
    private mcpClient?;
    private contextInspector?;
    private _restoringAnchors;
    private changedFilesView?;
    private currentInstanceId;
    private streaming;
    private abortController;
    private streamingContent;
    private steeringQueue;
    private draftText;
    private attachments;
    /** Messages buffered while the webview was hidden. Flushed on rehydrate. */
    private _pendingMessages;
    /** Cached browser build of markdown-it. Loaded once at first getHtml() call. */
    private _markdownItSource;
    /** Cached browser build of DOMPurify. Loaded once at first getHtml() call. */
    private _domPurifySource;
    /** Cached URI to bundled webview runtime for Slice 3 Option C migration. */
    private _webviewBundleUri;
    private _pendingReviewsCollapsed;
    private _lastToolTrace;
    /** Set when the report-required guard has already forced a final report
     * turn for the current run, so we don't loop forever asking for reports. */
    private _reportForcedThisRun;
    /**
     * Phase 2 of the never-fail budget plan (plans/NEVER_FAIL_BUDGET_DEBT_PLAN.md).
     * Snapshot is hydrated from `ChatMemory.loadBudgetState` on restore and
     * persisted via `saveBudgetState` after each `_finalizeCurrentBudgetTurn`.
     * The §9 reload invariant requires byte-for-byte round-trip — `BudgetSnapshot`
     * is plain JSON.
     */
    private _lastBudgetSnapshot;
    private _budgetTurnCounter;
    /** The coordinator instantiated for the current turn, if any. */
    private _currentBudgetCoordinator;
    /** Set after restoreMessages hydrates persisted budget state, so we don't re-load mid-session. */
    private _budgetStateHydrated;
    /**
     * Tool names that the most recent assistant turn explicitly mentioned in its
     * "Suggested Actions" / next-step text. Carried into the next user turn so
     * brief follow-ups ("yes", "do it") still expose the right tools to the
     * agentic loop. Cleared after one turn — see handleUserMessage().
     */
    private _primedTools;
    /**
     * Names of every tool available on the most recent turn. Stashed here so
     * post-response capture (`_capturePrimedTools`) can scan the assistant text
     * without re-fetching the MCP tool list.
     */
    private _lastAvailableToolNames;
    private _lastVerdict;
    private _actionLog;
    private _actionStateByMessage;
    private _hoverActionStateByMessage;
    /** Autonomy session state — tracks mode, pass budget, and continuation policy. */
    private _autonomyState;
    /** Whether autonomy continuation is actively enabled for this session. */
    private _autonomyEnabled;
    /** The last set of recommended actions from a pass analysis. */
    private _lastRecommendedActions;
    /** Whether an autonomy continuation loop is currently running. */
    private _autonomyContinuing;
    /** Task state captured at loop stop time. Injected into the next turn's system prompt
     * so that "resume" re-enters from a known task position rather than a fresh context. */
    private _lastStopContext;
    private static readonly MAX_RENDERED_MESSAGE_CHARS;
    private static readonly MAX_ENTITY_LINKS_PER_MESSAGE;
    private static readonly ACTION_ALLOWLIST;
    private static readonly MAX_TEXT_ATTACHMENT_BYTES;
    private static readonly MAX_IMAGE_ATTACHMENT_BYTES;
    /** Hard timeout per LLM provider request (ms). Prevents infinite hangs.
     *  Re-exported from chat-panel/timeout.ts so existing call sites keep working. */
    private static readonly REQUEST_TIMEOUT_MS;
    private static readonly TEXT_EXTENSIONS;
    private static readonly IMAGE_MIME_BY_EXT;
    constructor(context: vscode.ExtensionContext);
    setGraphSignal(provider: GraphSignalProvider): void;
    setMemory(memory: ChatMemory): void;
    setArchitectLlm(llm: ArchitectLlm): void;
    setContextBuilder(cb: ContextBuilder): void;
    setMcpClient(mcp: McpClient): void;
    setChangedFilesProvider(provider: ChangedFilesView): void;
    setContextInspector(inspector: import('./context-inspector.js').ContextInspector): void;
    setInstance(instanceId: string): void;
    get isVisible(): boolean;
    addExternalMessage(role: ChatRole, content: string): void;
    open(): void;
    resolveWebviewView(webviewView: vscode.WebviewView, _context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken): Promise<void>;
    clearMessages(): Promise<void>;
    dispose(): void;
    handleUserMessage(text: string): Promise<void>;
    private _buildPromptContext;
    /**
     * Build the per-turn `CopilotCliProviderPortOptions` used by
     * `runPassViaCopilotCli`. Reads three settings (binary name,
     * dreamgraph stdio command, hard timeout), points the bridge audit
     * sink at the extension's globalStorage so transcripts survive
     * window reloads, and threads the active workspace folder as the
     * CLI's invocation cwd so file tools resolve relative paths the
     * way the user expects.
     */
    private _buildCopilotCliProviderOptions;
    /**
     * that the architect-core adapters bind to. The host projects the
     * already-constructed envelope, context, autonomy state, and bounded
     * conversation, and provides the REAL persistence + state-broadcast
     * implementations the seam invokes through MemoryPort/AutonomyPort/
     * AttachmentPort. No empty stubs: every declared method does the work
     * its name promises (idempotent where v1 also wrote the same record).
     *
     * Phase 3a routing predicate (text-only no-tools, no attachments, no
     * autonomy, no stop-context) is enforced at the call site in
     * `handleUserMessage`. Hooks that the predicate guarantees cannot be
     * reached this phase (executeTool) fail loud rather than no-op so a
     * future widening of the predicate that forgets to wire them is
     * surfaced immediately.
     */
    private _buildCorePassHost;
    private _buildUserContentBlocks;
    private _attachmentSummaryForUserMessage;
    private _pickAttachments;
    private _syncAttachments;
    private _handlePastedImage;
    private abortGeneration;
    /**
     * Create a child AbortSignal that fires on EITHER user abort OR timeout.
     * Returns a dispose function that MUST be called when the request completes
     * to prevent timer leaks.
     */
    private _createRequestSignal;
    private _getLlmTimeoutMs;
    private _isTimeoutError;
    private _buildTimeoutRecoveryPrompt;
    private _recoverFromLlmTimeout;
    /**
     * Reset ALL streaming-related state in one place.
     * Sends cleanup messages to the webview so the UI never stays stuck.
     */
    private resetStreamState;
    private rehydrateWebview;
    private postState;
    private _postPendingReviews;
    private _toPendingReviewViewModel;
    private _summarizePendingReviewDiff;
    private _openPendingReviewDiff;
    getActionLogForTest(): ActionExecutionRecord[];
    private _createMessageId;
    private _logContextToOutput;
    private _logTimeoutDiagnostics;
    private _roleMetaFor;
    private _formatAnchorFooterStatus;
    private _contextFooterFor;
    private _applyRenderLimits;
    /**
     * Scan an assistant response for explicit tool-name mentions and stash them
     * in `_primedTools` so the next user turn's `selectToolGroups` call exposes
     * them even when the user replies with something terse like "yes" or "do it".
     *
     * Two signals are honored, structured-first:
     *   1. The structured continuation envelope's `recommended_next_steps[].tool`
     *      field — the authoritative, machine-readable binding emitted by the
     *      ARCHITECT_SUGGEST prompt.
     *   2. Free-text mentions of any available tool name with word-ish boundary
     *      matching — fallback for prose suggestions and older prompts that
     *      don't emit the structured `tool` field.
     *
     * Tool names in this codebase are snake_case identifiers, so a simple
     * non-word boundary check is sufficient for the text fallback.
     */
    private _capturePrimedTools;
    private _buildMessageActions;
    private _detectImplicitEntities;
    private _formatImplicitEntityNotice;
    private _copyMessage;
    private _pinMessage;
    private _runMessageAction;
    /**
     * Post a message to the webview. If the webview is currently hidden or
     * disposed, critical messages are buffered and replayed on the next
     * rehydrateWebview() call to prevent silent loss of stream-end/error events.
     */
    private postMessage;
    private persistMessages;
    private _persistMessagesWithCanonicalAnchorRefresh;
    private restoreMessages;
    private _sendModelUpdate;
    private _checkApiKeyWarning;
    private _architectSettingsTarget;
    private _defaultArchitectBaseUrl;
    private _changeProvider;
    private _changeModel;
    private static readonly MAX_TOOL_ITERATIONS;
    private static readonly MAX_RETRIES;
    private static readonly MAX_VERIFICATION_BATCH_SIZE;
    private static readonly VERIFICATION_TIMEOUT_MS;
    /** Maximum number of autonomous continuation passes to prevent runaway loops. */
    private static readonly MAX_AUTONOMY_PASSES;
    /** Re-read autonomy settings from VS Code configuration and apply. */
    private _syncAutonomyFromSettings;
    /** Called from extension.ts when configuration changes. */
    applyAutonomySettings(): void;
    private _detectAutonomyRequest;
    private _setAutonomyMode;
    private _resetAutonomy;
    private _broadcastAutonomyStatus;
    /**
     * Lever 2 — bind a concrete write tool to apply/patch-style recommended
     * actions when the model emitted them without a `tool` (or with a
     * read-only one). Pure: returns a new array; never mutates inputs.
     * Falls through (no binding) when no write tool is available in the
     * live catalog so the loop never deadlocks.
     */
    private static _bindWriteToolToAnchorActions;
    private _handleAutonomyPassComplete;
    private _runAutonomyContinuationPass;
    /**
     * Build a SUMMARY card payload (pills + Suggested-Actions chips) for the
     * webview from any assistant content. Always emitted — autonomy on or off.
     * The host-side prose extractor synthesizes status + nextSteps when the
     * model didn't emit a JSON envelope, so the card always has data to render.
     */
    /**
     * Sign-off chip emitter. When the autonomy loop stops (budget exhausted,
     * safety cap, decided to pause) we still know what the next concrete
     * actions would have been. Surface them as clickable chips bound to the
     * stop/system message so the user can resume continuation with one click.
     *
     * The chips reuse the same envelope the SUMMARY card emits, so the
     * existing webview chip renderer + `_executeRecommendedAction` resolver
     * (which keys off `_lastRecommendedActions`) work end-to-end without
     * additional wiring. The recommended-action set is also persisted here
     * so chip clicks survive the stop transition.
     */
    private _broadcastSignOffActions;
    private _broadcastSummaryCard;
    /**
     * Strip the structured pass envelope JSON fence from content before displaying.
     * The fence is parsed by extractStructuredPassEnvelope and should not render in chat.
     * Only strips blocks that contain the autonomy contract fields (goal_status).
     */
    private _stripStructuredEnvelope;
    private _formatStopContextBlock;
    private _executeRecommendedAction;
    private _executeAllRecommendedActions;
    /** Re-exported from helpers.ts. */
    private static readonly SECRET_PATTERNS;
    /** Cap on accumulated streaming content to prevent context window overflow
     *  when the agent runs many iterations. Content beyond this is still executed
     *  but not accumulated into streamingContent (the webview already received it). */
    private static readonly MAX_STREAMING_CONTENT_CHARS;
    /** Call callWithTools with automatic retry on 429 rate-limit errors. */
    private _callWithToolsRetry;
    private static _toolTimeoutMs;
    private runAgenticLoop;
    /**
     * Load markdown-it and DOMPurify browser builds from node_modules.
     * Results are cached on the instance. Falls back gracefully if files
     * are missing (e.g. corrupt .vsix or dev environment without npm install).
     */
    private _loadLibrarySources;
    private _getWebviewBundleUri;
    private _redactSecrets;
    /**
     * Best-effort `listTools()` that lazy-connects the MCP client.
     *
     * If the client exists but `connect()` has not run (auto-connect lost
     * the race, or the instance was bound after activation), we try to
     * bring it up here so the architect can use MCP tools without the
     * user having to manually invoke `DreamGraph: Connect`. Failure is
     * non-fatal — we degrade to "no MCP tools" so the architect can still
     * answer using local tools + LLM-only knowledge.
     */
    private _listMcpToolsLazy;
    /**
     * Best-effort `callTool` that lazy-connects the MCP client. Used by
     * the agentic loop so a stale/never-connected client is repaired
     * inline rather than crashing the whole turn.
     */
    private _callMcpToolWithLazyConnect;
    private _executeMessageActionTool;
    private _stringifyToolResult;
    /**
     * Plan \u00a73.2 / \u00a75 settings:
     *   - `expectedTokensPerTurn`     soft target (default 16k)
     *   - `transportCeilingTokens`    safety invariant (default 180k)
     *   - `debtCarryFraction`         debt rollover fraction (default 1.0)
     *
     * Phase 1 is in-memory only. The snapshot is rolled forward on
     * `this._lastBudgetSnapshot`; persistence into chat session state is Phase 2.
     */
    private _createBudgetCoordinatorForTurn;
    private _finalizeCurrentBudgetTurn;
    /** Read-only accessor for context-builder/reasoning-packet wiring. */
    getCurrentBudgetCoordinator(): BudgetCoordinator | null;
    private _summarizeToolArgs;
    private _deriveVerdict;
    private _extractFilesAffected;
    private _verifyEntities;
    private getHtml;
}
export {};
//# sourceMappingURL=chat-panel.d.ts.map