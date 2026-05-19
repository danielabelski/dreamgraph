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
import * as path from 'path';
import * as fs from 'fs';
import type { ChatMemory, PersistedMessage } from './chat-memory';
import { getStyles } from './webview/styles.js';
import { getRenderScript } from './webview/render-markdown.js';
import { getEntityLinksScript } from './webview/entity-links.js';
import { getCardRendererScript } from './webview/card-renderer.js';
import type { GraphSignalProvider } from './graph-signal';
import {
  ANTHROPIC_MODELS,
  COPILOT_CLI_MODELS,
  OPENAI_MODELS,
  type ArchitectContentBlock,
  type ArchitectLlm,
  type ArchitectMessage,
  type ArchitectModelCapabilities,
  type ArchitectProvider,
  type ToolDefinition,
} from './architect-llm';
import type { McpClient } from './mcp-client';
import type { ContextBuilder } from './context-builder';
import type { ChangedFilesView, ChangeType } from './changed-files-view';
import { LOCAL_TOOL_DEFINITIONS, isLocalTool, executeLocalTool } from './local-tools.js';
import { changeReviewService, type PendingChangeReview } from './change-review-service';
import { assemblePrompt, inferTask } from './prompts/index.js';
import { selectToolGroups } from './tool-groups.js';
import { runPassViaCore, runPassViaCopilotCli } from './architect-core/runner.js';
import {
  HOST_CLOCK,
  HOST_CRYPTO,
  HOST_FS,
  HOST_PROCESS,
  createHostAudit,
  createHostRegistry,
  type CopilotCliProviderPortOptions,
  type CopilotCliRunResult,
} from './architect-core/adapters/copilot-cli/index.js';
import type { ChatPanelHost } from './architect-core/adapters/host.js';
import {
  createAutonomyState,
  deriveAutonomyStatusView,
  type AutonomyState,
  type AutonomyInstructionState,
  type RecommendedAction,
} from './autonomy.js';
import { analyzePass, advanceAutonomyStateIfContinued, buildContinuationPrompt, isReadOnlyTool } from './autonomy-loop.js';
import { isWriteToolName, narrowToWriteAndVerify, pickPreferredWriteTool, APPLY_LABEL_PATTERN } from './tool-classification.js';
import { extractStructuredPassEnvelope, type StructuredPassEnvelope } from './autonomy-structured.js';
import { extractPrimaryEnvelope } from './envelope-utils.js';
import { getAutonomyMode, getAutonomyPassBudget, parseAutonomyRequest } from './reporting.js';
import { applyModeProfileToState, getModeProfile, type AutonomyMode } from './autonomy.js';

/**
 * Build the initial AutonomyState for a given mode, honouring the user's
 * explicit `dreamgraph.architect.autoPassBudget` setting when present, but
 * always defaulting to the mode profile's PassBudget + TimeBudget so the
 * header pills are never empty (per ADR-153 — both budgets must be visible).
 */
function _initialAutonomyStateFromSettings(): AutonomyState {
  const mode = getAutonomyMode();
  const explicitBudget = getAutonomyPassBudget();
  const profile = getModeProfile(mode);
  const totalPasses = (typeof explicitBudget === 'number' && explicitBudget > 0) ? explicitBudget : profile.defaultPassBudget;
  return createAutonomyState(mode, totalPasses, profile.defaultTimeBudgetMs, Date.now());
}
import * as helpers from './chat-panel/helpers.js';
import {
  BudgetCoordinator,
  estimateTokensFromString,
  type BudgetSnapshot,
} from './budget-coordinator.js';
import { compressToolResult } from './tool-result-compression.js';
import { RESPONSES_RAW_ITEMS_KEY } from './openai-responses-adapter.js';
import {
  type ImplicitEntityDetectionResult,
  type VerdictBanner,
  type ToolTraceEntry,
} from './chat-panel/helpers.js';
import {
  REQUEST_TIMEOUT_MS as TIMEOUT_REQUEST_MS,
  getLlmTimeoutMs as _getLlmTimeoutMsPure,
  isTimeoutError as _isTimeoutErrorPure,
  buildTimeoutRecoveryPrompt as _buildTimeoutRecoveryPromptPure,
  createTimeoutAbortSignal,
} from './chat-panel/timeout.js';

type ChatRole = 'user' | 'assistant' | 'system';

/* ------------------------------------------------------------------ */
/*  Conversation-history bounding                                     */
/* ------------------------------------------------------------------ */
/**
 * Per-message char caps for what we send to the LLM (display copies are kept full).
 * Without these, a 20-message slice of structured-envelope assistant replies +
 * code-laden user prompts can easily exceed 300KB on its own — before the system
 * prompt and tool schemas are even added — and overflow the request-budget brake.
 */
const HISTORY_RECENT_KEEP = 2;        // Last N messages keep full content.
const HISTORY_RECENT_MAX_CHARS = 16_000;
const HISTORY_OLDER_MAX_CHARS = 4_000;

function _truncateHistoryMessage(content: string, cap: number): string {
  if (content.length <= cap) return content;
  const head = content.slice(0, cap);
  return `${head}\n\n[... ${(content.length - cap).toLocaleString()} chars omitted from history to bound LLM input ...]`;
}

function buildBoundedConversationMessages(
  messages: Array<{ role: ChatRole; content: string; attachments?: ReadonlyArray<ChatMessageAttachmentSnapshot> }>,
  maxRecent: number = 20,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const filtered = messages.filter((m) => m.role === 'user' || m.role === 'assistant') as Array<{
    role: 'user' | 'assistant';
    content: string;
    attachments?: ReadonlyArray<ChatMessageAttachmentSnapshot>;
  }>;
  const sliced = filtered.slice(-maxRecent);
  const recentStart = sliced.length - HISTORY_RECENT_KEEP;
  return sliced.map((m, i) => {
    const cap = i >= recentStart ? HISTORY_RECENT_MAX_CHARS : HISTORY_OLDER_MAX_CHARS;
    const text = _truncateHistoryMessage(m.content, cap);

    // CRITICAL — DO NOT REPLAY ATTACHMENT BYTES IN HISTORY.
    //
    // An earlier iteration of this function inlined image base64 from each
    // user message's `attachments` snapshot as canonical content blocks so
    // the model could "see" prior pictures on follow-up turns. That created
    // an O(turns × image_bytes) wire-cost bomb: a single 1.8 MB attached
    // image was re-serialized on every subsequent prompt — observed live
    // as 5.4 MB / ~1.36 M tokens per request to a chat-completions model.
    //
    // The attachment snapshot persists ONLY for two reasons:
    //   (1) the user-bubble thumbnail / file-info chip in the chat panel,
    //   (2) record-keeping so the user can see what they sent.
    // The model received the image bytes ONCE, on the originating turn, via
    // the live `_buildUserContentBlocks` path. Subsequent turns must NOT
    // re-send them; if the user wants the model to look again they can
    // re-attach (cheap, explicit, observable in token telemetry).
    //
    // We DO surface a tiny text marker so the model knows an image was
    // attached at that point in the conversation — but only as a name/type
    // mention, never bytes.
    const markers: string[] = [];
    if (m.role === 'user' && m.attachments && m.attachments.length > 0) {
      for (const a of m.attachments) {
        markers.push(`[attachment: ${a.name} · ${a.kind} · ${a.mimeType}]`);
      }
    }
    const composed = markers.length > 0 ? `${text}\n\n${markers.join('\n')}` : text;
    return { role: m.role, content: composed };
  });
}

/**
 * Replaces the `content` of tool_result blocks in older user-role messages
 * with a short stub. Keeps the last `keepLastPairs` assistant→tool_result
 * pairs intact (those are still being reasoned over). Older results stay
 * in the message array (so tool_use_id references remain valid) but no
 * longer carry their full payload.
 */
function _elideStaleToolResults(rawMessages: unknown[], keepLastPairs: number): void {
  // Find indices of user-role messages whose content looks like tool_result blocks.
  const toolResultIdx: number[] = [];
  for (let i = 0; i < rawMessages.length; i++) {
    const m = rawMessages[i] as { role?: string; content?: unknown };
    if (m?.role === 'user' && Array.isArray(m.content) && m.content.length > 0 && (m.content[0] as { type?: string })?.type === 'tool_result') {
      toolResultIdx.push(i);
    }
  }
  if (toolResultIdx.length <= keepLastPairs) return;
  const elideUpTo = toolResultIdx.length - keepLastPairs;
  // Threshold below which we leave the content fully intact — small tool results
  // are cheap and stripping them removes essential reasoning context.
  const ELIDE_MIN_CHARS = 2_000;
  // Head/tail snippet sizes preserve enough of the result that the model still
  // remembers what the call returned (signature, key fields, error tail) rather
  // than facing an opaque "[elided]" marker that forces it to re-issue the call.
  const HEAD_KEEP = 800;
  const TAIL_KEEP = 400;
  for (let n = 0; n < elideUpTo; n++) {
    const idx = toolResultIdx[n];
    const msg = rawMessages[idx] as { content: Array<{ type: string; tool_use_id: string; content: string; is_error?: boolean }> };
    msg.content = msg.content.map((b) => {
      if (typeof b.content !== 'string' || b.content.length <= ELIDE_MIN_CHARS) return b;
      const omitted = b.content.length - HEAD_KEEP - TAIL_KEEP;
      const head = b.content.slice(0, HEAD_KEEP);
      const tail = b.content.slice(-TAIL_KEEP);
      return {
        ...b,
        content: `${head}\n\n[... ${omitted.toLocaleString()} chars elided from earlier pass ...]\n\n${tail}`,
      };
    });
  }
}


interface ChatMessageAttachmentSnapshot {
  id: string;
  name: string;
  kind: 'text' | 'image';
  mimeType: string;
  size: number;
  // Present for images so the user bubble can render an inline thumbnail
  // without re-reading the source file. Omitted for text attachments
  // (their bytes were inlined into the prompt; the snapshot is purely
  // informational and should display name/type/size).
  dataBase64?: string;
}

interface ChatMessage {
  id?: string;
  role: ChatRole;
  content: string;
  timestamp: string;
  fullContent?: string;
  instanceId?: string;
  implicitEntityNotice?: string;
  pinned?: boolean;
  sourceMessageId?: string;
  verdict?: VerdictBanner;
  toolTrace?: ToolTraceEntry[];
  anchor?: import('./types.js').SemanticAnchor;
  attachments?: ReadonlyArray<ChatMessageAttachmentSnapshot>;
  /**
   * Stable, persisted tag used by `_buildMessageActions` to deterministically
   * re-attach action buttons after a webview rehydration. Today only used
   * for provider-auth recovery (`'copilot_login_required'`) but kept as an
   * open string union so future provider-specific recoveries (Anthropic
   * key missing, OpenAI org switch, etc.) can add entries without changing
   * the renderer contract.
   */
  metaTag?: 'copilot_login_required';
}

interface MessageAction {
  id: string;
  label: string;
  kind: 'primary' | 'secondary';
  actionType: 'tool' | 'show_full' | 'copilot_login';
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  destructive?: boolean;
}

interface HoverActionState {
  copied?: boolean;
  pinned?: boolean;
}

interface ActionExecutionRecord {
  timestamp: string;
  actionType: string;
  sourceMessageId: string;
  outcome: 'completed' | 'failed' | 'cancelled';
  detail?: string;
}

interface PromptAttachment {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  kind: 'text' | 'image';
  size: number;
  textContent?: string;
  dataBase64?: string;
  note?: string;
}

interface AttachmentPreview {
  id: string;
  name: string;
  kind: 'text' | 'image';
  mimeType: string;
  size: number;
  note?: string;
}

interface EntityVerification {
  status: 'verified' | 'latent' | 'unverified' | 'tension';
  confidence: number;
  lastValidated?: string;
}

type ExtensionToWebviewMessage =
  | { type: 'addMessage'; message: ChatMessage; actions?: MessageAction[]; roleMeta?: { title: string; subtitle?: string }; contextFooter?: string }
  | { type: 'messageActionState'; messageId: string; actionId: string; status: 'loading' | 'completed' | 'failed'; error?: string }
  | { type: 'stream-start' }
  | { type: 'stream-chunk'; chunk: string }
  | { type: 'stream-thinking'; active: boolean }
  | { type: 'stream-end'; done: boolean }
  | { type: 'tool-progress'; tool: string; message: string; progress?: number; total?: number }
  | { type: 'state'; state: { messages: ChatMessage[] } }
  | { type: 'pendingReviews'; reviews: PendingReviewViewModel[]; collapsed?: boolean }
  | { type: 'updateModels'; providers: string[]; models: string[]; current: { provider: string; model: string }; capabilities: ArchitectModelCapabilities }
  | { type: 'setAttachments'; attachments: AttachmentPreview[] }
  | { type: 'error'; error: string }
  | { type: 'restoreDraft'; text: string }
  | { type: 'entityStatus'; requestId: string; results: Record<string, EntityVerification> }
  | { type: 'toolTrace'; calls: ToolTraceEntry[] }
  | { type: 'verdict'; verdict: VerdictBanner }
  | { type: 'autonomyStatus'; status: AutonomyStatusMessage }
  | { type: 'recommendedActions'; messageId: string; actions: RecommendedActionMessage[]; doAllEligible: boolean }
  | { type: 'summaryCard'; messageId: string; envelope: SummaryEnvelopeMessage }
  | { type: 'budgetStatus'; status: BudgetStatusMessage };

interface SummaryEnvelopeMessage {
  summary: string;
  goal_status?: 'complete' | 'partial' | 'blocked';
  progress_status?: 'advancing' | 'slowing' | 'stalled';
  uncertainty?: 'low' | 'medium' | 'high';
  recommended_next_steps: Array<{ id: string; label: string; rationale?: string }>;
  doAllEligible: boolean;
}

interface BudgetStatusMessage {
  /** Plan §5 — turn number this status reflects. */
  turn: number;
  /** Snapshot debt after the turn, in tokens. */
  debtTokens: number;
  /** Total actual tokens consumed this turn. */
  lastActualTokens: number;
  /** Soft target (`expectedTokensPerTurn`) at the time of the turn. */
  expectedTokens: number;
  /** Pressure label as the coordinator reported it at finalize. */
  pressureLabel: 'low' | 'normal' | 'high';
  /** Per-component actuals for the turn (smallest-first ordering left to UI). */
  components: Record<string, number>;
  /** Coordinator-applied delta (overspend +, underspend −) used for debt math. */
  delta: number;
  /** Active model id at finalize. */
  modelId: string;
}

interface AutonomyStatusMessage {
  mode: string;
  countingActive: boolean;
  completed: number;
  remaining: number;
  totalAuthorized?: number;
  /** Per ADR-153 — total wall-clock budget in ms. */
  timeBudgetTotalMs?: number;
  /** Per ADR-153 — epoch ms when the time budget started ticking. */
  timeBudgetStartedAtEpochMs?: number;
  summary: string;
}

interface RecommendedActionMessage {
  id: string;
  label: string;
  rationale?: string;
}

interface PendingReviewDiffLineViewModel {
  kind: 'add' | 'delete';
  text: string;
}

interface PendingReviewViewModel {
  filePath: string;
  relativePath: string;
  status: 'pending' | 'conflict';
  baselineKind: 'existing' | 'missing';
  currentKind: 'existing' | 'deleted';
  updatedAt: number;
  addedLines: number;
  deletedLines: number;
  previewLines: PendingReviewDiffLineViewModel[];
}

function summarizePendingReviewDiff(before: string, after: string): { addedLines: number; deletedLines: number; previewLines: PendingReviewDiffLineViewModel[] } {
  if (before === after) {
    return { addedLines: 0, deletedLines: 0, previewLines: [] };
  }

  const normalizeLines = (text: string): string[] => {
    if (text.length === 0) return [];
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  };

  const beforeLines = normalizeLines(before);
  const afterLines = normalizeLines(after);
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix++;

  let beforeEnd = beforeLines.length - 1;
  let afterEnd = afterLines.length - 1;
  while (beforeEnd >= prefix && afterEnd >= prefix && beforeLines[beforeEnd] === afterLines[afterEnd]) {
    beforeEnd--;
    afterEnd--;
  }

  const deleted = beforeLines.slice(prefix, beforeEnd + 1);
  const added = afterLines.slice(prefix, afterEnd + 1);
  const previewLines: PendingReviewDiffLineViewModel[] = [];
  const maxPreview = 12;
  for (const line of deleted.slice(0, maxPreview)) {
    previewLines.push({ kind: 'delete', text: line });
  }
  for (const line of added.slice(0, Math.max(0, maxPreview - previewLines.length))) {
    previewLines.push({ kind: 'add', text: line });
  }

  return {
    addedLines: added.length,
    deletedLines: deleted.length,
    previewLines,
  };
}

type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'send'; text: string }
  | { type: 'runMessageAction'; messageId: string; actionId: string }
  | { type: 'retryMessage'; messageId: string }
  | { type: 'copyMessage'; messageId: string }
  | { type: 'pinMessage'; messageId: string }
  | { type: 'pickAttachments' }
  | { type: 'removeAttachment'; id: string }
  | { type: 'pasteImage'; dataBase64: string; mimeType: string }
  | { type: 'clear' }
  | { type: 'stop' }
  | { type: 'changeProvider'; provider: string }
  | { type: 'changeModel'; model: string }
  | { type: 'setApiKey' }
  | { type: 'saveDraft'; text: string }
  // Slice 1
  | { type: 'openExternalLink'; url: string }
  | { type: 'copyToClipboard'; text: string }
  // Slice 2
  | { type: 'navigateEntity'; uri: string }
  // Slice 4
  | { type: 'verifyEntities'; requestId: string; names: string[] }
  // Autonomy
  | { type: 'selectRecommendedAction'; actionId: string }
  | { type: 'doAllRecommendedActions' }
  | { type: 'envelopeAction'; label: string }
  | { type: 'envelopeDoAll'; labels: string[] }
  | { type: 'setAutonomyMode'; mode: string }
  | { type: 'resetAutonomy' }
  | { type: 'refreshPendingReviews' }
  | { type: 'togglePendingReviews' }
  | { type: 'keepPendingReview'; filePath: string }
  | { type: 'undoPendingReview'; filePath: string }
  | { type: 'openPendingReview'; filePath: string };

export class ChatPanel implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'dreamgraph.chatView';

  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly messages: ChatMessage[] = [];
  private memory?: ChatMemory;
  private graphSignal?: GraphSignalProvider;
  private architectLlm?: ArchitectLlm;
  private contextBuilder?: ContextBuilder;
  private mcpClient?: McpClient;
  private contextInspector?: import('./context-inspector.js').ContextInspector;
  private _restoringAnchors = false;
  private changedFilesView?: ChangedFilesView;
  private currentInstanceId = 'default';
  private streaming = false;
  private abortController: AbortController | null = null;
  private streamingContent = '';
  private steeringQueue: string[] = [];
  private draftText = '';
  private attachments: PromptAttachment[] = [];
  /** Messages buffered while the webview was hidden. Flushed on rehydrate. */
  private _pendingMessages: ExtensionToWebviewMessage[] = [];

  /** Cached browser build of markdown-it. Loaded once at first getHtml() call. */
  private _markdownItSource: string | null = null;
  /** Cached browser build of DOMPurify. Loaded once at first getHtml() call. */
  private _domPurifySource: string | null = null;
  /** Cached URI to bundled webview runtime for Slice 3 Option C migration. */
  private _webviewBundleUri: string | null = null;
  private _pendingReviewsCollapsed = true;
  private _lastToolTrace: ToolTraceEntry[] = [];
  /** Set when the report-required guard has already forced a final report
   * turn for the current run, so we don't loop forever asking for reports. */
  private _reportForcedThisRun = false;
  /**
   * Phase 2 of the never-fail budget plan (plans/NEVER_FAIL_BUDGET_DEBT_PLAN.md).
   * Snapshot is hydrated from `ChatMemory.loadBudgetState` on restore and
   * persisted via `saveBudgetState` after each `_finalizeCurrentBudgetTurn`.
   * The §9 reload invariant requires byte-for-byte round-trip — `BudgetSnapshot`
   * is plain JSON.
   */
  private _lastBudgetSnapshot: BudgetSnapshot | null = null;
  private _budgetTurnCounter = 0;
  /** The coordinator instantiated for the current turn, if any. */
  private _currentBudgetCoordinator: BudgetCoordinator | null = null;
  /** Set after restoreMessages hydrates persisted budget state, so we don't re-load mid-session. */
  private _budgetStateHydrated = false;
  /**
   * Tool names that the most recent assistant turn explicitly mentioned in its
   * "Suggested Actions" / next-step text. Carried into the next user turn so
   * brief follow-ups ("yes", "do it") still expose the right tools to the
   * agentic loop. Cleared after one turn — see handleUserMessage().
   */
  private _primedTools = new Set<string>();
  /**
   * Names of every tool available on the most recent turn. Stashed here so
   * post-response capture (`_capturePrimedTools`) can scan the assistant text
   * without re-fetching the MCP tool list.
   */
  private _lastAvailableToolNames: string[] = [];
  private _lastVerdict: VerdictBanner | null = null;
  private _actionLog: ActionExecutionRecord[] = [];
  private _actionStateByMessage = new Map<string, Set<string>>();
  private _hoverActionStateByMessage = new Map<string, HoverActionState>();

  /** Autonomy session state — tracks mode, pass budget, and continuation policy. */
  private _autonomyState: AutonomyState = _initialAutonomyStateFromSettings();
  /** Whether autonomy continuation is actively enabled for this session. */
  private _autonomyEnabled = getAutonomyMode() !== 'cautious' || (getAutonomyPassBudget() ?? 0) > 0;
  /** The last set of recommended actions from a pass analysis. */
  private _lastRecommendedActions: RecommendedAction[] = [];
  /** Whether an autonomy continuation loop is currently running. */
  private _autonomyContinuing = false;
  /** Task state captured at loop stop time. Injected into the next turn's system prompt
   * so that "resume" re-enters from a known task position rather than a fresh context. */
  private _lastStopContext: { summary?: string; nextSteps: Array<{ label: string; rationale?: string }> } | null = null;

  private static readonly MAX_RENDERED_MESSAGE_CHARS = 100_000;
  private static readonly MAX_ENTITY_LINKS_PER_MESSAGE = 100;
  private static readonly ACTION_ALLOWLIST = new Set(['tool', 'show_full', 'copilot_login']);

  private static readonly MAX_TEXT_ATTACHMENT_BYTES = 100_000;
  private static readonly MAX_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;

  /** Hard timeout per LLM provider request (ms). Prevents infinite hangs.
   *  Re-exported from chat-panel/timeout.ts so existing call sites keep working. */
  private static readonly REQUEST_TIMEOUT_MS = TIMEOUT_REQUEST_MS;

  private static readonly TEXT_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.txt', '.py', '.cs', '.java', '.go', '.rs', '.yml', '.yaml', '.xml', '.html', '.css', '.scss', '.sql', '.sh'
  ]);

  private static readonly IMAGE_MIME_BY_EXT: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  };

  constructor(private readonly context: vscode.ExtensionContext) {}

  public setGraphSignal(provider: GraphSignalProvider): void { this.graphSignal = provider; }
  public setMemory(memory: ChatMemory): void { this.memory = memory; }
  public setArchitectLlm(llm: ArchitectLlm): void { this.architectLlm = llm; }
  public setContextBuilder(cb: ContextBuilder): void { this.contextBuilder = cb; }
  public setMcpClient(mcp: McpClient): void { this.mcpClient = mcp; }
  public setChangedFilesProvider(provider: ChangedFilesView): void { this.changedFilesView = provider; }
  public setContextInspector(inspector: import('./context-inspector.js').ContextInspector): void { this.contextInspector = inspector; }

  public setInstance(instanceId: string): void {
    if (this.currentInstanceId === instanceId) return;
    this.currentInstanceId = instanceId;
    void this.restoreMessages();
  }

  public get isVisible(): boolean { return this.view?.visible ?? false; }

  public addExternalMessage(role: ChatRole, content: string): void {
    const msg: ChatMessage = { id: this._createMessageId(), role, content, timestamp: new Date().toISOString(), instanceId: this.currentInstanceId };
    this.messages.push(msg);
    void this.persistMessages();
    void this.postMessage({ type: 'addMessage', message: msg, actions: this._buildMessageActions(msg), roleMeta: this._roleMetaFor(msg), contextFooter: this._contextFooterFor(msg) });
  }

  public open(): void { void vscode.commands.executeCommand('dreamgraph.chatView.focus'); }

  public async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.onDidDispose(() => {
      if (this.view === webviewView) this.view = undefined;
    }, null, this.disposables);

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) void this.rehydrateWebview();
    }, null, this.disposables);

    webviewView.webview.onDidReceiveMessage(async (message: WebviewToExtensionMessage) => {
      switch (message.type) {
        case 'ready':
          this._syncAutonomyFromSettings();
          await this.rehydrateWebview();
          if (!this.architectLlm?.currentConfig) await this.architectLlm?.loadConfig();
          this._sendModelUpdate();
          this._checkApiKeyWarning();
          await this._syncAttachments();
          break;
        case 'send':
          if (typeof message.text === 'string' && message.text.trim().length > 0) {
            if (this.streaming) {
              this.steeringQueue.push(message.text.trim());
              const steerMsg = `\n\n💬 *Steering: "${message.text.trim()}"*\n`;
              this.streamingContent += steerMsg;
              void this.postMessage({ type: 'stream-chunk', chunk: steerMsg });
            } else {
              await this.handleUserMessage(message.text.trim());
            }
          }
          break;
        case 'pickAttachments':
          await this._pickAttachments();
          break;
        case 'removeAttachment':
          this.attachments = this.attachments.filter((a) => a.id !== message.id);
          await this._syncAttachments();
          break;
        case 'pasteImage':
          await this._handlePastedImage(message.dataBase64, message.mimeType);
          break;
        case 'clear':
          await this.clearMessages();
          break;
        case 'stop':
          this.abortGeneration();
          break;
        case 'changeProvider':
          await this._changeProvider(message.provider as ArchitectProvider);
          break;
        case 'changeModel':
          if (message.model === '__custom__') {
            const custom = await vscode.window.showInputBox({ prompt: 'Enter a custom model name', placeHolder: 'e.g. claude-sonnet-4' });
            if (custom) await this._changeModel(custom); else this._sendModelUpdate();
          } else {
            await this._changeModel(message.model);
          }
          break;
        case 'setApiKey':
          await vscode.commands.executeCommand('dreamgraph.setArchitectApiKey');
          break;
        case 'saveDraft':
          this.draftText = message.text ?? '';
          break;
        case 'openExternalLink': {
          const url = (message as { type: 'openExternalLink'; url: string }).url;
          if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
            void vscode.env.openExternal(vscode.Uri.parse(url));
          }
          break;
        }
        case 'copyToClipboard': {
          const text = (message as { type: 'copyToClipboard'; text: string }).text;
          if (typeof text === 'string') {
            void vscode.env.clipboard.writeText(text);
          }
          break;
        }
        case 'navigateEntity': {
          // Slice 2 — entity URI navigation. Delegate to VS Code command if registered,
          // or fall back to opening a graph query for the referenced entity.
          const uri = (message as { type: 'navigateEntity'; uri: string }).uri;
          if (typeof uri === 'string' && /^[a-z-]+:\/\//.test(uri)) {
            const [scheme, rawName = ''] = uri.split('://');
            const name = decodeURIComponent(rawName);

            // file:// URIs open the file directly in the editor
            if (scheme === 'file') {
              const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
              const absPath = path.isAbsolute(name) ? name : path.resolve(ws, name);
              let opened = false;
              try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));
                await vscode.window.showTextDocument(doc, { preview: true });
                opened = true;
              } catch {
                // Direct path failed — search workspace for the filename
              }
              if (!opened) {
                const basename = name.includes('/') ? name : `**/${name}`;
                const matches = await vscode.workspace.findFiles(basename, '**/node_modules/**', 5);
                if (matches.length === 1) {
                  const doc = await vscode.workspace.openTextDocument(matches[0]);
                  await vscode.window.showTextDocument(doc, { preview: true });
                } else if (matches.length > 1) {
                  const picked = await vscode.window.showQuickPick(
                    matches.map((m) => ({ label: vscode.workspace.asRelativePath(m), uri: m })),
                    { placeHolder: `Multiple matches for ${name}` },
                  );
                  if (picked) {
                    const doc = await vscode.workspace.openTextDocument(picked.uri);
                    await vscode.window.showTextDocument(doc, { preview: true });
                  }
                } else {
                  void vscode.window.showWarningMessage(`Could not open file: ${name}`);
                }
              }
              break;
            }

            vscode.commands.executeCommand('dreamgraph.navigateEntity', uri).then(
              undefined,
              async () => {
                const query = scheme === 'data-model'
                  ? `Search data model for ${name}`
                  : `Explain ${uri} in system context`;
                await this.handleUserMessage(query);
              },
            );
          }
          break;
        }
        case 'verifyEntities': {
          const { requestId, names } = message as { type: 'verifyEntities'; requestId: string; names: string[] };
          const results = await this._verifyEntities(names);
          await this.postMessage({ type: 'entityStatus', requestId, results });
          break;
        }
        case 'runMessageAction': {
          await this._runMessageAction(message.messageId, message.actionId);
          break;
        }
        case 'retryMessage': {
          const original = this.messages.find((m) => m.id === message.messageId && m.role === 'user');
          if (original) await this.handleUserMessage(original.content);
          break;
        }
        case 'copyMessage': {
          await this._copyMessage(message.messageId);
          break;
        }
        case 'pinMessage': {
          await this._pinMessage(message.messageId);
          break;
        }
        case 'selectRecommendedAction': {
          const actionMsg = message as { type: 'selectRecommendedAction'; actionId: string; label?: string; labels?: string[] };
          await this._executeRecommendedAction(actionMsg.actionId, actionMsg.label);
          break;
        }
        case 'doAllRecommendedActions': {
          const actionMsg = message as { type: 'doAllRecommendedActions'; labels?: string[] };
          await this._executeAllRecommendedActions(actionMsg.labels);
          break;
        }
        case 'envelopeAction': {
          const envMsg = message as { type: 'envelopeAction'; label: string };
          if (envMsg.label) await this.handleUserMessage(envMsg.label);
          break;
        }
        case 'envelopeDoAll': {
          const envAllMsg = message as { type: 'envelopeDoAll'; labels: string[] };
          const labels = Array.isArray(envAllMsg.labels) ? envAllMsg.labels : [];
          if (labels.length === 1) {
            await this.handleUserMessage(labels[0]);
          } else if (labels.length > 1) {
            const combined = `Execute these steps sequentially:\n${labels.map((l, i) => `${i + 1}. ${l}`).join('\n')}`;
            await this.handleUserMessage(combined);
          }
          break;
        }
        case 'setAutonomyMode': {
          const modeMsg = message as { type: 'setAutonomyMode'; mode: string };
          this._setAutonomyMode(modeMsg.mode);
          break;
        }
        case 'resetAutonomy': {
          this._resetAutonomy();
          break;
        }
        case 'refreshPendingReviews': {
          await this._postPendingReviews();
          break;
        }
        case 'togglePendingReviews': {
          this._pendingReviewsCollapsed = !this._pendingReviewsCollapsed;
          await this._postPendingReviews();
          break;
        }
        case 'keepPendingReview': {
          const result = await changeReviewService.keep(message.filePath);
          void vscode.window.showInformationMessage(result.message);
          await this._postPendingReviews();
          break;
        }
        case 'undoPendingReview': {
          const result = await changeReviewService.undo(message.filePath);
          void vscode.window.showInformationMessage(result.message);
          await this._postPendingReviews();
          break;
        }
        case 'openPendingReview': {
          await this._openPendingReviewDiff(message.filePath);
          break;
        }
      }
    }, null, this.disposables);

    await this.rehydrateWebview();
  }

  public async clearMessages(): Promise<void> {
    this.messages.splice(0, this.messages.length);
    await this.persistMessages();
    await this.postState();
  }

  public dispose(): void {
    while (this.disposables.length > 0) this.disposables.pop()?.dispose();
  }

  async handleUserMessage(text: string): Promise<void> {
  if (this.streaming) {
    this.steeringQueue.push(text);
    return;
  }

  const trimmed = text.trim();
  if (!trimmed && this.attachments.length === 0) return;

  const provider = this.architectLlm?.provider ?? 'anthropic';
  // Phase 3 — instantiate per-turn BudgetCoordinator before building the
  // envelope so `buildEnvelope` can adapt deep-insights / environment trim
  // to the coordinator's pressure label (Plan §4.4).
  this._budgetTurnCounter += 1;
  this._currentBudgetCoordinator = this._createBudgetCoordinatorForTurn();
  const envelope = this.contextBuilder
    ? await this.contextBuilder.buildEnvelope(trimmed, 'chat', this._currentBudgetCoordinator)
    : null;
  const liveAnchor = envelope?.activeFile?.selection?.anchor ?? envelope?.activeFile?.cursorAnchor;
  const userMessage: ChatMessage = {
    id: this._createMessageId(),
    role: 'user',
    content: trimmed,
    fullContent: trimmed,
    timestamp: new Date().toISOString(),
    instanceId: this.currentInstanceId,
    anchor: liveAnchor,
    // Snapshot the prompt-bar attachments onto the durable user message so
    // the chat bubble can render thumbnails/file-info even after the prompt
    // bar is cleared (and after restoreState rehydrates from disk).
    attachments: this.attachments.length > 0
      ? this.attachments.map((a) => ({
          id: a.id,
          name: a.name,
          kind: a.kind,
          mimeType: a.mimeType,
          size: a.size,
          dataBase64: a.kind === 'image' ? a.dataBase64 : undefined,
        }))
      : undefined,
  };
  this.messages.push(userMessage);
  if (this.contextBuilder) {
    await this._persistMessagesWithCanonicalAnchorRefresh(envelope);
  } else {
    await this.persistMessages();
  }

  this._lastToolTrace = [];
  this._lastVerdict = null;
  this._reportForcedThisRun = false;
  await this.postState();
  await this.postMessage({ type: 'toolTrace', calls: [] });
  this._autonomyEnabled = getAutonomyMode() !== 'cautious' || (getAutonomyPassBudget() ?? 0) > 0;
  this._autonomyState = _initialAutonomyStateFromSettings();
  this._lastRecommendedActions = [];
  this._autonomyContinuing = false;
  // Capture task continuation context before clearing it — it will be injected
  // into this turn's system prompt so "resume" re-enters from the known task position.
  const stopContextForThisTurn = this._lastStopContext;
  this._lastStopContext = null;
  this._broadcastAutonomyStatus();

  const autonomyRequest = parseAutonomyRequest(trimmed, this._autonomyState);
  if (
    autonomyRequest.mode !== this._autonomyState.mode ||
    autonomyRequest.totalAuthorizedPasses !== this._autonomyState.totalAuthorizedPasses
  ) {
    this._autonomyEnabled = true;
    this._autonomyState = {
      mode: autonomyRequest.mode,
      remainingAutoPasses: autonomyRequest.remainingAutoPasses,
      completedAutoPasses: autonomyRequest.completedAutoPasses,
      totalAuthorizedPasses: autonomyRequest.totalAuthorizedPasses,
    };
    this._broadcastAutonomyStatus();
  }

  if (!this.architectLlm || !this.contextBuilder || !envelope) {
    const missing = !this.architectLlm ? 'Architect LLM' : !this.contextBuilder ? 'ContextBuilder' : 'Context envelope';
    const assistantMessage: ChatMessage = {
      id: this._createMessageId(),
      role: 'assistant',
      content: `${missing} is not configured.`,
      timestamp: new Date().toISOString(),
      instanceId: this.currentInstanceId,
      verdict: { level: 'speculative', summary: `${missing} unavailable` },
    };
    this.messages.push(assistantMessage);
    await this.persistMessages();
    await this.postState();
    return;
  }

  const task = inferTask(envelope.intentMode ?? 'ask_dreamgraph', undefined, trimmed);
  // Phase 1+3 — coordinator was created earlier (before buildEnvelope) so the
  // context tier could read pressure. Reuse it here for the tool-result layer.
  const contextResult = await this._buildPromptContext(task, envelope, trimmed, 'chat');

  await this._logContextToOutput(envelope, contextResult.reasoningPacket);

  const attachmentInstruction = this._attachmentSummaryForUserMessage();
  // If a previous autonomy loop stopped with task state, inject it as a
  // continuation context block so the model knows where to resume from.
  const continuationContext = stopContextForThisTurn
    ? this._formatStopContextBlock(stopContextForThisTurn)
    : '';
  const additionalInstructions = [attachmentInstruction, continuationContext].filter(Boolean).join('\n\n');
  const autonomyInstructionState = this._autonomyEnabled
    ? { ...this._autonomyState, enabled: true }
    : undefined;
  const prompt = assemblePrompt(
    task,
    envelope,
    contextResult.assembledContext,
    additionalInstructions || undefined,
    autonomyInstructionState,
    provider,
    contextResult.reasoningPacket?.task?.lens,
  );

  const conversation: ArchitectMessage[] = [
    { role: 'system', content: prompt.system },
    // Cap conversation history at the most recent 20 user/assistant turns AND
    // truncate per-message content (most-recent 2 keep up to 16KB, older capped at 4KB).
    // Without these caps a single prompt can pull in 200-600KB of prior assistant
    // envelopes + tool-trace text and tip the request into long-context pricing.
    // Image attachment BYTES are intentionally NOT replayed across turns —
    // see `buildBoundedConversationMessages`. Each user message carries a
    // tiny `[attachment: name · kind · mime]` text marker for context only.
    ...buildBoundedConversationMessages(this.messages, 20)
      .map((message) => ({ role: message.role, content: message.content }) as ArchitectMessage),
  ];

  // ADR-089 Phase 3b — capture per-turn attachment state into outer-scope
  // vars so the seam path (`_buildCorePassHost`) can hand the SAME blocks /
  // dropped-name list / summary string to `runPassViaCore`. The inline path
  // mutates `conversation` and clears `this.attachments` immediately; without
  // capturing here, the seam would see empty attachment state and silently
  // drop image bytes. These vars are populated inside the attachments block
  // below and consumed at the seam call site (~line 882).
  let capturedTurnBlocks: ArchitectContentBlock[] | undefined;
  let capturedDroppedAttachmentNames: string[] = [];
  const capturedAttachmentSummary = attachmentInstruction;
  const capturedStopContextBlock: string | undefined = continuationContext || undefined;
  // Read the seam routing flag once; controls whether the inline path
  // owns the attachment clear (false) or defers it to `host.clearAttachments`
  // inside `runPass` step 7 (true).
  const useCorePass = vscode.workspace.getConfiguration('dreamgraph.architect').get<boolean>('useCorePass') === true;
  // The copilot-cli provider always routes through the architect-core
  // seam (`runPassViaCopilotCli`), so attachment lifecycle, host
  // persistence, and tool clearing all flow through `runPass` step 7
  // exactly like the `useCorePass` path. Treat the two routes
  // identically for any pre-seam state mutation guards.
  const copilotCliPreRoute = (this.architectLlm?.currentConfig?.provider ?? '') === 'copilot-cli';
  const seamLifecycle = useCorePass || copilotCliPreRoute;

  // D3 — multi-modal: if the user attached files, replace the last user
  // message's content with typed content blocks so architect-llm's per-provider
  // serializers (`_toAnthropicContent` → `image`, `_toOpenAIContent` →
  // `image_url`) actually transmit the bytes. The seam is provider-adaptive;
  // this call site just produces the canonical block array. Without this the
  // attachment was only visible as the text summary in the system prompt and
  // the image bytes never reached the model.
  if (this.attachments.length > 0) {
    const caps = this.architectLlm?.getModelCapabilities() ?? { textAttachments: false, imageAttachments: false };
    const droppedImages = this.attachments.filter((a) => a.kind === 'image' && (!caps.imageAttachments || !a.dataBase64));
    if (droppedImages.length > 0) {
      const providerLabel = this.architectLlm?.provider ?? 'current provider';
      const modelLabel = this.architectLlm?.currentConfig?.model ?? 'current model';
      const names = droppedImages.map((a) => a.name).join(', ');
      const noticeMsg: ChatMessage = {
        id: this._createMessageId(),
        role: 'system',
        content: `Image attachment${droppedImages.length > 1 ? 's' : ''} not sent: ${providerLabel}/${modelLabel} does not accept images. (${names})`,
        timestamp: new Date().toISOString(),
        instanceId: this.currentInstanceId,
      };
      this.messages.push(noticeMsg);
      await this.persistMessages();
      await this.postMessage({ type: 'addMessage', message: noticeMsg, actions: [], roleMeta: this._roleMetaFor(noticeMsg), contextFooter: undefined });
      capturedDroppedAttachmentNames = droppedImages.map((a) => a.name);
    }
    const blocks = this._buildUserContentBlocks(trimmed);
    for (let i = conversation.length - 1; i >= 0; i--) {
      if (conversation[i].role === 'user') {
        conversation[i] = { role: 'user', content: blocks };
        break;
      }
    }
    capturedTurnBlocks = blocks;
    // Attachments are bound to the message that just shipped — they are NOT
    // pinned across future turns. On the inline path we clear before the
    // network call so the user can immediately attach something new for the
    // next prompt. On the seam path the driver clears via `host.clearAttachments`
    // inside `runPass` step 7 (same lifecycle, just owned by the seam).
    if (!seamLifecycle) {
      this.attachments = [];
      // Broadcast the cleared attachment list so the prompt-bar chips
      // disappear immediately. `postState()` only carries `messages`; the
      // attachment chips are driven by the `setAttachments` channel.
      await this._syncAttachments();
    }
  }

  this.streaming = true;
  this.streamingContent = '';
  this.abortController = new AbortController();

  try {
    await this.postMessage({ type: 'stream-start' });

    let fullContent = '';
    // Set to true when the architect-core seam (`runPassViaCore`) handles
    // assistant-message persistence and broadcasts via `host.persistAssistantMessage`.
    // The inline post-LLM block then skips its duplicate push/persist/broadcast.
    let seamOwnedAssistant = false;
    const mcpTools = await this._listMcpToolsLazy();
    const allTools: ToolDefinition[] = [
      ...mcpTools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
      })),
      ...LOCAL_TOOL_DEFINITIONS.map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema as Record<string, unknown>,
      })),
    ];

    // Tool whitelisting: send only an intent-appropriate subset (typically 6-14 tools)
    // instead of all 70+. The full schemas are ~82KB / ~20k tokens — sent on every
    // pass of the agentic loop. This is the dominant input-cost driver.
    const toolDecision = selectToolGroups({
      task,
      intentMode: envelope?.intentMode,
      prompt: trimmed,
      autonomy: this._autonomyEnabled,
      availableToolNames: allTools.map((t) => t.name),
      primedTools: Array.from(this._primedTools),
    });
    // Primed tools are consumed for this turn; the next assistant response
    // will repopulate the set if it suggests further actions.
    this._primedTools.clear();
    this._lastAvailableToolNames = allTools.map((t) => t.name);
    const selectedSet = new Set(toolDecision.selected);
    const tools: ToolDefinition[] = allTools.filter((t) => selectedSet.has(t.name));
    this.contextInspector?.appendContextLine(
      `Tool selection: ${tools.length}/${allTools.length} tools — groups=[${toolDecision.groups.join(', ')}] mutating=${toolDecision.mutating} autonomy=${toolDecision.autonomy}; ${toolDecision.rationale}`,
    );

    // Copilot CLI executes its tool calls in-process via the
    // DreamGraph stdio MCP bridge, so we MUST NOT also drive an
    // agentic loop in this process — that would attempt to dispatch
    // tools twice and the CLI doesn't return ToolUseRequests anyway.
    // Force the no-tools branch and let `runPassViaCopilotCli` own
    // the turn end-to-end.
    const copilotCliRoute = (this.architectLlm?.currentConfig?.provider ?? '') === 'copilot-cli';
    let effectiveTools: ToolDefinition[] = copilotCliRoute ? [] : tools;

    // Cross-turn write-pressure narrowing. The autonomy-continuation path
    // (see ~line 2459) already narrows the live tool catalog to write+verify
    // when both the prior and current pass were locate-only with a sticky
    // anchor. But when the user manually re-clicks a "Patch …" action chip
    // (or otherwise starts a fresh non-continuation pass) the autonomy
    // state still carries `lastPassWasLocateOnly === true` and a non-empty
    // `lastAnchorPaths` from the previous turn, yet the catalog is
    // rebuilt from intent classification alone — typically full of read
    // tools. That is exactly the loop the user kept hitting: "Discovered
    // … no code changes were applied this turn" repeating across manual
    // re-clicks. Mirror the same narrowing here so the next manual retry
    // is forced toward the write path. `narrowToWriteAndVerify` already
    // falls back to the full catalog if narrowing would empty it, so
    // this is always safe.
    if (
      !copilotCliRoute
      && effectiveTools.length > 0
      && this._autonomyState.lastPassWasLocateOnly === true
      && (this._autonomyState.lastAnchorPaths?.length ?? 0) > 0
    ) {
      const narrowed = narrowToWriteAndVerify(effectiveTools);
      if (narrowed.length > 0 && narrowed.length < effectiveTools.length) {
        this.contextInspector?.appendContextLine(
          `Tool narrowing (cross-turn write-pressure): ${narrowed.length}/${effectiveTools.length} tools — sticky anchor + prior pass was locate-only.`,
        );
        effectiveTools = narrowed;
      }
    }

    if (effectiveTools.length > 0) {
      fullContent = await this.runAgenticLoop(conversation, effectiveTools);
    } else {
      // ADR-089 Phase 3a — text-only seam route. When the user enables
      // `dreamgraph.architect.useCorePass`, the no-tools branch goes
      // through `runPassViaCore` so the architect-core driver exercises
      // the real v1-bound port set end-to-end. The inline fallback
      // below remains the source of truth when the flag is off, and is
      // also the safety net if the host preconditions don't hold.
      // Phase 3b — attachment state captured upstream (`capturedTurnBlocks`,
      // `capturedDroppedAttachmentNames`, `capturedAttachmentSummary`,
      // `capturedStopContextBlock`) is threaded into the host so the seam
      // sees the SAME multi-modal blocks the inline path would have shipped.
      if (useCorePass || copilotCliRoute) {
        const host = this._buildCorePassHost(
          envelope,
          task,
          contextResult,
          conversation,
          conversation,
          {
            contentBlocks: capturedTurnBlocks,
            droppedAttachmentNames: capturedDroppedAttachmentNames,
            attachmentSummary: capturedAttachmentSummary,
            stopContextBlock: capturedStopContextBlock,
          },
        );
        const req = this._createRequestSignal(this._getLlmTimeoutMs({ mode: 'stream' }));
        try {
          const passResult = copilotCliRoute
            ? await runPassViaCopilotCli({
                host,
                text: trimmed,
                tools: [],
                providerOptions: this._buildCopilotCliProviderOptions(),
                onStreamChunk: (chunk: string) => {
                  const safeChunk = this._redactSecrets(chunk);
                  fullContent += safeChunk;
                  this.streamingContent += safeChunk;
                  void this.postMessage({ type: 'stream-chunk', chunk: safeChunk });
                },
                abortSignal: req.signal,
              })
            : await runPassViaCore({
                host,
                text: trimmed,
                tools: [],
                onStreamChunk: (chunk: string) => {
                  const safeChunk = this._redactSecrets(chunk);
                  fullContent += safeChunk;
                  this.streamingContent += safeChunk;
                  void this.postMessage({ type: 'stream-chunk', chunk: safeChunk });
                },
                abortSignal: req.signal,
              });
          if (!fullContent && passResult.assistantMessage.content) {
            fullContent = passResult.assistantMessage.content;
          }
          if (passResult.stopReason === 'error') {
            throw new Error(`runPassViaCore reported error stopReason: ${passResult.assistantMessage.content}`);
          }
          // The seam's `host.persistAssistantMessage` already pushed the
          // assistant message, persisted, and broadcast verdict/toolTrace/
          // summary card. Mark the inline post-LLM block to skip so we
          // don't double-write or double-broadcast.
          seamOwnedAssistant = true;
        } finally {
          req.dispose();
        }
      } else {
        const req = this._createRequestSignal(this._getLlmTimeoutMs({ mode: 'stream' }));
        try {
          await this.architectLlm.stream(conversation, (chunk: string) => {
            const safeChunk = this._redactSecrets(chunk);
            fullContent += safeChunk;
            this.streamingContent += safeChunk;
            void this.postMessage({ type: 'stream-chunk', chunk: safeChunk });
          }, req.signal);
        } finally {
          req.dispose();
        }
      }
    }

    const cleaned = fullContent.trim() || '(No response)';
    if (seamOwnedAssistant) {
      // The architect-core seam already pushed the assistant message,
      // persisted, and broadcast verdict/toolTrace/summary card via
      // `host.persistAssistantMessage`. Nothing more to do for this turn.
    } else {
    this._capturePrimedTools(cleaned, this._lastAvailableToolNames);
    const assistantMessage: ChatMessage = {
      id: this._createMessageId(),
      role: 'assistant',
      content: cleaned,
      fullContent: cleaned,
      timestamp: new Date().toISOString(),
      instanceId: this.currentInstanceId,
      verdict: this._lastVerdict ?? undefined,
      toolTrace: this._lastToolTrace.length > 0 ? [...this._lastToolTrace] : undefined,
    };
    this.messages.push(assistantMessage);
    if (this.contextBuilder) {
      await this._persistMessagesWithCanonicalAnchorRefresh(envelope);
    } else {
      await this.persistMessages();
    }
    await this.postState();
    if (this._lastVerdict) {
      await this.postMessage({ type: 'verdict', verdict: this._lastVerdict });
    }
    await this.postMessage({ type: 'toolTrace', calls: this._lastToolTrace });
    // Always broadcast a SUMMARY card (pills + Suggested Actions chips) for
    // every assistant turn — autonomy on or off. Built from the structured
    // JSON envelope when present, or synthesized from prose headings/bullets
    // when not. The webview renders this as a separate card under the bubble
    // using window.renderEnvelope, so prose markdown is preserved.
    if (assistantMessage.id) {
      this._broadcastSummaryCard(cleaned, assistantMessage.id);
    }
    if (this._autonomyEnabled && assistantMessage.id) {
      // Pass cleaned (with envelope intact) so the parser can extract goal_status etc.
      await this._handleAutonomyPassComplete(
        cleaned,
        assistantMessage.id,
        conversation,
        tools,
      );
    }
    }
  } catch (err) {
    const recovered = await this._recoverFromLlmTimeout(err, trimmed, envelope);
    if (!recovered) {
      const message = err instanceof Error ? err.message : String(err);
      // Provider-auth recovery: copilot-cli surfaces "not logged in" as a
      // structured failure with a stable code. When we see it, emit a
      // dedicated system message carrying the `copilot_login_required`
      // meta-tag — `_buildMessageActions` then attaches a clickable
      // "Open Copilot login" button that opens the device-code page +
      // an interactive `copilot login` terminal in one click. The tag
      // is persisted on the message so the button survives reloads.
      const failureCode = (err as { copilotCliFailureCode?: unknown } | null)?.copilotCliFailureCode;
      if (failureCode === 'COPILOT_NOT_LOGGED_IN') {
        const loginMessage: ChatMessage = {
          id: this._createMessageId(),
          role: 'system',
          content:
            `Copilot CLI is not logged in.\n\n` +
            `Click **Open Copilot login** below to (1) open the GitHub device-code page in your browser and (2) launch an interactive \`copilot login\` terminal. Paste the code the CLI prints into the browser page, then re-run your request.`,
          timestamp: new Date().toISOString(),
          instanceId: this.currentInstanceId,
          metaTag: 'copilot_login_required',
        };
        this.messages.push(loginMessage);
        await this.persistMessages();
        await this.postMessage({
          type: 'addMessage',
          message: loginMessage,
          actions: this._buildMessageActions(loginMessage),
          roleMeta: this._roleMetaFor(loginMessage),
          contextFooter: undefined,
        });
      } else {
        const assistantMessage: ChatMessage = {
          id: this._createMessageId(),
          role: 'assistant',
          content: `Error: ${message}`,
          timestamp: new Date().toISOString(),
          instanceId: this.currentInstanceId,
          verdict: { level: 'speculative', summary: 'Request failed before completion' },
          toolTrace: this._lastToolTrace.length > 0 ? [...this._lastToolTrace] : undefined,
        };
        this.messages.push(assistantMessage);
        await this.persistMessages();
        await this.postState();
        await this.postMessage({ type: 'error', error: message });
      }
    }
  } finally {
    this._finalizeCurrentBudgetTurn();
    this.resetStreamState();
  }
}

  private async _buildPromptContext(
  task: ReturnType<typeof inferTask>,
  envelope: import('./types.js').EditorContextEnvelope,
  promptText?: string,
  commandSource?: string,
): Promise<{ assembledContext: string; reasoningPacket: import('./types.js').ReasoningPacket | null }> {
  if (!this.contextBuilder) {
    return { assembledContext: '', reasoningPacket: null };
  }

  if (task === 'patch') {
    const cfg = vscode.workspace.getConfiguration('dreamgraph.architect');
    const pressureSignalEnabled = cfg.get<boolean>('pressureSignalEnabled') ?? true;
    const reasoningPacket = await this.contextBuilder.buildReasoningPacket(envelope, {
      prompt: promptText,
      commandSource,
      coordinator: this._currentBudgetCoordinator ?? undefined,
      pressureSignalEnabled,
    });
    return {
      assembledContext: this.contextBuilder.renderReasoningPacket(reasoningPacket).text,
      reasoningPacket,
    };
  }

  const assembled = await this.contextBuilder.assembleContextBlock(
    envelope,
    promptText ?? null,
    new Map(),
  );
  return {
    assembledContext: assembled.text,
    reasoningPacket: null,
  };
}

  /**
   * Build the per-turn `CopilotCliProviderPortOptions` used by
   * `runPassViaCopilotCli`. Reads three settings (binary name,
   * dreamgraph stdio command, hard timeout), points the bridge audit
   * sink at the extension's globalStorage so transcripts survive
   * window reloads, and threads the active workspace folder as the
   * CLI's invocation cwd so file tools resolve relative paths the
   * way the user expects.
   */
  private _buildCopilotCliProviderOptions(): CopilotCliProviderPortOptions {
    if (!this.architectLlm) {
      throw new Error('Cannot build Copilot CLI provider options: architectLlm is not initialized.');
    }
    const llm = this.architectLlm;
    const cfg = vscode.workspace.getConfiguration('dreamgraph.architect');
    const binaryName = (cfg.get<string>('copilotCli.command') ?? '').trim() || 'copilot';
    const dreamgraphCommand = (cfg.get<string>('copilotCli.dreamgraphCommand') ?? '').trim() || 'dreamgraph';
    const timeoutMsRaw = cfg.get<number>('copilotCli.timeoutMs');
    const timeoutMs = typeof timeoutMsRaw === 'number' && Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
      ? timeoutMsRaw
      : 180_000;
    const toolListTimeoutMsRaw = cfg.get<number>('copilotCli.toolListTimeoutMs');
    const toolListTimeoutMs = typeof toolListTimeoutMsRaw === 'number' && Number.isFinite(toolListTimeoutMsRaw) && toolListTimeoutMsRaw > 0
      ? toolListTimeoutMsRaw
      : undefined;

    const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const auditDirAbsPath = vscode.Uri.joinPath(this.context.globalStorageUri, 'copilot-cli-audit').fsPath;
    const bridgeEntryPath = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'copilot-cli-bridge.js').fsPath;

    const registry = createHostRegistry({
      dreamgraphCommand,
      bridgeEntryPath,
      nodeExecPath: process.execPath,
      auditDirAbsPath,
      ...(toolListTimeoutMs !== undefined ? { toolListTimeoutMs } : {}),
    });
    const mcpAudit = createHostAudit({ auditDirAbsPath });

    const model = llm.currentConfig?.model;
    return {
      hostLlm: llm,
      invocationCwd: workspaceCwd,
      timeoutMs,
      baseEnv: process.env,
      // Skip the `--model` flag when the user picked `auto` so the
      // CLI applies its own routing heuristic.
      model: model && model !== 'auto' ? model : undefined,
      binaryName,
      deps: {
        fs: HOST_FS,
        process: HOST_PROCESS,
        crypto: HOST_CRYPTO,
        clock: HOST_CLOCK,
        registry,
        mcpAudit,
      },
      onRunResult: (result: CopilotCliRunResult): void => {
        // Surface failures into the existing tool-trace channel so
        // the user sees them next to MCP tool entries. Best-effort:
        // never let observer code break the turn.
        try {
          if (!result.ok) {
            const code = result.failure?.code ?? 'COPILOT_CLI_UNKNOWN_FAILURE';
            const message = result.failure?.message ?? 'Copilot CLI run failed';
            console.warn(`[DreamGraph][copilot-cli] ${code}: ${message}`);
          }
        } catch {
          // ignore
        }
      },
    };
  }

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
  private _buildCorePassHost(
    envelope: import('./types.js').EditorContextEnvelope,
    task: ReturnType<typeof inferTask>,
    contextResult: { assembledContext: string; reasoningPacket: import('./types.js').ReasoningPacket | null },
    conversation: ArchitectMessage[],
    llmConversationForAutonomy: ArchitectMessage[],
    perTurn: {
      contentBlocks: ArchitectContentBlock[] | undefined;
      droppedAttachmentNames: readonly string[];
      attachmentSummary: string;
      stopContextBlock: string | undefined;
    },
  ): ChatPanelHost {
    // The seam composer rebuilds `conversation` from prior + new turn,
    // so it only needs the prior slice. We strip the outer system message
    // and the trailing user turn that handleUserMessage already added.
    const priorMessages: ArchitectMessage[] = conversation
      .filter((m) => m.role !== 'system')
      .slice(0, -1);

    const llm = this.architectLlm!;
    const cb = this.contextBuilder!;
    const panel = this;

    return {
      architectLlm: llm,
      contextBuilder: cb,
      budgetCoordinator: this._currentBudgetCoordinator,
      priorMessages,
      task,
      envelope,
      contextResult,
      autonomyState: this._autonomyState,
      autonomyEnabled: this._autonomyEnabled,
      // Phase 3b — real per-turn projection. The inline path computed
      // these once upstream (block array, dropped image names, summary
      // for the system prompt, continuation block from prior stop-context).
      // The seam reuses them verbatim so multi-modal bytes, dropped-image
      // awareness, and resume framing all reach `runPass` unchanged.
      stopContextBlock: perTurn.stopContextBlock,
      contentBlocks: perTurn.contentBlocks,
      droppedAttachmentNames: perTurn.droppedAttachmentNames,
      attachmentSummary: perTurn.attachmentSummary,

      // Idempotent user-message persistence. `handleUserMessage` already
      // pushed the user turn at line ~694 (always, for crash safety
      // before the LLM call); the seam's call here detects that and
      // re-runs the canonical anchor-refresh persist so the durable
      // store always sees the latest envelope. If the predicate ever
      // widens to a path where the user message has NOT been pre-pushed,
      // this method will push it before persisting. Real work both ways.
      persistUserMessage: async (text: string, _contentBlocks?: readonly unknown[]) => {
        void _contentBlocks;
        const last = panel.messages[panel.messages.length - 1];
        const alreadyPushed = !!last && last.role === 'user' && (last.fullContent ?? last.content) === text;
        if (!alreadyPushed) {
          const userMsg: ChatMessage = {
            id: panel._createMessageId(),
            role: 'user',
            content: text,
            fullContent: text,
            timestamp: new Date().toISOString(),
            instanceId: panel.currentInstanceId,
          };
          panel.messages.push(userMsg);
        }
        if (panel.contextBuilder) {
          await panel._persistMessagesWithCanonicalAnchorRefresh(envelope);
        } else {
          await panel.persistMessages();
        }
      },

      // Canonical assistant-turn handling — single source of truth for
      // assistant persistence on the seam path. Mirrors the inline
      // continuation post-processing (verdict-derive, render-limit,
      // implicit-entity detect) so both `handleUserMessage` AND
      // `_runAutonomyContinuationPass` get identical treatment when they
      // route through the seam. `addMessage` (single bubble append) is
      // used instead of `postState` (full re-render) to preserve the
      // bubble's enter animation and the user's scroll state — also
      // matches v1 continuation's broadcast.
      persistAssistantMessage: async (args) => {
        const rawContent = (args.content ?? '').trim() || '(No response)';
        // Per-chunk redaction already happened in onStreamChunk; this is
        // an idempotent safety net for the assembled string and any
        // non-streamed (tool-loop) content path that didn't pass through.
        const redactedFullContent = panel._redactSecrets(rawContent);
        panel._capturePrimedTools(redactedFullContent, panel._lastAvailableToolNames);
        // Verdict is recomputed from the assistant text + tool trace so
        // continuation passes (which run without an upstream verdict
        // assignment) get a fresh assessment, not a stale `_lastVerdict`.
        const derivedVerdict = panel._deriveVerdict(redactedFullContent, panel._lastToolTrace);
        if (derivedVerdict) {
          panel._lastVerdict = derivedVerdict;
        }
        const finalContent = panel._applyRenderLimits(redactedFullContent);
        const implicitEntities = panel._detectImplicitEntities(redactedFullContent);
        const implicitEntityNotice = implicitEntities.names.length > 0
          ? panel._formatImplicitEntityNotice(implicitEntities)
          : undefined;
        const assistantMessage: ChatMessage = {
          id: panel._createMessageId(),
          role: 'assistant',
          content: finalContent.content,
          fullContent: redactedFullContent,
          implicitEntityNotice,
          timestamp: new Date().toISOString(),
          instanceId: panel.currentInstanceId,
          verdict: panel._lastVerdict ?? undefined,
          toolTrace: panel._lastToolTrace.length > 0 ? [...panel._lastToolTrace] : undefined,
        };
        panel.messages.push(assistantMessage);
        if (panel.contextBuilder) {
          await panel._persistMessagesWithCanonicalAnchorRefresh(envelope);
        } else {
          await panel.persistMessages();
        }
        if (panel._lastVerdict) {
          await panel.postMessage({ type: 'verdict', verdict: panel._lastVerdict });
        }
        await panel.postMessage({ type: 'toolTrace', calls: panel._lastToolTrace });
        await panel.postMessage({
          type: 'addMessage',
          message: assistantMessage,
          actions: panel._buildMessageActions(assistantMessage),
          roleMeta: panel._roleMetaFor(assistantMessage),
          contextFooter: panel._contextFooterFor(assistantMessage),
        });
        if (assistantMessage.id) {
          panel._broadcastSummaryCard(redactedFullContent, assistantMessage.id);
        }
        if (panel._autonomyEnabled && assistantMessage.id) {
          await panel._handleAutonomyPassComplete(
            redactedFullContent,
            assistantMessage.id,
            llmConversationForAutonomy,
            [],
          );
        }
      },

      // Real, idempotent — clears the panel's pending-attachment array
      // exactly as v1's inline path does at line ~819. Must broadcast via
      // `_syncAttachments` so the prompt-bar chips disappear in the webview;
      // mutating `panel.attachments` alone leaves the chips lingering until
      // the next user-driven attachment change.
      clearAttachments: async () => {
        panel.attachments = [];
        await panel._syncAttachments();
      },

      // Real, conditional — Phase 3a's routing predicate excludes
      // autonomy, so this branch is currently unreachable; the
      // implementation matches v1 inline behavior so widening the
      // predicate in Phase 3c needs no change here.
      recordPassCompleted: async (_args) => {
        void _args;
        // Inline assistant-handling already invoked _handleAutonomyPassComplete
        // through persistAssistantMessage when autonomy was enabled. Nothing
        // additional to record at the seam level for v1 today; the autonomy
        // state machine carries its own bookkeeping and is the source of truth.
      },

      // Fail-loud: the Phase 3a predicate guarantees tools=[] reaches
      // the seam, so this hook is unreachable. If someone widens the
      // predicate without wiring a real executor, this throws so the
      // first tool-call attempt surfaces the bug immediately.
      executeTool: async () => {
        throw new Error(
          'ChatPanelHost.executeTool: not wired in Phase 3a (text-only seam route). ' +
            'Widen the routing predicate in handleUserMessage only after implementing this hook ' +
            'against runAgenticLoop\'s per-tool dispatch (isLocalTool/_callMcpToolWithLazyConnect, ' +
            'compressToolResult, _lastToolTrace push, contextBuilder.maybeInvalidateForTool).',
        );
      },

      getProviderCapabilities: () =>
        llm.getModelCapabilities() ?? { textAttachments: false, imageAttachments: false },
    };
  }

  private _buildUserContentBlocks(text: string): ArchitectContentBlock[] {
    const capabilities = this.architectLlm?.getModelCapabilities() ?? { textAttachments: false, imageAttachments: false };
    const blocks: ArchitectContentBlock[] = [{ type: 'text', text }];

    for (const attachment of this.attachments) {
      if (attachment.kind === 'text' && capabilities.textAttachments && attachment.textContent) {
        blocks.push({
          type: 'text',
          text: `Attached file: ${attachment.name}\nPath: ${attachment.path}\n\n${attachment.textContent}`,
        });
      } else if (attachment.kind === 'image' && capabilities.imageAttachments && attachment.dataBase64) {
        blocks.push({
          type: 'image',
          mimeType: attachment.mimeType,
          dataBase64: attachment.dataBase64,
          fileName: attachment.name,
        });
      } else if (attachment.kind === 'image') {
        blocks.push({ type: 'text', text: `[Image attachment omitted: current model does not support image input] ${attachment.name}` });
      }
    }

    return blocks;
  }

  private _attachmentSummaryForUserMessage(): string {
    if (this.attachments.length === 0) return '';
    const lines = this.attachments.map((a) => `- ${a.name} (${a.kind}${a.note ? `, ${a.note}` : ''})`);
    return `Attachments:\n${lines.join('\n')}`;
  }

  private async _pickAttachments(): Promise<void> {
    const picks = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Attach to Architect prompt',
      filters: {
        'Supported files': ['ts', 'tsx', 'js', 'jsx', 'json', 'md', 'txt', 'py', 'cs', 'java', 'go', 'rs', 'yml', 'yaml', 'xml', 'html', 'css', 'scss', 'sql', 'sh', 'png', 'jpg', 'jpeg', 'webp', 'gif'],
      },
    });
    if (!picks || picks.length === 0) return;

    const capabilities = this.architectLlm?.getModelCapabilities() ?? { textAttachments: false, imageAttachments: false };
    const next: PromptAttachment[] = [];
    const errors: string[] = [];

    for (const uri of picks) {
      try {
        const ext = path.extname(uri.fsPath).toLowerCase();
        const stat = await vscode.workspace.fs.stat(uri);
        const name = path.basename(uri.fsPath);
        const imageMime = ChatPanel.IMAGE_MIME_BY_EXT[ext];

        if (imageMime) {
          if (!capabilities.imageAttachments) {
            errors.push(`${name}: current model does not support image attachments.`);
            continue;
          }
          if (stat.size > ChatPanel.MAX_IMAGE_ATTACHMENT_BYTES) {
            errors.push(`${name}: image exceeds 5 MB limit.`);
            continue;
          }
          const bytes = await vscode.workspace.fs.readFile(uri);
          next.push({
            id: `${Date.now()}-${Math.random()}`,
            name,
            path: uri.fsPath,
            mimeType: imageMime,
            kind: 'image',
            size: stat.size,
            dataBase64: Buffer.from(bytes).toString('base64'),
          });
          continue;
        }

        if (ChatPanel.TEXT_EXTENSIONS.has(ext)) {
          if (!capabilities.textAttachments) {
            errors.push(`${name}: current model does not support text attachments.`);
            continue;
          }
          const bytes = await vscode.workspace.fs.readFile(uri);
          let textContent = Buffer.from(bytes).toString('utf8');
          let note: string | undefined;
          if (Buffer.byteLength(textContent, 'utf8') > ChatPanel.MAX_TEXT_ATTACHMENT_BYTES) {
            textContent = textContent.slice(0, ChatPanel.MAX_TEXT_ATTACHMENT_BYTES);
            note = 'truncated to 100 KB';
          }
          next.push({
            id: `${Date.now()}-${Math.random()}`,
            name,
            path: uri.fsPath,
            mimeType: 'text/plain',
            kind: 'text',
            size: stat.size,
            textContent,
            note,
          });
          continue;
        }

        errors.push(`${name}: unsupported file type.`);
      } catch (error) {
        errors.push(`${uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (next.length > 0) {
      this.attachments = [...this.attachments, ...next];
      await this._syncAttachments();
    }
    if (errors.length > 0) {
      void this.postMessage({ type: 'error', error: errors.join(' ') });
    }
  }

  private async _syncAttachments(): Promise<void> {
    await this.postMessage({
      type: 'setAttachments',
      attachments: this.attachments.map((a) => ({ id: a.id, name: a.name, kind: a.kind, mimeType: a.mimeType, size: a.size, note: a.note })),
    });
  }

  private async _handlePastedImage(dataBase64: string, mimeType: string): Promise<void> {
    const capabilities = this.architectLlm?.getModelCapabilities() ?? { textAttachments: false, imageAttachments: false };
    if (!capabilities.imageAttachments) {
      void this.postMessage({ type: 'error', error: 'Current model does not support image attachments.' });
      return;
    }
    const rawSize = Math.ceil((dataBase64.length * 3) / 4);
    if (rawSize > ChatPanel.MAX_IMAGE_ATTACHMENT_BYTES) {
      void this.postMessage({ type: 'error', error: 'Pasted image exceeds 5 MB limit.' });
      return;
    }
    const ext = mimeType === 'image/png' ? '.png' : mimeType === 'image/jpeg' ? '.jpg' : mimeType === 'image/webp' ? '.webp' : '.png';
    const name = `clipboard-${Date.now()}${ext}`;
    this.attachments.push({
      id: `${Date.now()}-${Math.random()}`,
      name,
      path: '',
      mimeType,
      kind: 'image',
      size: rawSize,
      dataBase64,
    });
    await this._syncAttachments();
  }

  private abortGeneration(): void { this.abortController?.abort(); }

  /**
   * Create a child AbortSignal that fires on EITHER user abort OR timeout.
   * Returns a dispose function that MUST be called when the request completes
   * to prevent timer leaks.
   */
  private _createRequestSignal(timeoutMs = ChatPanel.REQUEST_TIMEOUT_MS): { signal: AbortSignal; dispose: () => void } {
    return createTimeoutAbortSignal(this.abortController, timeoutMs);
  }

  private _getLlmTimeoutMs(options: { mode: 'stream' | 'tool'; toolCount?: number; reducedContext?: boolean }): number {
    return _getLlmTimeoutMsPure({ ...options, provider: this.architectLlm?.provider ?? 'anthropic' });
  }

  private _isTimeoutError(err: unknown): boolean {
    return _isTimeoutErrorPure(err);
  }

  private _buildTimeoutRecoveryPrompt(originalText: string): string {
    return _buildTimeoutRecoveryPromptPure(originalText);
  }

  private async _recoverFromLlmTimeout(
    err: unknown,
    originalText: string,
    envelope: import('./types.js').EditorContextEnvelope | null,
  ): Promise<boolean> {
    if (!this._isTimeoutError(err) || !this.architectLlm) return false;

    const provider = this.architectLlm.provider ?? 'unknown';
    const model = this.architectLlm.currentConfig?.model;
    const recoveryTimeoutMs = this._getLlmTimeoutMs({ mode: 'stream', reducedContext: true });
    const notice = `\n⚠️ LLM request timed out for provider \`${provider}\`. Retrying once with reduced context and a faster recovery strategy…\n`;
    this.streamingContent += notice;
    await this.postMessage({ type: 'stream-chunk', chunk: notice });

    const recoveryPrompt = this._buildTimeoutRecoveryPrompt(originalText);
    const task = inferTask(envelope?.intentMode ?? 'ask_dreamgraph');
    const autonomyInstruction: AutonomyInstructionState | undefined = this._autonomyEnabled
      ? { ...this._autonomyState, enabled: true }
      : undefined;
    const { system } = assemblePrompt(task, envelope, undefined, undefined, autonomyInstruction, provider);
    const recoveryMessages: ArchitectMessage[] = [{ role: 'system', content: system }];
    for (const msg of this.messages.slice(-8)) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        recoveryMessages.push({ role: msg.role, content: msg.content });
      }
    }
    recoveryMessages.push({ role: 'user', content: recoveryPrompt });

    let fullContent = '';
    const req = this._createRequestSignal(recoveryTimeoutMs);
    try {
      await this.architectLlm.stream(recoveryMessages, (chunk: string) => {
        const safeChunk = this._redactSecrets(chunk);
        fullContent += safeChunk;
        this.streamingContent += safeChunk;
        void this.postMessage({ type: 'stream-chunk', chunk: safeChunk });
      }, req.signal);
    } catch (recoveryErr) {
      this._logTimeoutDiagnostics({
        provider,
        model,
        mode: 'stream',
        timeoutMs: recoveryTimeoutMs,
        recoveryAttempted: true,
        recovered: false,
        toolCount: 0,
        usedReducedContext: true,
        errorMessage: recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr),
      });
      return false;
    } finally {
      req.dispose();
    }

    this._logTimeoutDiagnostics({
      provider,
      model,
      mode: 'stream',
      timeoutMs: recoveryTimeoutMs,
      recoveryAttempted: true,
      recovered: true,
      toolCount: 0,
      usedReducedContext: true,
      errorMessage: err instanceof Error ? err.message : String(err),
    });

    const redactedFullContent = this._redactSecrets(fullContent);
    this._capturePrimedTools(redactedFullContent, this._lastAvailableToolNames);
    const finalContent = this._applyRenderLimits(redactedFullContent);
    const implicitEntities = this._detectImplicitEntities(redactedFullContent);
    const implicitEntityNotice = implicitEntities.names.length > 0
      ? this._formatImplicitEntityNotice(implicitEntities)
      : undefined;

    const recoveredMessage: ChatMessage = {
      id: this._createMessageId(),
      role: 'assistant',
      content: finalContent.content,
      fullContent: redactedFullContent,
      implicitEntityNotice,
      timestamp: new Date().toISOString(),
      instanceId: this.currentInstanceId,
      verdict: this._deriveVerdict(redactedFullContent, this._lastToolTrace) ?? undefined,
      toolTrace: this._lastToolTrace.length > 0 ? [...this._lastToolTrace] : undefined,
    };
    this.messages.push(recoveredMessage);
    await this.persistMessages();
    await this.postMessage({
      type: 'addMessage',
      message: recoveredMessage,
      actions: this._buildMessageActions(recoveredMessage),
      roleMeta: this._roleMetaFor(recoveredMessage),
      contextFooter: this._contextFooterFor(recoveredMessage),
    });
    return true;
  }

  /**
   * Reset ALL streaming-related state in one place.
   * Sends cleanup messages to the webview so the UI never stays stuck.
   */
  private resetStreamState(): void {
    this.streaming = false;
    this.streamingContent = '';
    this.steeringQueue = [];
    this.abortController = null;
    void this.postMessage({ type: 'stream-thinking', active: false });
    if (this._lastVerdict) {
      void this.postMessage({ type: 'verdict', verdict: this._lastVerdict });
    }
    void this.postMessage({ type: 'toolTrace', calls: this._lastToolTrace });
    void this.postMessage({ type: 'stream-end', done: true });
  }

  private async rehydrateWebview(): Promise<void> {
    await this.postState();
    if (this.draftText) await this.postMessage({ type: 'restoreDraft', text: this.draftText });
    await this._syncAttachments();
    await this._postPendingReviews();
    // Patch #1.5: always broadcast autonomy state so the header dropdown +
    // pass-budget pill stay populated even when the active mode is cautious.
    this._broadcastAutonomyStatus();
  }

  private async postState(): Promise<void> {
    await this.postMessage({ type: 'state', state: { messages: this.messages } });
    await this._postPendingReviews();
  }

  private async _postPendingReviews(): Promise<void> {
    const reviews = await Promise.all(changeReviewService.getPendingReviews().map((review) => this._toPendingReviewViewModel(review)));
    if (reviews.length === 0) {
      this._pendingReviewsCollapsed = true;
    }
    await this.postMessage({ type: 'pendingReviews', reviews, collapsed: this._pendingReviewsCollapsed });
  }

  private async _toPendingReviewViewModel(review: PendingChangeReview): Promise<PendingReviewViewModel> {
    const diff = await this._summarizePendingReviewDiff(review);
    return {
      filePath: review.filePath,
      relativePath: vscode.workspace.asRelativePath(review.filePath),
      status: review.status === 'conflict' ? 'conflict' : 'pending',
      baselineKind: review.baselineKind,
      currentKind: review.currentKind,
      updatedAt: review.updatedAt,
      addedLines: diff.addedLines,
      deletedLines: diff.deletedLines,
      previewLines: diff.previewLines,
    };
  }

  private async _summarizePendingReviewDiff(review: PendingChangeReview): Promise<{ addedLines: number; deletedLines: number; previewLines: PendingReviewDiffLineViewModel[] }> {
    const decoder = new TextDecoder('utf-8');
    const before = review.baselineContent ? decoder.decode(review.baselineContent) : '';
    let after = '';
    if (review.currentKind !== 'deleted') {
      try {
        after = decoder.decode(await vscode.workspace.fs.readFile(vscode.Uri.file(review.filePath)));
      } catch {
        after = '';
      }
    }
    return summarizePendingReviewDiff(before, after);
  }

  private async _openPendingReviewDiff(filePath: string): Promise<void> {
    const review = changeReviewService.getPendingReview(filePath);
    const fileUri = vscode.Uri.file(filePath);
    if (!review) {
      await vscode.commands.executeCommand('vscode.open', fileUri);
      return;
    }

    const currentDoc = await vscode.workspace.openTextDocument(fileUri);
    const currentText = currentDoc.getText();
    const baselineText = review.baselineContent ? Buffer.from(review.baselineContent).toString('utf8') : '';
    const baselineUri = fileUri.with({ scheme: 'untitled', path: `${fileUri.path}.dreamgraph-baseline` });
    await vscode.workspace.openTextDocument(baselineUri);
    const baselineEdit = new vscode.WorkspaceEdit();
    baselineEdit.insert(baselineUri, new vscode.Position(0, 0), baselineText);
    await vscode.workspace.applyEdit(baselineEdit);
    await vscode.commands.executeCommand('vscode.diff', baselineUri, fileUri, `Pending Review: ${vscode.workspace.asRelativePath(filePath)}`);
    if (currentText.length === 0 && review.currentKind === 'deleted') {
      void vscode.window.showInformationMessage('Current file is deleted; diff shows baseline versus current state.');
    }
  }

  public getActionLogForTest(): ActionExecutionRecord[] {
    return this._actionLog;
  }

  private _createMessageId(): string {
    return helpers.createMessageId();
  }

  private async _logContextToOutput(
  envelope: import('./types.js').EditorContextEnvelope | null,
  packet: import('./types.js').ReasoningPacket | null,
): Promise<void> {
  if (!envelope || !this.contextInspector) return;
  try {
    this.contextInspector.logContextRequestBoundary({
      instanceId: envelope.instanceId ?? undefined,
      intentMode: envelope.intentMode,
    });
    this.contextInspector.logEnvelope(envelope);
    if (packet) {
      this.contextInspector.logReasoningPacket(packet);
    }
  } catch {
    // Best-effort transparency logging only.
  }
}

  private _logTimeoutDiagnostics(event: {
    provider: string;
    model?: string;
    mode: 'stream' | 'tool';
    timeoutMs: number;
    recoveryAttempted: boolean;
    recovered: boolean;
    toolCount?: number;
    usedReducedContext?: boolean;
    errorMessage: string;
  }): void {
    try {
      this.contextInspector?.logTimeoutDiagnostics(event);
    } catch {
      // Best-effort diagnostics logging only.
    }
  }

    private _roleMetaFor(message: ChatMessage): { title: string; subtitle?: string } {
    if (message.role === 'assistant') {
      return { title: 'DreamGraph Architect', subtitle: 'Graph-grounded assistant' };
    }
    if (message.role === 'user') {
      return { title: 'You' };
    }
    return { title: 'System' };
  }

    private _formatAnchorFooterStatus(anchor: import('./types.js').SemanticAnchor): string {
      return helpers.formatAnchorFooterStatus(anchor);
    }

    private _contextFooterFor(message: ChatMessage): string {
    const scope = message.instanceId ?? this.currentInstanceId;
    const anchor = message.anchor;

    const anchorStatus = anchor ? this._formatAnchorFooterStatus(anchor) : undefined;

    if (message.role === 'assistant') {
      return `Instance: ${scope} • Actions require explicit click • Trace reflects real tool execution • Context packet logged to DreamGraph Context`;
    }
    if (message.role === 'user') {
      return anchorStatus ? `Instance: ${scope} • ${anchorStatus}` : `Instance: ${scope}`;
    }
    return `Instance: ${scope} • System message`;
  }

  private _applyRenderLimits(content: string): { content: string; truncated: boolean } {
    return helpers.applyRenderLimits(content, ChatPanel.MAX_RENDERED_MESSAGE_CHARS);
  }

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
  private _capturePrimedTools(text: string, availableToolNames: string[]): void {
    if (!text) return;
    const availableSet = new Set(availableToolNames);

    // Structured envelope binding — authoritative.
    try {
      const envelope = extractStructuredPassEnvelope(text);
      if (envelope.nextSteps.length > 0) {
        // Persist for chip-click resolution — _executeRecommendedAction needs
        // this to look up the tool binding for clicks outside the autonomy
        // loop (which is the only other path that populates this list).
        this._lastRecommendedActions = envelope.nextSteps;
      }
      for (const step of envelope.nextSteps) {
        if (step.tool && availableSet.has(step.tool)) {
          this._primedTools.add(step.tool);
        }
      }
    } catch {
      // Envelope parsing must never break message handling.
    }

    // Free-text fallback — catches tools mentioned in prose without a binding.
    const lower = text.toLowerCase();
    for (const name of availableToolNames) {
      const lname = name.toLowerCase();
      if (lname.length < 3) continue;
      const idx = lower.indexOf(lname);
      if (idx === -1) continue;
      const before = idx === 0 ? '' : lower[idx - 1];
      const after = idx + lname.length >= lower.length ? '' : lower[idx + lname.length];
      const isWordChar = (c: string): boolean => /[a-z0-9_]/.test(c);
      if (before && isWordChar(before)) continue;
      if (after && isWordChar(after)) continue;
      this._primedTools.add(name);
    }
  }

  private _buildMessageActions(message: ChatMessage): MessageAction[] {
    const actions: MessageAction[] = [];
    if (message.role === 'assistant') {
      if (message.content.includes('[Response truncated]')) {
        actions.push({ id: 'show-full', label: 'Show full', kind: 'primary', actionType: 'show_full' });
      }
    }
    // Provider-auth recovery actions are reattached deterministically from
    // the persisted `metaTag` so they survive webview rehydration (the
    // original `addMessage` action list is not part of `messages[]`).
    if (message.metaTag === 'copilot_login_required') {
      actions.push({ id: 'copilot-login', label: 'Open Copilot login', kind: 'primary', actionType: 'copilot_login' });
    }
    return actions;
  }

  private _detectImplicitEntities(content: string): ImplicitEntityDetectionResult {
    return helpers.detectImplicitEntities(content, ChatPanel.MAX_ENTITY_LINKS_PER_MESSAGE);
  }

  private _formatImplicitEntityNotice(result: ImplicitEntityDetectionResult): string {
    return helpers.formatImplicitEntityNotice(result);
  }

  private async _copyMessage(messageId: string): Promise<void> {
    const message = this.messages.find((entry) => entry.id === messageId);
    if (!message) {
      return;
    }
    await vscode.env.clipboard.writeText(message.fullContent ?? message.content);
    this._hoverActionStateByMessage.set(messageId, {
      ...(this._hoverActionStateByMessage.get(messageId) ?? {}),
      copied: true,
    });
  }

  private async _pinMessage(messageId: string): Promise<void> {
    const message = this.messages.find((entry) => entry.id === messageId);
    if (!message) {
      return;
    }
    message.pinned = !message.pinned;
    this._hoverActionStateByMessage.set(messageId, {
      ...(this._hoverActionStateByMessage.get(messageId) ?? {}),
      pinned: Boolean(message.pinned),
    });
    await this.persistMessages();
    await this.postState();
  }

  private async _runMessageAction(messageId: string, actionId: string): Promise<void> {
    const message = this.messages.find((m) => m.id === messageId);
    const action = message ? this._buildMessageActions(message).find((a) => a.id === actionId) : undefined;
    if (!message || !action || !ChatPanel.ACTION_ALLOWLIST.has(action.actionType)) {
      void vscode.window.showErrorMessage('Action unavailable.');
      this._actionLog.push({ timestamp: new Date().toISOString(), actionType: actionId, sourceMessageId: messageId, outcome: 'failed', detail: 'unavailable' });
      return;
    }

    await this.postMessage({ type: 'messageActionState', messageId, actionId, status: 'loading' });

    if (action.destructive) {
      const choice = await vscode.window.showWarningMessage(
        `Run destructive action "${action.label}"?`,
        { modal: true },
        'Run',
      );
      if (choice !== 'Run') {
        this._actionLog.push({ timestamp: new Date().toISOString(), actionType: action.actionType, sourceMessageId: messageId, outcome: 'cancelled', detail: action.id });
        await this.postMessage({ type: 'messageActionState', messageId, actionId, status: 'failed', error: 'Cancelled' });
        return;
      }
    }

    try {
      if (action.actionType === 'copilot_login') {
        // Provider-auth recovery: GitHub Copilot's `login` subcommand runs
        // the OAuth device-code flow interactively (prints an 8-char code,
        // expects the user to paste it at github.com/login/device). We
        // can't wrap that headlessly, so:
        //   1. Open the device-code page in the user's default browser
        //      so it is ready to receive the code, then
        //   2. Spawn an interactive terminal running `copilot login` so
        //      the code is visible and the CLI can complete the handshake.
        // The binary name honours the same setting the adapter uses, so
        // a user who installed a non-default Copilot CLI still gets the
        // right command.
        const cfg = vscode.workspace.getConfiguration('dreamgraph.architect.copilotCli');
        const binaryName = (cfg.get<string>('binaryName') ?? 'copilot').trim() || 'copilot';
        try {
          await vscode.env.openExternal(vscode.Uri.parse('https://github.com/login/device'));
        } catch (openErr) {
          // Browser open is best-effort — the device code printed by the
          // CLI also includes a URL the user can copy manually.
          console.warn('[DreamGraph] copilot_login: openExternal failed', openErr);
        }
        const terminal = vscode.window.createTerminal({ name: 'Copilot Login' });
        terminal.show(true);
        terminal.sendText(`${binaryName} login`);
        this._actionLog.push({ timestamp: new Date().toISOString(), actionType: action.actionType, sourceMessageId: messageId, outcome: 'completed', detail: binaryName });
        await this.postMessage({ type: 'messageActionState', messageId, actionId, status: 'completed' });
        return;
      }

      if (action.actionType === 'show_full') {
        if (!message.fullContent || message.fullContent === message.content) {
          throw new Error('Full response is not available for this message.');
        }
        message.content = message.fullContent;
        const implicitEntities = this._detectImplicitEntities(message.fullContent);
        message.implicitEntityNotice = implicitEntities.names.length > 0
          ? this._formatImplicitEntityNotice(implicitEntities)
          : undefined;
        await this.persistMessages();
        await this.postState();
        this._actionLog.push({ timestamp: new Date().toISOString(), actionType: action.actionType, sourceMessageId: messageId, outcome: 'completed', detail: action.id });
        await this.postMessage({ type: 'messageActionState', messageId, actionId, status: 'completed' });
        return;
      }

      if (action.actionType === 'tool') {
        if (!action.toolName) {
          throw new Error('Tool action is missing a tool name.');
        }
        const result = await this._executeMessageActionTool(action.toolName, action.toolArgs ?? {});
        // Patch #1 (renderer invariant): never dump raw JSON into chat.
        // Emit a typed `outcome` fence the webview renders as a collapsible
        // OutcomeCard. The payload sits inside an inner <details> so it is
        // recordable but never leaks into the visible surface by default.
        const payloadText = typeof result === 'string'
          ? result
          : helpers.safeStringifyForOutcome(result);
        const summaryLine = helpers.summarizeOutcomePayload(payloadText);
        const fenceBody = [
          `tool: ${action.toolName}`,
          `status: ok`,
          summaryLine ? `summary: ${summaryLine}` : '',
          '',
          this._redactSecrets(payloadText),
        ].filter((l, i) => l !== '' || i === 3).join('\n');
        const toolMessage: ChatMessage = {
          id: this._createMessageId(),
          role: 'system',
          content: `Action result (${action.label})\n\n\`\`\`outcome\n${fenceBody}\n\`\`\``,
          timestamp: new Date().toISOString(),
          instanceId: this.currentInstanceId,
        };
        this.messages.push(toolMessage);
        await this.persistMessages();
        await this.postMessage({ type: 'addMessage', message: toolMessage, actions: this._buildMessageActions(toolMessage), roleMeta: this._roleMetaFor(toolMessage), contextFooter: this._contextFooterFor(toolMessage) });
        this._actionLog.push({ timestamp: new Date().toISOString(), actionType: action.actionType, sourceMessageId: messageId, outcome: 'completed', detail: action.toolName });
        await this.postMessage({ type: 'messageActionState', messageId, actionId, status: 'completed' });
        return;
      }

      throw new Error('Unsupported action type.');
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      this._actionLog.push({ timestamp: new Date().toISOString(), actionType: action.actionType, sourceMessageId: messageId, outcome: 'failed', detail: messageText });
      await this.postMessage({ type: 'messageActionState', messageId, actionId, status: 'failed', error: messageText });
      void vscode.window.showErrorMessage(messageText);
    }
  }

  /**
   * Post a message to the webview. If the webview is currently hidden or
   * disposed, critical messages are buffered and replayed on the next
   * rehydrateWebview() call to prevent silent loss of stream-end/error events.
   */
  private async postMessage(message: ExtensionToWebviewMessage): Promise<void> {
    if (this.view?.webview) {
      // Flush any buffered messages first so order is preserved
      if (this._pendingMessages.length > 0) {
        const pending = this._pendingMessages.splice(0);
        for (const m of pending) {
          try { await this.view.webview.postMessage(m); } catch { /* view may have gone */ }
        }
      }
      await this.view.webview.postMessage(message);
    } else {
      // Buffer stream-end and error messages so they are not silently lost
      // when the webview is hidden (e.g. user switched panel). Streaming
      // chunks are intentionally dropped — they would be stale on reconnect.
      const type = (message as { type: string }).type;
      if (type === 'stream-end' || type === 'stream-thinking' || type === 'error' || type === 'addMessage') {
        this._pendingMessages.push(message);
      }
    }
  }

  private async persistMessages(): Promise<void> {
    if (!this.memory) return;
    await this.memory.save(this.currentInstanceId, this.messages as PersistedMessage[]);
  }

  private async _persistMessagesWithCanonicalAnchorRefresh(
    envelope: import('./types.js').EditorContextEnvelope | null,
  ): Promise<void> {
    if (!this.memory) return;

    const canonicalAnchor = envelope?.activeFile?.selection?.anchor ?? envelope?.activeFile?.cursorAnchor;
    if (canonicalAnchor?.canonicalId) {
      for (let index = this.messages.length - 1; index >= 0; index -= 1) {
        const message = this.messages[index];
        if (message.role !== 'user' || !message.anchor) continue;
        if (message.instanceId && message.instanceId !== this.currentInstanceId) continue;
        if (message.anchor.canonicalId) break;
        if (message.anchor.path !== canonicalAnchor.path) continue;
        this.messages[index] = {
          ...message,
          anchor: {
            ...message.anchor,
            canonicalId: canonicalAnchor.canonicalId,
            canonicalKind: canonicalAnchor.canonicalKind,
            migrationStatus: canonicalAnchor.migrationStatus ?? message.anchor.migrationStatus ?? 'promoted',
            confidence: Math.max(message.anchor.confidence ?? 0, canonicalAnchor.confidence ?? 0),
            label: canonicalAnchor.label,
          },
        };
        break;
      }
    }

    await this.persistMessages();
  }

  private async restoreMessages(): Promise<void> {
    if (!this.memory) return;
    const saved = await this.memory.load(this.currentInstanceId);
    let scoped = (saved as ChatMessage[]).filter((message) => !message.instanceId || message.instanceId === this.currentInstanceId);

    if (this.contextBuilder && !this._restoringAnchors) {
      this._restoringAnchors = true;
      try {
        const graphContext = await this.contextBuilder.resolveGraphContext(
          {
            workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
            instanceId: this.currentInstanceId,
            activeFile: null,
            visibleFiles: [],
            changedFiles: [],
            pinnedFiles: [],
            environmentContext: null,
            graphContext: null,
            intentMode: 'manual',
            intentConfidence: 0,
          },
          {
            intentMode: 'manual',
            taskSummary: 'Rehydrate stored chat anchors',
            primaryAnchor: undefined,
            secondaryAnchors: [],
            requiredEvidence: [],
            optionalEvidence: ['feature', 'workflow', 'adr', 'ui'],
            codeReadPlan: [],
            budgetPolicy: {
              maxTokens: 0,
              reserveTokens: 0,
              reserveGraphTokens: 0,
              allowFullActiveFile: false,
              includeOptionalEvidence: true,
            },
          },
        );
        scoped = await this.contextBuilder.rehydrateStoredAnchors(scoped, graphContext);
      } catch {
        // Rehydration is best-effort; keep stored anchors unchanged on failure
      } finally {
        this._restoringAnchors = false;
      }
    }

    this.messages.splice(0, this.messages.length, ...scoped.map((message) => ({ ...message, instanceId: message.instanceId ?? this.currentInstanceId })));
    this._hoverActionStateByMessage.clear();

    // Phase 2 — hydrate persisted budget state for this instance.
    try {
      const budgetState = await this.memory.loadBudgetState(this.currentInstanceId);
      if (budgetState) {
        this._lastBudgetSnapshot = budgetState.snapshot;
        this._budgetTurnCounter = budgetState.turnCounter;
      } else {
        this._lastBudgetSnapshot = null;
        this._budgetTurnCounter = 0;
      }
      this._budgetStateHydrated = true;
    } catch (err) {
      console.warn('[budget] hydrate failed', err);
      this._lastBudgetSnapshot = null;
      this._budgetTurnCounter = 0;
      this._budgetStateHydrated = true;
    }

    await this.postState();
  }

  private _sendModelUpdate(): void {
    const provider = this.architectLlm?.currentConfig?.provider ?? '';
    const model = this.architectLlm?.currentConfig?.model ?? '';
    const models = provider === 'anthropic' ? ANTHROPIC_MODELS
      : provider === 'openai' ? OPENAI_MODELS
      : provider === 'copilot-cli' ? COPILOT_CLI_MODELS
      : [];
    const capabilities = this.architectLlm?.getModelCapabilities(provider as ArchitectProvider, model) ?? { textAttachments: false, imageAttachments: false };
    void this.postMessage({
      type: 'updateModels',
      providers: ['anthropic', 'openai', 'ollama', 'lmstudio', 'copilot-cli'],
      models,
      current: { provider, model },
      capabilities,
    });
  }

  private _checkApiKeyWarning(): void {
    // noop preserved behavior if implemented elsewhere
  }

  private _architectSettingsTarget(): vscode.ConfigurationTarget {
    return vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  }

  private _defaultArchitectBaseUrl(provider: ArchitectProvider): string {
    switch (provider) {
      case 'anthropic':
        return 'https://api.anthropic.com/v1';
      case 'openai':
        return 'https://api.openai.com/v1';
      case 'ollama':
        return 'http://localhost:11434';
      case 'lmstudio':
        return 'http://localhost:1234/v1';
      case 'copilot-cli':
        return '';
      default:
        return '';
    }
  }

  private async _changeProvider(provider: ArchitectProvider): Promise<void> {
    // Update in-memory config immediately so _sendModelUpdate reads the new value.
    if (this.architectLlm) {
      const models = provider === 'anthropic' ? ANTHROPIC_MODELS
        : provider === 'openai' ? OPENAI_MODELS
        : provider === 'copilot-cli' ? COPILOT_CLI_MODELS
        : [];
      const previousModel = this.architectLlm.currentConfig?.model ?? '';
      const defaultModel = models.includes(previousModel) ? previousModel : (models[0] ?? '');
      const baseUrl = this._defaultArchitectBaseUrl(provider);
      // Keyless providers: ollama (no auth), lmstudio (fixed literal
      // placeholder; the LM Studio server ignores the auth header but
      // the OpenAI-compat code path sends one regardless), and
      // copilot-cli (the CLI uses its own local GitHub authentication
      // and never sees a key from this extension).
      let apiKey = '';
      if (provider === 'lmstudio') {
        apiKey = 'lm-studio';
      } else if (provider !== 'ollama' && provider !== 'copilot-cli') {
        apiKey = (await this.architectLlm.getApiKey(provider) ?? '');
      }
      this.architectLlm.applyConfig({
        provider,
        model: defaultModel,
        baseUrl,
        apiKey,
      });
    }
    this._sendModelUpdate();
    await this._syncAttachments();
    // Persist to the workspace when a project is open; workspace settings win over globals on reload.
    const cfg = vscode.workspace.getConfiguration('dreamgraph.architect');
    const target = this._architectSettingsTarget();
    const defaultModel = this.architectLlm?.currentConfig?.model ?? '';
    void cfg.update('provider', provider, target);
    if (defaultModel) void cfg.update('model', defaultModel, target);
    void cfg.update('baseUrl', this._defaultArchitectBaseUrl(provider), target);
  }

  private async _changeModel(model: string): Promise<void> {
    // Update in-memory config immediately so _sendModelUpdate reads the new value.
    if (this.architectLlm) {
      const prev = this.architectLlm.currentConfig;
      this.architectLlm.applyConfig({
        provider: prev?.provider ?? '' as ArchitectProvider,
        model,
        baseUrl: prev?.baseUrl ?? '',
        apiKey: prev?.apiKey ?? '',
      });
    }
    this._sendModelUpdate();
    await this._syncAttachments();
    // Persist to the workspace when a project is open; workspace settings win over globals on reload.
    void vscode.workspace.getConfiguration('dreamgraph.architect').update('model', model, this._architectSettingsTarget());
  }

  private static readonly MAX_TOOL_ITERATIONS = 32;
  private static readonly MAX_RETRIES = 3;
  private static readonly MAX_VERIFICATION_BATCH_SIZE = 50;
  private static readonly VERIFICATION_TIMEOUT_MS = 5_000;
  /** Maximum number of autonomous continuation passes to prevent runaway loops. */
  private static readonly MAX_AUTONOMY_PASSES = 20;

  /* ------------------------------------------------------------------ */
  /*  Autonomy — session state & continuation loop                      */
  /* ------------------------------------------------------------------ */

  /** Re-read autonomy settings from VS Code configuration and apply. */
  private _syncAutonomyFromSettings(): void {
    const mode = getAutonomyMode();
    const budget = getAutonomyPassBudget();
    this._autonomyState = _initialAutonomyStateFromSettings();
    this._autonomyEnabled = mode !== 'cautious' || (budget ?? 0) > 0;
    if (this._autonomyEnabled) this._broadcastAutonomyStatus();
  }

  /** Called from extension.ts when configuration changes. */
  public applyAutonomySettings(): void {
    this._syncAutonomyFromSettings();
  }

  private _detectAutonomyRequest(text: string): void {
    const lower = text.toLowerCase();
    const hasAutonomyKeyword = /\b(autonomous|eager|conscientious|cautious)\b/.test(lower)
      || /next\s+\d+\s+passes|for\s+\d+\s+passes/.test(lower)
      || /\bautonomous(ly)?\b/.test(lower)
      || /\bstay\s+cautious\b/.test(lower);

    if (!hasAutonomyKeyword) return;

    const parsed = parseAutonomyRequest(text, this._autonomyState);
    // Per ADR-153: if the user named a mode but no pass count, fall back to
    // that mode's profile defaults (Patch #2.1 — keeps PassBudget+TimeBudget
    // pills populated). An explicit count in the prose still wins.
    const profile = getModeProfile(parsed.mode);
    const total = (typeof parsed.totalAuthorizedPasses === 'number' && parsed.totalAuthorizedPasses > 0)
      ? parsed.totalAuthorizedPasses
      : profile.defaultPassBudget;
    this._autonomyState = {
      mode: parsed.mode,
      remainingAutoPasses: total - parsed.completedAutoPasses,
      completedAutoPasses: parsed.completedAutoPasses,
      totalAuthorizedPasses: total,
      timeBudgetTotalMs: profile.defaultTimeBudgetMs,
      timeBudgetStartedAtEpochMs: Date.now(),
    };
    this._autonomyEnabled = true;
    this._broadcastAutonomyStatus();
  }

  private _setAutonomyMode(mode: string): void {
    const valid = ['cautious', 'conscientious', 'eager', 'autonomous'] as const;
    const m = valid.find((v) => v === mode);
    if (!m) return;
    // Per ADR-152/153: explicit mode selection from the header is a fresh
    // session under that mode's profile (PassBudget + TimeBudget reset). The
    // legacy `dreamgraph.architect.autoPassBudget` setting is honoured only
    // for the user-typed `parseAutonomyRequest` path — dropdown clicks always
    // apply the canonical mode profile so the budgets visibly mean something.
    this._autonomyState = applyModeProfileToState(m as AutonomyMode);
    this._autonomyEnabled = true;
    this._broadcastAutonomyStatus();
  }

  private _resetAutonomy(): void {
    // Reset to cautious profile so pills still show 3/3 + 2:00/2:00
    // rather than placeholders (per ADR-153, budgets are always visible).
    this._autonomyState = applyModeProfileToState('cautious');
    this._autonomyEnabled = false;
    this._autonomyContinuing = false;
    this._lastRecommendedActions = [];
    this._broadcastAutonomyStatus();
  }

  private _broadcastAutonomyStatus(): void {
    const status = deriveAutonomyStatusView(this._autonomyState);
    void this.postMessage({
      type: 'autonomyStatus',
      status: {
        mode: status.mode,
        countingActive: status.countingActive,
        completed: status.completed,
        remaining: status.remaining,
        totalAuthorized: status.totalAuthorized,
        timeBudgetTotalMs: status.timeBudgetTotalMs,
        timeBudgetStartedAtEpochMs: status.timeBudgetStartedAtEpochMs,
        summary: status.summary,
      },
    });
  }

  /**
   * Lever 2 — bind a concrete write tool to apply/patch-style recommended
   * actions when the model emitted them without a `tool` (or with a
   * read-only one). Pure: returns a new array; never mutates inputs.
   * Falls through (no binding) when no write tool is available in the
   * live catalog so the loop never deadlocks.
   */
  private static _bindWriteToolToAnchorActions(
    actions: readonly RecommendedAction[],
    tools: readonly ToolDefinition[],
  ): RecommendedAction[] {
    const writeTool = pickPreferredWriteTool(tools);
    if (!writeTool) return actions.map((a) => ({ ...a }));
    return actions.map((a) => {
      const isApplyLabel = APPLY_LABEL_PATTERN.test(a.label);
      const toolMissingOrRead = !a.tool || !isWriteToolName(a.tool);
      if (isApplyLabel && toolMissingOrRead) {
        return { ...a, tool: writeTool };
      }
      return { ...a };
    });
  }

  private async _handleAutonomyPassComplete(
    content: string,
    messageId: string,
    llmMessages: ArchitectMessage[],
    tools: ToolDefinition[],
  ): Promise<void> {
    // Extract structured envelope and build recommended actions.
    const envelope = extractStructuredPassEnvelope(content);
    // Lever 2 — bind a concrete write tool to apply/patch-style actions
    // when the model emitted them with a missing or read-only `tool`
    // field. The continuation prompt then has a binding to suggest and
    // the model is far less likely to default back to a search/read tool
    // on the next pass. This is the soft hint; Lever 1 (catalog
    // narrowing on the second sticky-anchor locate-only pass) is the
    // hard fallback. Both layers are token-economy at task level.
    const actions: RecommendedAction[] = ChatPanel._bindWriteToolToAnchorActions(
      envelope.nextSteps,
      tools,
    );
    this._lastRecommendedActions = actions;

    // Tool / file-edit accounting drives the empty-pass detector. Without
    // these, a pass that only printed "Autonomy counters: ..." with no real
    // work counts the same as a pass that edited 12 files.
    const toolCallCount = this._lastToolTrace.length;
    const fileEditCount = this._lastToolTrace.reduce(
      (sum, t) => sum + (t.filesAffected?.length ?? 0),
      0,
    );

    // Run pass analysis to get continuation decision
    const result = analyzePass(this._autonomyState, {
      content,
      actions,
      envelope,
      toolCallCount,
      fileEditCount,
      toolNames: this._lastToolTrace.map((t) => t.tool),
    });

    // Patch #3: TimeBudget enforcement (ADR-153). Even when analyzePass
    // says continue, stop the run if the wall-clock budget is exhausted.
    // Provider-agnostic — pure clock check, no model/provider branching.
    const timeExhausted = (() => {
      const total = this._autonomyState.timeBudgetTotalMs;
      const startedAt = this._autonomyState.timeBudgetStartedAtEpochMs;
      if (typeof total !== 'number' || total <= 0) return false;
      if (typeof startedAt !== 'number' || startedAt <= 0) return false;
      return (Date.now() - startedAt) >= total;
    })();
    if (timeExhausted && result.decision.shouldContinue) {
      const minutes = Math.round((this._autonomyState.timeBudgetTotalMs ?? 0) / 60000);
      const stopMsg: ChatMessage = {
        id: this._createMessageId(),
        role: 'system',
        content: `Stopped: TimeBudget exhausted (${minutes} min cap for mode "${this._autonomyState.mode}"). Reset autonomy or switch mode to continue.`,
        timestamp: new Date().toISOString(),
        instanceId: this.currentInstanceId,
      };
      this.messages.push(stopMsg);
      await this.persistMessages();
      await this.postMessage({ type: 'addMessage', message: stopMsg, actions: [], roleMeta: this._roleMetaFor(stopMsg), contextFooter: undefined });
      this._broadcastAutonomyStatus();
      return;
    }

    // Note: action chips are rendered inline by the SUMMARY envelope card
    // (see card-renderer.ts renderEnvelope). No separate broadcast needed —
    // it would duplicate the buttons below the assistant message.

    if (result.decision.shouldContinue && !this.abortController?.signal.aborted) {
      // Capture the prior locate-only marker BEFORE advancing state — Lever 1
      // narrows the next pass's tool catalog when the prior pass was already
      // locate-only AND the just-completed pass was also locate-only AND a
      // sticky patch anchor is in play. We mechanically eliminate the
      // ability of the model to spend another turn on pure reads instead of
      // hard-stopping the loop ("no failure: keep going until done").
      const priorPassWasLocateOnly = this._autonomyState.lastPassWasLocateOnly === true;
      // Advance state and continue
      this._autonomyState = advanceAutonomyStateIfContinued(this._autonomyState, result.decision, result.signal, result.patchAnchorEstablished, result.anchorPaths, result.isLocateOnlyThisPass);
      this._broadcastAutonomyStatus();

      // Safety: cap autonomous continuation
      if (this._autonomyState.completedAutoPasses >= ChatPanel.MAX_AUTONOMY_PASSES) {
        const stopMsg: ChatMessage = {
          id: this._createMessageId(),
          role: 'system',
          content: `Autonomy safety limit reached (${ChatPanel.MAX_AUTONOMY_PASSES} passes). ${result.decision.reason}`,
          timestamp: new Date().toISOString(),
          instanceId: this.currentInstanceId,
        };
        this.messages.push(stopMsg);
        await this.persistMessages();
        await this.postMessage({ type: 'addMessage', message: stopMsg, actions: [], roleMeta: this._roleMetaFor(stopMsg), contextFooter: undefined });
        if (stopMsg.id) this._broadcastSignOffActions(stopMsg.id, envelope, result.actionSet.actions);
        return;
      }

      // Post continuation notice
      const selectedAction = result.actionSet.actions.find((a) => a.id === result.selectedActionId);
      const statusView = deriveAutonomyStatusView(this._autonomyState);
      const noticeText = `*${result.decision.reason}*${selectedAction ? ` Next: ${selectedAction.label}.` : ''} ${statusView.countingActive ? `[${statusView.summary}]` : ''}`;
      const notice: ChatMessage = {
        id: this._createMessageId(),
        role: 'system',
        content: noticeText,
        timestamp: new Date().toISOString(),
        instanceId: this.currentInstanceId,
      };
      this.messages.push(notice);
      await this.persistMessages();
      await this.postMessage({ type: 'addMessage', message: notice, actions: [], roleMeta: this._roleMetaFor(notice), contextFooter: undefined });

      // Trigger next pass.
      // Lever 1 — narrow the live tool catalog to write+verify only when
      // BOTH the prior and the just-completed pass were locate-only AND a
      // patch anchor is sticky. The narrower keeps the loop alive (it
      // falls back to the full catalog if it would otherwise empty out)
      // and applies pressure exactly where the model is wasting tokens
      // re-reading instead of writing.
      const shouldNarrow =
        result.patchAnchorEstablished
        && priorPassWasLocateOnly
        && result.isLocateOnlyThisPass;
      const effectiveTools = shouldNarrow ? narrowToWriteAndVerify(tools) : tools;
      const continuationPrompt = result.nextPrompt
        ?? buildContinuationPrompt(selectedAction, { patchAnchorEstablished: result.patchAnchorEstablished });
      await this._runAutonomyContinuationPass(continuationPrompt, llmMessages, effectiveTools, result.actionSet.actions);
    } else {
      // ──────────────────────────────────────────────────────────────────
      // Report-required guard: never let the Architect sign off silently.
      // If the loop is about to stop AND the model did real work this pass
      // (≥1 tool call OR ≥1 file edit) but produced no envelope summary,
      // force exactly one extra "report-only" turn before stopping.
      // This prevents the gpt-5.5 failure mode where the model emits
      // counter chatter, runs a few reads, and then disappears with no
      // visible report of what it changed or what's left.
      // ──────────────────────────────────────────────────────────────────
      const hasReport = !!envelope.summary && envelope.summary.trim().length > 0;
      const didRealWork = toolCallCount > 0 || fileEditCount > 0;
      const alreadyForcedReport = this._reportForcedThisRun === true;
      if (!hasReport && didRealWork && !alreadyForcedReport && !this.abortController?.signal.aborted) {
        this._reportForcedThisRun = true;
        const reportPrompt = [
          'STOP. You are about to end the session without a report.',
          'Emit ONLY the SUMMARY/structured-envelope report now: a one-paragraph plain-text summary of what you actually did this run, what changed, what is incomplete, and any blockers — followed by the standard json envelope fenced block (`goal_status`, `progress_status`, `uncertainty`, optional `recommended_next_steps`).',
          'Do NOT issue any tool calls in this turn. Reporting is mandatory before sign-off.',
        ].join(' ');
        const notice: ChatMessage = {
          id: this._createMessageId(),
          role: 'system',
          content: '⚠️ Architect attempted to sign off without a report — requesting a final report turn.',
          timestamp: new Date().toISOString(),
          instanceId: this.currentInstanceId,
        };
        this.messages.push(notice);
        await this.persistMessages();
        await this.postMessage({ type: 'addMessage', message: notice, actions: [], roleMeta: this._roleMetaFor(notice), contextFooter: undefined });
        await this._runAutonomyContinuationPass(reportPrompt, llmMessages, tools);
        return;
      }

      // Stopped — persist task state so the next turn can resume from a known position.
      this._reportForcedThisRun = false;
      this._lastStopContext = {
        summary: envelope.summary,
        nextSteps: result.actionSet.actions.slice(0, 3).map((a) => ({ label: a.label, rationale: a.rationale })),
      };
      this._broadcastAutonomyStatus();
      if (result.decision.reason) {
        const statusView = deriveAutonomyStatusView(this._autonomyState);
        const hasActionable = result.actionSet.actions.length > 0;
        const stopText = `${result.decision.reason}${statusView.countingActive ? ` [${statusView.summary}]` : ''}${hasActionable ? ' — click an action below to resume.' : ''}`;
        const stopMsg: ChatMessage = {
          id: this._createMessageId(),
          role: 'system',
          content: stopText,
          timestamp: new Date().toISOString(),
          instanceId: this.currentInstanceId,
        };
        this.messages.push(stopMsg);
        await this.persistMessages();
        await this.postMessage({ type: 'addMessage', message: stopMsg, actions: [], roleMeta: this._roleMetaFor(stopMsg), contextFooter: undefined });
        if (stopMsg.id) this._broadcastSignOffActions(stopMsg.id, envelope, result.actionSet.actions);
      }
    }
  }

  private async _runAutonomyContinuationPass(
    prompt: string,
    baseLlmMessages: ArchitectMessage[],
    tools: ToolDefinition[],
    nextStepActions: RecommendedAction[] = [],
  ): Promise<void> {
    if (this._autonomyContinuing) {
      console.warn('[DreamGraph] _runAutonomyContinuationPass: re-entrant call dropped — a continuation is already in progress.');
      // F-08: surface the dropped re-entrant call so the user knows their
      // input wasn't lost silently. Soft notification — no modal.
      void this.postMessage({
        type: 'tool-progress',
        tool: 'autonomy',
        message: 'A continuation pass is already running — additional trigger ignored.',
      });
      return; // prevent re-entrancy
    }
    this._autonomyContinuing = true;

    try {
      // Build continuation message
      const envelope = this.contextBuilder
        ? await this.contextBuilder.buildEnvelope(prompt, undefined, this._currentBudgetCoordinator ?? undefined)
        : null;
      const liveAnchor = envelope?.activeFile?.selection?.anchor ?? envelope?.activeFile?.cursorAnchor;
      const userMessage: ChatMessage = {
        id: this._createMessageId(),
        role: 'user',
        content: prompt,
        timestamp: new Date().toISOString(),
        instanceId: this.currentInstanceId,
        anchor: liveAnchor,
      };
      this.messages.push(userMessage);
      await this._persistMessagesWithCanonicalAnchorRefresh(envelope);

      this.streaming = true;
      this.streamingContent = '';
      this._lastToolTrace = [];
      this._lastVerdict = null;
      this.abortController = new AbortController();

      const task = inferTask(envelope?.intentMode ?? 'ask_dreamgraph');
      const autonomyInstruction: AutonomyInstructionState = { ...this._autonomyState, enabled: true };
      const provider = this.architectLlm?.provider ?? undefined;
      // Build full context for the continuation pass so the model has the same
      // grounding it would have in a normal user-initiated turn.
      const contextResult = envelope
        ? await this._buildPromptContext(task, envelope, prompt, 'continuation')
        : { assembledContext: '', reasoningPacket: null };
      const { system } = assemblePrompt(task, envelope, contextResult.assembledContext || undefined, undefined, autonomyInstruction, provider, contextResult.reasoningPacket?.task?.lens);

      // Re-derive the tool subset for this continuation pass from scratch.
      // The previous turn's whitelist is intentionally discarded: the next
      // step has its own intent (e.g. "run build:server" needs `run_command`
      // even when the original prompt was a UI question), and carrying the
      // prior selection forward both wastes schema budget on tools that are
      // no longer relevant and can mask a missing next-step tool. Selection
      // is grounded in: (a) the continuation prompt, (b) the tools bound to
      // the recommended next steps for this pass.
      const primedFromActions: string[] = [];
      for (const a of nextStepActions) {
        if (typeof a.tool === 'string' && a.tool.length > 0) primedFromActions.push(a.tool);
      }
      // Stale primed-tools from earlier turns are explicitly dropped so the
      // continuation reflects only what this step needs.
      this._primedTools.clear();
      const mcpToolsForCont = await this._listMcpToolsLazy();
      const allToolsForCont: ToolDefinition[] = [
        ...mcpToolsForCont.map((t) => ({
          name: t.name,
          description: t.description ?? '',
          inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
        })),
        ...LOCAL_TOOL_DEFINITIONS.map((t) => ({
          name: t.name,
          description: t.description ?? '',
          inputSchema: t.inputSchema as Record<string, unknown>,
        })),
      ];
      const decision = selectToolGroups({
        task,
        intentMode: envelope?.intentMode,
        prompt,
        autonomy: true,
        availableToolNames: allToolsForCont.map((t) => t.name),
        primedTools: Array.from(new Set(primedFromActions)),
      });
      this._lastAvailableToolNames = allToolsForCont.map((t) => t.name);
      const selectedSet = new Set(decision.selected);
      tools = allToolsForCont.filter((t) => selectedSet.has(t.name));
      // Guard: every tool bound to a next-step action MUST be exposed. If
      // selection somehow dropped one (e.g. cap truncation), force it back
      // in — a continuation that suggests a tool the LM cannot call is the
      // exact failure mode this rebuild is meant to prevent.
      for (const toolName of primedFromActions) {
        if (!selectedSet.has(toolName)) {
          const def = allToolsForCont.find((t) => t.name === toolName);
          if (def) {
            tools.unshift(def);
            selectedSet.add(toolName);
          }
        }
      }
      this.contextInspector?.appendContextLine(
        `Tool selection (continuation): ${tools.length}/${allToolsForCont.length} tools — groups=[${decision.groups.join(', ')}] mutating=${decision.mutating} autonomy=${decision.autonomy}; primed-from-actions=[${primedFromActions.join(', ')}]; ${decision.rationale}`,
      );

      const llmMessages: ArchitectMessage[] = [{ role: 'system', content: system }];
      // Bounded history: same caps as handleUserMessage (last 20 turns, per-message char caps).
      // Attachment image bytes are NOT replayed — only a text marker survives;
      // re-attach explicitly if the model needs to look at the picture again.
      for (const msg of buildBoundedConversationMessages(this.messages, 20)) {
        llmMessages.push({ role: msg.role, content: msg.content });
      }

      await this.postMessage({ type: 'stream-start' });

      // ADR-089 Phase 3c — autonomy continuation slice. When the seam
      // flag is on AND no tools are selected AND we have an envelope,
      // continuation flows through `runPassViaCore` so the architect-
      // core driver owns the assistant turn (verdict, render limits,
      // implicit-entity detect, addMessage broadcast, recursive autonomy
      // trigger) via `host.persistAssistantMessage`. The inline path
      // below remains the source of truth for tool-using continuations
      // until Phase 3d wires `host.executeTool`.
      const useCorePass = vscode.workspace.getConfiguration('dreamgraph.architect').get<boolean>('useCorePass') === true;
      const seamRoute = useCorePass && tools.length === 0 && envelope !== null;
      let seamOwnedAssistant = false;

      let fullContent = '';
      if (seamRoute) {
        const host = this._buildCorePassHost(
          envelope!,
          task,
          contextResult,
          llmMessages,
          llmMessages,
          {
            contentBlocks: undefined,
            droppedAttachmentNames: [],
            attachmentSummary: '',
            stopContextBlock: undefined,
          },
        );
        // Reset the re-entrancy guard BEFORE the seam runs so the
        // recursive `_handleAutonomyPassComplete` invoked from inside
        // `host.persistAssistantMessage` is not silently dropped by the
        // guard at line ~2328. Mirrors the inline path which resets the
        // flag immediately before its own recursive call (line ~2474).
        this._autonomyContinuing = false;
        const req = this._createRequestSignal(this._getLlmTimeoutMs({ mode: 'stream' }));
        try {
          const passResult = await runPassViaCore({
            host,
            text: prompt,
            tools: [],
            onStreamChunk: (chunk: string) => {
              const safeChunk = this._redactSecrets(chunk);
              fullContent += safeChunk;
              this.streamingContent += safeChunk;
              void this.postMessage({ type: 'stream-chunk', chunk: safeChunk });
            },
            abortSignal: req.signal,
          });
          if (!fullContent && passResult.assistantMessage.content) {
            fullContent = passResult.assistantMessage.content;
          }
          if (passResult.stopReason === 'error') {
            throw new Error(`runPassViaCore reported error stopReason: ${passResult.assistantMessage.content}`);
          }
          seamOwnedAssistant = true;
        } finally {
          req.dispose();
        }
      } else if (tools.length > 0) {
        fullContent = await this.runAgenticLoop(llmMessages, tools);
      } else {
        const req = this._createRequestSignal();
        try {
          await this.architectLlm!.stream(llmMessages, (chunk: string) => {
            const safeChunk = this._redactSecrets(chunk);
            fullContent += safeChunk;
            this.streamingContent += safeChunk;
            void this.postMessage({ type: 'stream-chunk', chunk: safeChunk });
          }, req.signal);
        } finally {
          req.dispose();
        }
      }

      if (seamOwnedAssistant) {
        // The seam's `host.persistAssistantMessage` already pushed the
        // assistant message, persisted, broadcast verdict/toolTrace/
        // addMessage/summary card, AND invoked the recursive autonomy
        // pass. Just close the stream UI and exit.
        await this.postMessage({ type: 'stream-end', done: true });
        return;
      }

      const redactedFullContent = this._redactSecrets(fullContent);
      this._capturePrimedTools(redactedFullContent, this._lastAvailableToolNames);
      this._lastVerdict = this._deriveVerdict(redactedFullContent, this._lastToolTrace);
      const finalContent = this._applyRenderLimits(redactedFullContent);
      const implicitEntities = this._detectImplicitEntities(redactedFullContent);
      const implicitEntityNotice = implicitEntities.names.length > 0
        ? this._formatImplicitEntityNotice(implicitEntities)
        : undefined;

      const assistantMessage: ChatMessage = {
        id: this._createMessageId(),
        role: 'assistant',
        content: finalContent.content,
        fullContent: redactedFullContent,
        implicitEntityNotice,
        timestamp: new Date().toISOString(),
        instanceId: this.currentInstanceId,
        verdict: this._lastVerdict ?? undefined,
        toolTrace: this._lastToolTrace.length > 0 ? [...this._lastToolTrace] : undefined,
      };
      this.messages.push(assistantMessage);
      await this.persistMessages();

      await this.postMessage({ type: 'stream-end', done: true });

      if (this._lastVerdict) {
        await this.postMessage({ type: 'verdict', verdict: this._lastVerdict });
      }
      if (this._lastToolTrace.length > 0) {
        await this.postMessage({ type: 'toolTrace', calls: [...this._lastToolTrace] });
      }

      await this.postMessage({
        type: 'addMessage',
        message: assistantMessage,
        actions: this._buildMessageActions(assistantMessage),
        roleMeta: this._roleMetaFor(assistantMessage),
        contextFooter: this._contextFooterFor(assistantMessage),
      });

      if (assistantMessage.id) {
        this._broadcastSummaryCard(redactedFullContent, assistantMessage.id);
      }

      // Recursively analyze the new pass
      this._autonomyContinuing = false;
      await this._handleAutonomyPassComplete(redactedFullContent, assistantMessage.id ?? '', llmMessages, tools);
    } catch (err: unknown) {
      const errorText = err instanceof Error ? err.message : String(err);
      const isAbort = err instanceof DOMException && err.name === 'AbortError';
      // Stack trace is essential for diagnosing regressions in continuation —
      // the host catches everything from envelope build, prompt assembly,
      // agentic loop, and post-processing in one block. Surface the top
      // user-code frame in the SYSTEM card so the crash site is visible
      // without forcing the user to open the Extension Host log.
      let topFrame: string | undefined;
      if (!isAbort && err instanceof Error && err.stack) {
        console.error('[DreamGraph] continuation pass failed:', err.stack);
        const frames = err.stack.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('at '));
        // Prefer the first frame inside our own dist/ bundle — skips internal
        // node frames and Promise/async machinery so the user sees the
        // actual call site (e.g. "at ChatPanel._foo (extension.js:12345)").
        topFrame = frames.find((l) => l.includes('extension.js') || l.includes('dist'))
          ?? frames[0];
      }
      const displayText = isAbort
        ? 'Autonomous continuation stopped.'
        : `Error during continuation: ${errorText}${topFrame ? `\n\n\`${topFrame}\`` : ''}`;
      const errMsg: ChatMessage = { id: this._createMessageId(), role: 'system', content: displayText, timestamp: new Date().toISOString(), instanceId: this.currentInstanceId };
      this.messages.push(errMsg);
      await this.persistMessages();
      await this.postMessage({ type: 'addMessage', message: errMsg, actions: [], roleMeta: this._roleMetaFor(errMsg), contextFooter: undefined });
    } finally {
      this._autonomyContinuing = false;
      this.resetStreamState();
    }
  }

  /**
   * Build a SUMMARY card payload (pills + Suggested-Actions chips) for the
   * webview from any assistant content. Always emitted — autonomy on or off.
   * The host-side prose extractor synthesizes status + nextSteps when the
   * model didn't emit a JSON envelope, so the card always has data to render.
   */
  /**
   * Sign-off resume-action registrar. When the autonomy loop stops
   * (budget exhausted, safety cap, decided to pause) the assistant
   * bubble immediately above the stop/system message already renders
   * the SUMMARY card with the same recommended-action chip strip
   * (built from the JSON envelope embedded in its `content`, so it
   * survives webview re-renders). All this method needs to do is
   * publish the action set into the shared `_lastRecommendedActions`
   * slot so chip clicks on that surviving card route through
   * `_executeRecommendedAction` correctly.
   *
   * HISTORICAL NOTE: a prior version of this method also posted a
   * `summaryCard` message targeted at the system stop bubble, which
   * caused the webview to append a SECOND, visually identical envelope
   * card inside that bubble via DOM mutation. Because the duplicate
   * was never persisted to `messages[]`, any re-render (scroll
   * virtualization, tab switch, theme change) silently destroyed it —
   * a glitchy, half-real card. Removed entirely; continuity is
   * preserved end-to-end by the `_lastRecommendedActions` write below
   * because the assistant card's chips invoke the same handler.
   *
   * @param _messageId Retained for call-site stability; intentionally unused.
   * @param _envelope  Retained for call-site stability; intentionally unused.
   */
  private _broadcastSignOffActions(
    _messageId: string,
    _envelope: StructuredPassEnvelope,
    actions: RecommendedAction[],
  ): void {
    if (!actions || actions.length === 0) return;
    // Persist so chip clicks resolve via `_executeRecommendedAction`.
    // This is the only side effect required for resume continuity.
    this._lastRecommendedActions = actions;
  }

  private _broadcastSummaryCard(content: string, messageId: string): void {
    try {
      // Duplicate-card guard: when the assistant content embeds a parseable
      // structured envelope (fenced ```json or bare {…"summary":…}), the
      // assistant bubble's body renderer (`renderAssistantBody`, webview)
      // already replaces the markdown with `window.renderEnvelope(...)`.
      // Broadcasting `summaryCard` in that case would append a SECOND,
      // visually identical card under the same bubble (the webview handler
      // only de-dupes prior `.dg-envelope-card-host` siblings, not the
      // body-embedded card). Detect the same envelope shape the body uses
      // and short-circuit; the broadcast remains active for prose-only
      // turns where the body falls back to plain markdown and the
      // host-side prose extractor synthesises the only visible card.
      // Still persist the recommended-action set so chip clicks in the
      // body-rendered card resolve via `_executeRecommendedAction`.
      if (extractPrimaryEnvelope(content)) {
        const env = extractStructuredPassEnvelope(content);
        this._lastRecommendedActions = env.nextSteps;
        return;
      }
      const env = extractStructuredPassEnvelope(content);
      // Skip when there is genuinely nothing to show (no summary AND no
      // status differentiation AND no actions). Avoids drawing an empty
      // pill row on plain conversational replies.
      const hasSignal = !!env.summary
        || env.nextSteps.length > 0
        || (env.goalStatus && env.goalStatus !== 'partial')
        || (env.progressStatus && env.progressStatus !== 'advancing')
        || (env.uncertainty && env.uncertainty !== 'low');
      if (!hasSignal) return;
      const steps = env.nextSteps;
      // Persist for chip-click resolution — _executeRecommendedAction uses this.
      this._lastRecommendedActions = steps;
      const eligibleCount = steps.filter((s) => s.eligible && s.withinScope).length;
      void this.postMessage({
        type: 'summaryCard',
        messageId,
        envelope: {
          summary: env.summary ?? '',
          goal_status: env.goalStatus,
          progress_status: env.progressStatus,
          uncertainty: env.uncertainty,
          recommended_next_steps: steps.map((s) => ({ id: s.id, label: s.label, rationale: s.rationale })),
          doAllEligible: eligibleCount > 1,
        },
      });
    } catch (err) {
      console.warn('[summaryCard] broadcast failed', err);
    }
  }

  /**
   * Strip the structured pass envelope JSON fence from content before displaying.
   * The fence is parsed by extractStructuredPassEnvelope and should not render in chat.
   * Only strips blocks that contain the autonomy contract fields (goal_status).
   */
  private _stripStructuredEnvelope(content: string): string {
    return helpers.stripStructuredEnvelope(content);
  }

  private _formatStopContextBlock(ctx: { summary?: string; nextSteps: Array<{ label: string; rationale?: string }> }): string {
    return helpers.formatStopContextBlock(ctx);
  }

  private async _executeRecommendedAction(actionId: string, fallbackLabel?: string): Promise<void> {
    const action = this._lastRecommendedActions.find((a) => a.id === actionId);
    const label = action?.label || (typeof fallbackLabel === 'string' ? fallbackLabel.trim() : '');
    if (!label) return;
    // If the action carries a structured tool binding, prime it so the
    // follow-up turn's selectToolGroups() definitely exposes it — the chip
    // label alone ("Run a dream cycle") often won't substring-match the
    // exact tool name (`dream_cycle`).
    if (action?.tool) {
      this._primedTools.add(action.tool);
    }
    await this.handleUserMessage(label);
  }

  private async _executeAllRecommendedActions(fallbackLabels?: string[]): Promise<void> {
    const eligible = this._lastRecommendedActions.filter((a) => a.eligible && a.withinScope);
    const liveLabels = eligible
      .map((a) => a.label)
      .filter((label) => typeof label === 'string' && label.trim().length > 0);
    const labels = liveLabels.length > 0
      ? liveLabels
      : (Array.isArray(fallbackLabels) ? fallbackLabels.map((label) => String(label || '').trim()).filter(Boolean) : []);
    if (labels.length === 0) return;
    // Prime every tool binding in the batch so the combined follow-up turn
    // has them all whitelisted.
    for (const a of eligible) {
      if (a.tool) this._primedTools.add(a.tool);
    }
    const combined = `Execute these steps sequentially:\n${labels.map((l, i) => `${i + 1}. ${l}`).join('\n')}`;
    await this.handleUserMessage(combined);
  }
  /** Re-exported from helpers.ts. */
  private static readonly SECRET_PATTERNS = helpers.SECRET_PATTERNS;
  /** Cap on accumulated streaming content to prevent context window overflow
   *  when the agent runs many iterations. Content beyond this is still executed
   *  but not accumulated into streamingContent (the webview already received it). */
  private static readonly MAX_STREAMING_CONTENT_CHARS = 200_000;

  /** Call callWithTools with automatic retry on 429 rate-limit errors. */
  private async _callWithToolsRetry(
    llmMessages: ArchitectMessage[],
    tools: ToolDefinition[],
    rawMessages?: unknown[],
    signal?: AbortSignal,
  ): ReturnType<ArchitectLlm['callWithTools']> {
    for (let attempt = 0; attempt <= ChatPanel.MAX_RETRIES; attempt++) {
      try {
        return await this.architectLlm!.callWithTools(llmMessages, tools, rawMessages, signal);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const is429 = msg.includes('429') || msg.toLowerCase().includes('rate_limit');
        if (!is429 || attempt === ChatPanel.MAX_RETRIES) throw err;

        // Parse "try again in X.XXXs" from the error, fallback to exponential backoff
        const retryMatch = msg.match(/try again in ([\d.]+)s/i);
        const waitSec = retryMatch ? parseFloat(retryMatch[1]) + 1 : (attempt + 1) * 8;
        const waitMs = Math.min(waitSec * 1000, 60_000);

        const note = `\n⏳ Rate limited — retrying in ${Math.ceil(waitSec)}s (attempt ${attempt + 1}/${ChatPanel.MAX_RETRIES})…\n`;
        this.streamingContent += note;
        void this.postMessage({ type: 'stream-chunk', chunk: note });

        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
    throw new Error('Rate limit retries exhausted'); // unreachable but satisfies TS
  }

  private static _toolTimeoutMs(toolName: string): number {
    return helpers.toolTimeoutMs(toolName);
  }

  private async runAgenticLoop(initialMessages: ArchitectMessage[], tools: ToolDefinition[]): Promise<string> {
  if (!this.architectLlm) {
    throw new Error('Architect LLM not configured');
  }

  const llmMessages = [...initialMessages];
  // Anthropic does not accept role:"system" in the messages array — it must be
  // a top-level parameter. Strip system messages here; _callAnthropicWithTools
  // re-extracts and injects the system prompt via _splitSystem + _buildAnthropicMessagesRequest.
  let rawMessages: unknown[] = llmMessages
    .filter((message) => message.role !== 'system')
    .map((message) => {
      if (Array.isArray(message.content)) {
        return { role: message.role, content: message.content };
      }
      return { role: message.role, content: message.content };
    });
  let finalText = '';
  let pass = 0;
  const maxPasses = 12;
  // Phase A — task-level token-economy: nudge the model toward writes when it
  // is stuck re-reading already-located content. The reservation is a
  // synthetic user message injected after the model has spent
  // WRITE_RESERVATION_READ_THRESHOLD CONSECUTIVE reads (no intervening write).
  // It is **lifted automatically** the next time any write tool runs in this
  // loop, and may re-arm later if the model returns to read-only spam without
  // further writes. The counter resets on any write — including
  // patch_markdown_chapter, edit_markdown_section, edit_entity, create_file,
  // delete_file, and any other non-read-prefixed tool — so the constraint
  // never "holds on" after legitimate progress.
  //
  // GATE: the reservation only arms when a prior pass established a sticky
  // patch anchor (`AutonomyState.lastAnchorPaths` non-empty). Fresh user
  // prompts and read-only / assess tasks never have this set, so they read
  // freely. The constraint exists to apply write-pressure when a write was
  // ALREADY IMPLIED AND ANCHORED by the previous pass — not to ban
  // prerequisite reads on tasks that are inherently read-only. Allowed even
  // under pressure: exact body required for safe patch, post-write
  // verification reads, stale-anchor recovery, and reading a newly
  // identified concrete blocker target. Discouraged: broad search,
  // re-reading already-inspected files, relocating the same anchor,
  // "just to be sure" discovery.
  const hasStickyAnchorFromPriorPass =
    Array.isArray(this._autonomyState.lastAnchorPaths)
    && this._autonomyState.lastAnchorPaths.length > 0;
  const WRITE_RESERVATION_READ_THRESHOLD = 8;
  let totalReadToolCalls = 0;
  let totalWriteToolCalls = 0;
  let readsSinceLastWrite = 0;
  let writeReservationInjected = false;

  while (pass < maxPasses) {
    pass += 1;
    const timeoutMs = this._getLlmTimeoutMs({ mode: 'tool', toolCount: tools.length });
    const req = this._createRequestSignal(timeoutMs);

    try {
      await this.postMessage({ type: 'stream-thinking', active: true });
      const response = await this._callWithToolsRetry(llmMessages, tools, rawMessages, req.signal);

      if (response.content) {
        const safeChunk = this._redactSecrets(response.content);
        finalText += safeChunk;
        this.streamingContent += safeChunk;
        await this.postMessage({ type: 'stream-chunk', chunk: safeChunk });
      }

      if (!response.toolCalls || response.toolCalls.length === 0) {
        return finalText;
      }

      const assistantBlocks: Array<Record<string, unknown>> = [];
      if (response.content) {
        assistantBlocks.push({ type: 'text', text: response.content });
      }
      for (const toolCall of response.toolCalls) {
        assistantBlocks.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input,
        });
      }
      // For OpenAI Responses API turns, attach the verbatim output[] items
      // (including encrypted `reasoning` items) so the next turn can replay
      // them. This is REQUIRED by gpt-5.5/o-series stateless mode — without
      // reasoning replay the model re-plans every tool round-trip and
      // degenerates into counter-spam ("Iterations: 1..34") with no real
      // edits ever being committed.
      const assistantMsg: Record<string, unknown> = { role: 'assistant', content: assistantBlocks };
      if (Array.isArray(response.providerRawAssistant) && response.providerRawAssistant.length > 0) {
        assistantMsg[RESPONSES_RAW_ITEMS_KEY] = response.providerRawAssistant;
      }
      rawMessages.push(assistantMsg);

      const toolResultBlocks: Array<{ type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }> = [];
      for (const toolCall of response.toolCalls) {
        const toolStartedAt = Date.now();
        await this.postMessage({ type: 'tool-progress', tool: toolCall.name, message: `Running ${toolCall.name}…` });

        const reviewSnapshot = isWriteToolName(toolCall.name)
          ? await changeReviewService.captureWorkspaceSnapshot()
          : null;

        try {
          const result = isLocalTool(toolCall.name)
            ? await executeLocalTool(toolCall.name, toolCall.input ?? {})
            : await this._callMcpToolWithLazyConnect(toolCall.name, toolCall.input ?? {});
          if (reviewSnapshot) {
            const changedReviewPaths = await changeReviewService.recordWorkspaceChanges(reviewSnapshot);
            if (changedReviewPaths.length > 0) {
              this._pendingReviewsCollapsed = true;
              await this._postPendingReviews();
            }
          }
          const rawString = this._stringifyToolResult(result);
          // Phase 4 — pressure-aware multi-tier compression. The coordinator
          // owns the policy via getPressure()/getRemainingTargetTokens() and
          // recordCompression() is invoked from inside compressToolResult.
          // When no coordinator exists for the turn (defensive: shouldn't
          // happen post-Phase 3) the payload is passed through verbatim.
          let normalized: string;
          if (this._currentBudgetCoordinator) {
            const compression = compressToolResult(
              rawString,
              this._currentBudgetCoordinator,
              toolCall.name,
            );
            normalized = compression.content;
            this._currentBudgetCoordinator.recordComponentActual(
              `tool:${toolCall.name}`,
              estimateTokensFromString(normalized),
            );
          } else {
            normalized = rawString;
          }
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: toolCall.id,
            content: normalized,
          });
          // F-04: invalidate context-builder caches when this tool is known to
          // mutate cognitive state, so the next envelope reflects the new graph.
          this.contextBuilder?.maybeInvalidateForTool(toolCall.name);
          this._lastToolTrace.push({
            tool: toolCall.name,
            argsSummary: this._summarizeToolArgs(toolCall.input ?? {}),
            filesAffected: this._extractFilesAffected(toolCall.name, toolCall.input ?? {}, normalized),
            durationMs: Date.now() - toolStartedAt,
            status: 'completed',
          });
          await this.postMessage({ type: 'tool-progress', tool: toolCall.name, message: `${toolCall.name} done` });
        } catch (toolErr) {
          if (reviewSnapshot) {
            try {
              const changedReviewPaths = await changeReviewService.recordWorkspaceChanges(reviewSnapshot);
              if (changedReviewPaths.length > 0) {
                this._pendingReviewsCollapsed = true;
                await this._postPendingReviews();
              }
            } catch (reviewErr) {
              console.warn('[DreamGraph] Failed to record pending review changes after failed write tool:', reviewErr);
            }
          }
          const toolError = toolErr instanceof Error ? toolErr.message : String(toolErr);
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: toolCall.id,
            content: toolError,
            is_error: true,
          });
          this._lastToolTrace.push({
            tool: toolCall.name,
            argsSummary: this._summarizeToolArgs(toolCall.input ?? {}),
            filesAffected: this._extractFilesAffected(toolCall.name, toolCall.input ?? {}, toolError),
            durationMs: Date.now() - toolStartedAt,
            status: 'failed',
          });
          await this.postMessage({ type: 'tool-progress', tool: toolCall.name, message: `${toolCall.name} failed` });
        }
      }

      rawMessages.push({ role: 'user', content: toolResultBlocks });
      // Bound rawMessages growth across passes: tool_results from passes that are
      // already 2+ passes behind have been consumed by the model — replace their
      // content with a short stub. This prevents quadratic growth when the loop
      // runs many passes (each pass otherwise re-sends every prior tool_result in full).
      _elideStaleToolResults(rawMessages, /*keepLastPairs*/ 6);

      // Phase A — tally read/write split for THIS iteration's tool batch.
      // Track reads-since-last-write so the reservation can self-lift the
      // moment any write tool runs, and re-arm later if the model goes back
      // to read-only spam without writing. Any non-read-prefixed tool counts
      // as a write here — patch_markdown_chapter, edit_markdown_section,
      // create_file, edit_entity, run_command, etc. — which matches the
      // common-sense "the model is making progress" signal.
      let writesThisPass = 0;
      for (const tc of response.toolCalls) {
        if (isReadOnlyTool(tc.name)) {
          totalReadToolCalls += 1;
          readsSinceLastWrite += 1;
        } else {
          totalWriteToolCalls += 1;
          writesThisPass += 1;
          readsSinceLastWrite = 0;
        }
      }
      // Reset trigger: any write call in this pass lifts an active
      // reservation and clears the read counter. The next reservation can
      // only fire if the model spends WRITE_RESERVATION_READ_THRESHOLD
      // consecutive reads AGAIN without writing.
      if (writeReservationInjected && writesThisPass > 0) {
        writeReservationInjected = false;
        rawMessages.push({
          role: 'user',
          content: [{
            type: 'text',
            text:
              `Write observed (${writesThisPass} this pass, ${totalWriteToolCalls} total write call${totalWriteToolCalls === 1 ? '' : 's'} this turn). `
              + `The earlier write-reservation nudge is LIFTED. `
              + `You may resume normal read+write cadence — including read-back, `
              + `verification, and additional discovery as needed for the next change. `
              + `The constraint will only re-arm if you go back to reading without writing.`,
          }],
        });
      }
      if (
        !writeReservationInjected
        && hasStickyAnchorFromPriorPass
        && readsSinceLastWrite >= WRITE_RESERVATION_READ_THRESHOLD
        && pass < maxPasses
      ) {
        writeReservationInjected = true;
        const anchorList = this._autonomyState.lastAnchorPaths!.slice(0, 3).join(', ');
        const reservationText =
          `A patch anchor was established by the previous pass (${anchorList}) and you have spent `
          + `${readsSinceLastWrite} consecutive read tool calls in this turn without writing. `
          + `Token-economy nudge: the next iteration should attempt the implied write `
          + `(e.g. replace_string_in_file, multi_replace_string_in_file, create_file, `
          + `patch_file, edit_file, edit_entity, patch_markdown_chapter, edit_markdown_section) `
          + `OR state the missing prerequisite explicitly. `
          + `Allowed reads under this nudge: the exact file/function body required for a safe patch, `
          + `post-write verification, stale-anchor recovery after a failed edit, and reading a newly `
          + `identified concrete blocker target. Avoid: broad search, re-reading already-inspected `
          + `files, relocating the same anchor, "just to be sure" discovery. `
          + `This nudge LIFTS automatically the moment any write tool succeeds — `
          + `it is not a permanent ban on reads.`;
        rawMessages.push({
          role: 'user',
          content: [{ type: 'text', text: reservationText }],
        });
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const isTimeout = this._isTimeoutError(err);

      if (isTimeout) {
        const provider = this.architectLlm.provider ?? 'unknown';
        const model = this.architectLlm.currentConfig?.model;
        const visibleNotice = `\n⚠️ Tool-enabled LLM request timed out after ${Math.round(timeoutMs / 1000)}s. Recovery will be attempted if available.\n`;
        this.streamingContent += visibleNotice;
        await this.postMessage({ type: 'stream-chunk', chunk: visibleNotice });

        const timeoutMessage: ChatMessage = {
          id: this._createMessageId(),
          role: 'system',
          content: `Tool-enabled LLM request timed out after ${Math.round(timeoutMs / 1000)}s. Recovery will be attempted if available.`,
          timestamp: new Date().toISOString(),
          instanceId: this.currentInstanceId,
        };
        this.messages.push(timeoutMessage);
        await this.persistMessages();
        await this.postMessage({
          type: 'addMessage',
          message: timeoutMessage,
          actions: this._buildMessageActions(timeoutMessage),
          roleMeta: this._roleMetaFor(timeoutMessage),
          contextFooter: this._contextFooterFor(timeoutMessage),
        });

        this._logTimeoutDiagnostics({
          provider,
          model,
          mode: 'tool',
          timeoutMs,
          recoveryAttempted: true,
          recovered: false,
          toolCount: tools.length,
          usedReducedContext: false,
          errorMessage,
        });
      }

      throw err;
    } finally {
      req.dispose();
      await this.postMessage({ type: 'stream-thinking', active: false });
    }
  }

  // Wrap-up fallback: the loop ran to maxPasses without the model emitting an
  // empty-toolCall response. If we have prior tool activity but no final text,
  // the chat would render "(No response)" and the autonomy parser would find no
  // structured envelope — leading to a spurious "Paused: no clear next step"
  // even though the model did real work. Force one no-tools pass so the model
  // is required to summarize what it did and what to do next.
  if (!finalText.trim() && rawMessages.length > llmMessages.length) {
    try {
      const wrapNote = '\n\n_(Wrapping up: agentic loop hit pass limit — requesting summary…)_\n';
      this.streamingContent += wrapNote;
      await this.postMessage({ type: 'stream-chunk', chunk: wrapNote });

      // Phase A — strict "you spent the budget on reads" wrap-up only when:
      // (1) a sticky patch anchor existed from a prior pass (a write was
      // already implied), AND (2) the loop ended with zero writes AND
      // heavy reads. Read-only / assess tasks and fresh user prompts get
      // the generic wrap-up regardless of read volume — reading is the
      // whole point of those turns. If the model DID write at any point
      // this turn, the generic wrap-up applies (writes lifted any prior
      // reservation).
      const heavyReadsNoWrite = hasStickyAnchorFromPriorPass
        && totalWriteToolCalls === 0
        && totalReadToolCalls >= WRITE_RESERVATION_READ_THRESHOLD;
      const wrapText = heavyReadsNoWrite
        ? 'You have used the available tool budget for this turn AND spent it entirely on reads (' + totalReadToolCalls + ' read calls, 0 writes). Stop calling tools. In your reply: (1) name the exact patch you WOULD have applied (file path + change in one sentence) OR the concrete missing prerequisite that prevented the write; (2) set goal_status to either "partial" with a write-bound recommended_next_step, or "blocked" with the missing prerequisite. Re-reading is no longer a valid next step. Emit the structured JSON envelope as instructed by the system prompt.'
        : 'You have used the available tool budget for this turn. Stop calling tools. In your reply, briefly summarize what you discovered, what you changed (if anything), the current state, and one clear recommended next step. If autonomy is enabled, emit the structured JSON envelope as instructed by the system prompt.';
      const wrapPrompt: Array<Record<string, unknown>> = [
        { type: 'text', text: wrapText },
      ];
      const wrapMessages = [...rawMessages, { role: 'user', content: wrapPrompt }];

      const wrapTimeout = this._getLlmTimeoutMs({ mode: 'stream' });
      const wrapReq = this._createRequestSignal(wrapTimeout);
      try {
        await this.postMessage({ type: 'stream-thinking', active: true });
        const wrapResponse = await this.architectLlm.callWithTools(wrapMessages as ArchitectMessage[], [], wrapMessages as unknown[], wrapReq.signal);
        if (wrapResponse.content) {
          const safeChunk = this._redactSecrets(wrapResponse.content);
          finalText += safeChunk;
          this.streamingContent += safeChunk;
          await this.postMessage({ type: 'stream-chunk', chunk: safeChunk });
        }
      } finally {
        wrapReq.dispose();
        await this.postMessage({ type: 'stream-thinking', active: false });
      }
    } catch (wrapErr) {
      // Best-effort fallback — don't mask the original loop result if wrap-up fails.
      const note = `\n\n⚠️ Could not generate wrap-up summary: ${wrapErr instanceof Error ? wrapErr.message : String(wrapErr)}\n`;
      finalText += note;
      this.streamingContent += note;
      await this.postMessage({ type: 'stream-chunk', chunk: note });
    }
  }

  return finalText;
}

  /**
   * Load markdown-it and DOMPurify browser builds from node_modules.
   * Results are cached on the instance. Falls back gracefully if files
   * are missing (e.g. corrupt .vsix or dev environment without npm install).
   */
  private _loadLibrarySources(): void {
    if (
      this._markdownItSource !== null &&
      this._domPurifySource !== null
    ) return;
    const extPath = this.context.extensionPath;
    // Vendor JS is copied to dist/vendor/ during build (see package.json `build:vendor`).
    // node_modules/** is excluded from the packaged VSIX, so loading from dist/vendor/ is the only reliable source at runtime.
    const libs: Array<{ key: 'md' | 'dp'; relPaths: string[]; name: string }> = [
      { key: 'md', relPaths: [path.join('dist', 'vendor', 'markdown-it.min.js'), path.join('node_modules', 'markdown-it', 'dist', 'markdown-it.min.js')], name: 'markdown-it' },
      { key: 'dp', relPaths: [path.join('dist', 'vendor', 'purify.min.js'), path.join('node_modules', 'dompurify', 'dist', 'purify.min.js')], name: 'DOMPurify' },
    ];
    for (const lib of libs) {
      let loaded = false;
      let lastErr: unknown;
      for (const rel of lib.relPaths) {
        try {
          const fullPath = path.join(extPath, rel);
          const src = fs.readFileSync(fullPath, 'utf-8');
          if (lib.key === 'md') this._markdownItSource = src;
          else this._domPurifySource = src;
          loaded = true;
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (!loaded) {
        console.error(`[DreamGraph] Failed to load ${lib.name} browser build from ${lib.relPaths.join(' or ')} — falling back to plaintext rendering. ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
        if (lib.key === 'md') this._markdownItSource = '';
        else this._domPurifySource = '';
      }
    }
  }

  private _getWebviewBundleUri(webview: vscode.Webview): string {
    if (this._webviewBundleUri !== null) return this._webviewBundleUri;
    try {
      const bundlePath = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js');
      this._webviewBundleUri = webview.asWebviewUri(bundlePath).toString();
    } catch (err) {
      console.error(`[DreamGraph] Failed to resolve webview bundle URI — falling back to inline scripts. ${err instanceof Error ? err.message : String(err)}`);
      this._webviewBundleUri = '';
    }
    return this._webviewBundleUri;
  }

  private _redactSecrets(content: string): string {
    return helpers.redactSecrets(content);
  }

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
  private async _listMcpToolsLazy(): Promise<Array<{ name: string; description?: string; inputSchema: unknown }>> {
    if (!this.mcpClient) return [];
    if (!this.mcpClient.isConnected) {
      try {
        await this.mcpClient.connect();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.contextInspector?.appendContextLine(
          `MCP lazy-connect failed: ${msg} — proceeding without DreamGraph tools.`,
        );
        return [];
      }
    }
    try {
      return await this.mcpClient.listTools();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.contextInspector?.appendContextLine(
        `MCP listTools failed: ${msg} — proceeding without DreamGraph tools.`,
      );
      return [];
    }
  }

  /**
   * Best-effort `callTool` that lazy-connects the MCP client. Used by
   * the agentic loop so a stale/never-connected client is repaired
   * inline rather than crashing the whole turn.
   */
  private async _callMcpToolWithLazyConnect(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.mcpClient) {
      throw new Error(`Tool "${name}" is not available — MCP client is not configured.`);
    }
    if (!this.mcpClient.isConnected) {
      await this.mcpClient.connect();
    }
    return this.mcpClient.callTool(name, args);
  }

  private async _executeMessageActionTool(toolName: string, input: Record<string, unknown>): Promise<unknown> {
    const startedAt = Date.now();
    let status: 'completed' | 'failed' = 'completed';
    try {
      if (isLocalTool(toolName)) {
        return await executeLocalTool(toolName, input);
      }
      if (!this.mcpClient?.isConnected) {
        // Lazy-connect attempt — same rationale as `_listMcpToolsLazy`.
        if (this.mcpClient) {
          try {
            await this.mcpClient.connect();
          } catch {
            // fall through to the explicit "not connected" error below
          }
        }
        if (!this.mcpClient?.isConnected) {
          throw new Error(`Tool "${toolName}" is not available — MCP client is not connected.`);
        }
      }
      return await this.mcpClient.callTool(toolName, input, ChatPanel._toolTimeoutMs(toolName));
    } catch (error) {
      status = 'failed';
      throw error;
    } finally {
      this._lastToolTrace.push({
        tool: toolName,
        argsSummary: this._summarizeToolArgs(input),
        filesAffected: this._extractFilesAffected(input, ''),
        durationMs: Date.now() - startedAt,
        status,
      });
    }
  }

  private _stringifyToolResult(result: unknown): string {
    return helpers.stringifyToolResult(result);
  }

  // ---------------------------- BudgetCoordinator (Phase 1) ----------------------------

  /**
   * Plan \u00a73.2 / \u00a75 settings:
   *   - `expectedTokensPerTurn`     soft target (default 16k)
   *   - `transportCeilingTokens`    safety invariant (default 180k)
   *   - `debtCarryFraction`         debt rollover fraction (default 1.0)
   *
   * Phase 1 is in-memory only. The snapshot is rolled forward on
   * `this._lastBudgetSnapshot`; persistence into chat session state is Phase 2.
   */
  private _createBudgetCoordinatorForTurn(): BudgetCoordinator {
    const cfg = vscode.workspace.getConfiguration('dreamgraph.architect');
    const expected = cfg.get<number>('expectedTokensPerTurn');
    const ceiling = cfg.get<number>('transportCeilingTokens');
    const carry = cfg.get<number>('debtCarryFraction');
    const modelId = this.architectLlm?.currentConfig?.model ?? this.architectLlm?.provider ?? 'unknown';
    return new BudgetCoordinator(this._lastBudgetSnapshot, {
      expectedTokensPerTurn: typeof expected === 'number' && expected > 0 ? expected : 16_000,
      transportCeilingTokens: typeof ceiling === 'number' && ceiling > 0 ? ceiling : 180_000,
      debtCarryFraction: typeof carry === 'number' && carry >= 0 ? carry : 1.0,
      turnNumber: this._budgetTurnCounter,
      modelId,
    });
  }

  private _finalizeCurrentBudgetTurn(): void {
    const coord = this._currentBudgetCoordinator;
    if (!coord) return;
    this._currentBudgetCoordinator = null;
    try {
      const snapshot = coord.finalizeTurn();
      this._lastBudgetSnapshot = snapshot;
      // Phase 2 — persist per-instance so the snapshot survives webview reload
      // and extension-host recreation (Plan §9 reload invariant).
      if (this.memory) {
        void this.memory
          .saveBudgetState(this.currentInstanceId, snapshot, this._budgetTurnCounter)
          .catch((err) => console.warn('[budget] persist failed', err));
      }
      // Dev-console diagnostic only — Phase 1 has no user-facing surface yet.
      const lastEntry = snapshot.history[snapshot.history.length - 1];
      const components = lastEntry?.components ?? {};
      console.log(
        `[budget] turn=${this._budgetTurnCounter} actual=${snapshot.lastActualTokens} ` +
        `delta=${lastEntry?.delta ?? 0} debt=${snapshot.debtTokens} ` +
        `pressure=${coord.getContextPressureLabel()} components=${JSON.stringify(components)}`,
      );

      // Per-turn budget pill (`dreamgraph.architect.budgetPillEnabled`, default on).
      // Posted as a fire-and-forget message; the webview ignores it when the
      // pill DOM is hidden, so cost when off is a single boolean check.
      try {
        const pillEnabled = vscode.workspace
          .getConfiguration('dreamgraph.architect')
          .get<boolean>('budgetPillEnabled', true);
        if (pillEnabled) {
          void this.postMessage({
            type: 'budgetStatus',
            status: {
              turn: this._budgetTurnCounter,
              debtTokens: snapshot.debtTokens,
              lastActualTokens: snapshot.lastActualTokens,
              expectedTokens: snapshot.expectedTokens,
              pressureLabel: coord.getContextPressureLabel(),
              components,
              delta: lastEntry?.delta ?? 0,
              modelId: snapshot.modelId,
            },
          });
        }
      } catch {
        // UI broadcast must never break finalize.
      }
    } catch (err) {
      console.warn('[budget] finalize failed', err);
    }
  }

  /** Read-only accessor for context-builder/reasoning-packet wiring. */
  public getCurrentBudgetCoordinator(): BudgetCoordinator | null {
    return this._currentBudgetCoordinator;
  }

  private _summarizeToolArgs(input: unknown): string {
    return helpers.summarizeToolArgs(input);
  }

  private _deriveVerdict(content: string, trace: ToolTraceEntry[]): VerdictBanner {
    return helpers.deriveVerdict(content, trace);
  }

  private _extractFilesAffected(toolNameOrInput: unknown, inputOrResult?: unknown, maybeResult?: string): string[] {
    return helpers.extractFilesAffected(toolNameOrInput, inputOrResult, maybeResult);
  }

  private async _verifyEntities(names: string[]): Promise<Record<string, EntityVerification>> {
    if (!this.mcpClient?.isConnected || !Array.isArray(names) || names.length === 0) {
      return {};
    }
    const unique = Array.from(new Set(names.map((n) => String(n || '').trim()).filter(Boolean))).slice(0, 100);
    const results: Record<string, EntityVerification> = {};
    for (let i = 0; i < unique.length; i += ChatPanel.MAX_VERIFICATION_BATCH_SIZE) {
      const batch = unique.slice(i, i + ChatPanel.MAX_VERIFICATION_BATCH_SIZE);
      try {
        const [featuresRaw, workflowsRaw, dataModelRaw, tensionsRaw, dreamsRaw] = await Promise.all([
          this.mcpClient.callTool('query_resource', { uri: 'system://features' }, ChatPanel.VERIFICATION_TIMEOUT_MS),
          this.mcpClient.callTool('query_resource', { uri: 'system://workflows' }, ChatPanel.VERIFICATION_TIMEOUT_MS),
          this.mcpClient.callTool('query_resource', { uri: 'system://data-model' }, ChatPanel.VERIFICATION_TIMEOUT_MS),
          this.mcpClient.callTool('query_resource', { uri: 'dream://tensions' }, ChatPanel.VERIFICATION_TIMEOUT_MS).catch(() => null),
          this.mcpClient.callTool('query_dreams', { type: 'all', status: 'latent', min_confidence: 0.4 }, ChatPanel.VERIFICATION_TIMEOUT_MS).catch(() => null),
        ]);

        const indexes = [featuresRaw, workflowsRaw, dataModelRaw].map((payload) => JSON.stringify(payload).toLowerCase());
        const tensionIndex = tensionsRaw ? JSON.stringify(tensionsRaw).toLowerCase() : '';
        const dreamIndex = dreamsRaw ? JSON.stringify(dreamsRaw).toLowerCase() : '';

        for (const name of batch) {
          const key = name.toLowerCase();
          if (tensionIndex && tensionIndex.includes(key)) {
            results[name] = { status: 'tension', confidence: 0.85 };
            continue;
          }
          if (indexes.some((index) => index.includes(key))) {
            results[name] = { status: 'verified', confidence: 0.8 };
            continue;
          }
          if (dreamIndex && dreamIndex.includes(key)) {
            results[name] = { status: 'latent', confidence: 0.5 };
            continue;
          }
          results[name] = { status: 'unverified', confidence: 0 };
        }
      } catch {
        return {};
      }
    }
    return results;
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this._loadLibrarySources();

    const markdownItScript = this._markdownItSource
      ? `<script nonce="${nonce}">${this._markdownItSource}</script>`
      : '';
    const domPurifyScript = this._domPurifySource
      ? `<script nonce="${nonce}">${this._domPurifySource}</script>`
      : '';
    const cardRendererScript = `<script nonce="${nonce}">${getCardRendererScript()}</script>`;
    const renderScript = `<script nonce="${nonce}">${getRenderScript()}</script>`;
    const entityLinkScript = `<script nonce="${nonce}">${getEntityLinksScript()}</script>`;
    const webviewBundleScript = this._webviewBundleUri
      ? `<script nonce="${nonce}" src="${this._webviewBundleUri}"></script>`
      : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>${getStyles()}</style>
</head>
<body>
  <div class="header">
    <select id="provider-select" title="Provider"></select>
    <select id="model-select" title="Model"></select>
    <select id="autonomy-mode-select" class="autonomy-mode-select" title="Autonomy mode">
      <option value="cautious">cautious</option>
      <option value="conscientious">conscientious</option>
      <option value="eager">eager</option>
      <option value="autonomous">autonomous</option>
    </select>
    <span id="pass-budget" class="pass-budget" title="Pass budget — remaining / total">— / —</span>
    <span id="time-budget" class="time-budget" title="Time budget (ADR-153) — wired in next patch">—</span>
    <button id="set-api-key-btn" class="icon-btn" title="Set API key" aria-label="Set API key">🔑</button>
    <button id="clear-btn" class="icon-btn" title="Clear conversation" aria-label="Clear conversation">🗑️</button>
  </div>
  <div id="autonomy-bar" style="display:none">
    <span id="autonomy-mode-label"></span>
    <span id="autonomy-counter"></span>
    <button id="autonomy-reset-btn" class="icon-btn" title="Reset autonomy" aria-label="Reset autonomy" style="display:none">✕</button>
  </div>

  <div id="budget-pill" style="display:none" title="DreamGraph budget (debug)">
    <span id="budget-pill-pressure" class="budget-pill-pressure"></span>
    <span id="budget-pill-tokens"></span>
    <span id="budget-pill-debt"></span>
    <span id="budget-pill-components" class="budget-pill-components"></span>
  </div>

  <div id="pending-reviews" class="pending-reviews" style="display:none"></div>
  <div id="messages"></div>
  <div id="empty-state">
    <div class="empty-logo">🌙</div>
    <h2>DreamGraph Architect</h2>
    <p>Ask about features, workflows, data models, ADRs, tensions, or request changes.</p>
    <div class="example-prompts">
      <button class="example-prompt-btn" data-example="Explain the active file in system context">Explain the active file</button>
      <button class="example-prompt-btn" data-example="What architectural tensions exist?">Show tensions</button>
      <button class="example-prompt-btn" data-example="Scan the project and enrich the graph">Scan project</button>
    </div>
  </div>
  <div id="thinking-indicator" style="display:none">
    <div class="thinking-label-row">
      <span id="thinking-label">Dreaming…</span>
      <span class="thinking-dots" aria-hidden="true"><span></span><span></span><span></span></span>
    </div>
    <div id="tool-progress-list"></div>
  </div>
  <div id="attachments"></div>
  <div id="composer">
    <button id="attach-btn" class="icon-btn" title="Attach files" aria-label="Attach files">📎</button>
    <textarea id="prompt" rows="1" placeholder="Ask DreamGraph Architect…"></textarea>
    <button id="send-btn" class="icon-btn primary" title="Send" aria-label="Send">➤</button>
    <button id="stop-btn" class="icon-btn danger" title="Stop" aria-label="Stop" style="display:none">■</button>
  </div>

  ${markdownItScript}
  ${domPurifyScript}
  ${webviewBundleScript}
  ${!this._webviewBundleUri ? cardRendererScript : ''}
  ${!this._webviewBundleUri ? renderScript : ''}
  ${!this._webviewBundleUri ? entityLinkScript : ''}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const pendingReviewsEl = document.getElementById('pending-reviews');
    const messagesEl = document.getElementById('messages');
    const emptyStateEl = document.getElementById('empty-state');
    const promptEl = document.getElementById('prompt');
    const sendBtn = document.getElementById('send-btn');
    const stopBtn = document.getElementById('stop-btn');
    const clearBtn = document.getElementById('clear-btn');
    const attachBtn = document.getElementById('attach-btn');
    const attachmentsEl = document.getElementById('attachments');
    const composerEl = document.getElementById('composer');
    const providerSelect = document.getElementById('provider-select');
    const modelSelect = document.getElementById('model-select');
    const setApiKeyBtn = document.getElementById('set-api-key-btn');
    const thinkingEl = document.getElementById('thinking-indicator');
    const thinkingLabel = document.getElementById('thinking-label');
    const toolProgressListEl = document.getElementById('tool-progress-list');

    let draftSaveTimer = null;
    let lastToolTrace = [];
    let pendingReviews = [];
    let pendingReviewsCollapsed = true;
    let lastVerdict = null;
    let streamingBubble = null;
    let streamingMarkdownEl = null;
    let streamingRaw = '';
    let optimisticSubmitBubble = null;
    let optimisticSubmitMarkdownEl = null;
    let verifyTimer = null;
    const pendingVerification = new Map();
    const actionStates = new Map();

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function formatAttachmentSize(bytes) {
      const n = Number(bytes);
      if (!isFinite(n) || n <= 0) return '0 B';
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
      return (n / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function setEmptyStateVisible(visible) {
      emptyStateEl.style.display = visible ? 'flex' : 'none';
      messagesEl.style.display = visible ? 'none' : 'flex';
    }

    function formatPendingReviewSummary(review) {
      const from = review.baselineKind === 'missing' ? 'new file' : 'existing file';
      const to = review.currentKind === 'deleted' ? 'deleted state' : 'edited state';
      return from + ' → ' + to;
    }

    function makePendingReviewButton(label, className, handler) {
      const button = document.createElement('button');
      button.className = className;
      button.textContent = label;
      button.addEventListener('click', handler);
      return button;
    }

    function renderPendingReviews(reviews, collapsed) {
      pendingReviews = Array.isArray(reviews) ? reviews : [];
      pendingReviewsCollapsed = collapsed !== false;
      if (!pendingReviewsEl) return;
      pendingReviewsEl.innerHTML = '';
      if (pendingReviews.length === 0) {
        pendingReviewsEl.style.display = 'none';
        messagesEl.style.paddingBottom = '24px';
        messagesEl.style.scrollPaddingBottom = '24px';
        return;
      }

      const totalAdded = pendingReviews.reduce((sum, review) => sum + (Number(review.addedLines) || 0), 0);
      const totalDeleted = pendingReviews.reduce((sum, review) => sum + (Number(review.deletedLines) || 0), 0);
      pendingReviewsEl.style.display = 'block';
      pendingReviewsEl.style.border = '1px solid var(--vscode-panel-border)';
      pendingReviewsEl.style.borderRadius = '8px';
      pendingReviewsEl.style.margin = '0 10px 8px';
      pendingReviewsEl.style.padding = '6px 10px';
      pendingReviewsEl.style.background = 'var(--vscode-sideBar-background)';
      pendingReviewsEl.style.fontSize = '12px';
      pendingReviewsEl.style.order = '2';
      const pendingReviewsHeight = pendingReviewsEl.offsetHeight || 0;
      const bottomReserve = Math.max(72, pendingReviewsHeight + 16);
      messagesEl.style.paddingBottom = bottomReserve + 'px';
      messagesEl.style.scrollPaddingBottom = bottomReserve + 'px';

      const header = document.createElement('div');
      header.className = 'pending-reviews-title';
      header.style.display = 'flex';
      header.style.alignItems = 'center';
      header.style.justifyContent = 'space-between';
      header.style.gap = '8px';

      const titleButton = document.createElement('button');
      titleButton.type = 'button';
      titleButton.className = 'pending-review-toggle';
      titleButton.style.all = 'unset';
      titleButton.style.cursor = 'pointer';
      titleButton.style.display = 'inline-flex';
      titleButton.style.alignItems = 'center';
      titleButton.style.gap = '6px';
      titleButton.innerHTML = '<span style="font-size:10px;opacity:.8">' + (pendingReviewsCollapsed ? '▶' : '▼') + '</span>'
        + '<strong>' + (pendingReviews.length === 1 ? '1 file changed' : pendingReviews.length + ' files changed') + '</strong>'
        + ' <span style="color:var(--vscode-gitDecoration-addedResourceForeground,#3fb950)">+' + totalAdded + '</span>'
        + ' <span style="color:var(--vscode-gitDecoration-deletedResourceForeground,#f85149)">-' + totalDeleted + '</span>';
      titleButton.addEventListener('click', () => {
        pendingReviewsCollapsed = !pendingReviewsCollapsed;
        vscode.postMessage({ type: 'togglePendingReviews' });
        renderPendingReviews(pendingReviews, pendingReviewsCollapsed);
      });

      const bulkActions = document.createElement('div');
      bulkActions.style.display = 'flex';
      bulkActions.style.gap = '6px';
      bulkActions.appendChild(makePendingReviewButton('Keep', 'message-action-btn primary', () => {
        for (const review of pendingReviews) vscode.postMessage({ type: 'keepPendingReview', filePath: review.filePath });
      }));
      bulkActions.appendChild(makePendingReviewButton('Undo', 'message-action-btn', () => {
        for (const review of pendingReviews) vscode.postMessage({ type: 'undoPendingReview', filePath: review.filePath });
      }));
      header.appendChild(titleButton);
      header.appendChild(bulkActions);
      pendingReviewsEl.appendChild(header);

      if (pendingReviewsCollapsed) {
        return;
      }

      const list = document.createElement('div');
      list.style.display = 'flex';
      list.style.flexDirection = 'column';
      list.style.gap = '4px';
      list.style.marginTop = '8px';

      for (const review of pendingReviews) {
        const row = document.createElement('div');
        row.className = 'pending-review-row';
        row.style.display = 'grid';
        row.style.gridTemplateColumns = '1fr auto';
        row.style.alignItems = 'center';
        row.style.gap = '8px';

        const pathButton = document.createElement('button');
        pathButton.type = 'button';
        pathButton.className = 'pending-review-path';
        pathButton.style.all = 'unset';
        pathButton.style.cursor = 'pointer';
        pathButton.style.color = 'var(--vscode-textLink-foreground)';
        pathButton.style.overflow = 'hidden';
        pathButton.style.textOverflow = 'ellipsis';
        pathButton.style.whiteSpace = 'nowrap';
        pathButton.textContent = review.relativePath || review.filePath;
        pathButton.title = 'Open diff';
        pathButton.addEventListener('click', () => vscode.postMessage({ type: 'openPendingReview', filePath: review.filePath }));

        const stats = document.createElement('div');
        stats.innerHTML = '<span style="color:var(--vscode-gitDecoration-addedResourceForeground,#3fb950);font-weight:600">+' + (Number(review.addedLines) || 0) + '</span> '
          + '<span style="color:var(--vscode-gitDecoration-deletedResourceForeground,#f85149);font-weight:600">-' + (Number(review.deletedLines) || 0) + '</span>';

        row.appendChild(pathButton);
        row.appendChild(stats);
        list.appendChild(row);
      }

      pendingReviewsEl.appendChild(list);
    }

    function autoresize() {
      promptEl.style.height = 'auto';
      promptEl.style.height = Math.min(promptEl.scrollHeight, 200) + 'px';
    }

    function clearImmediateSubmitFeedback(options) {
      const keepBusy = !!(options && options.keepBusy);
      if (composerEl) composerEl.classList.remove('submit-pending');
      if (optimisticSubmitBubble) optimisticSubmitBubble.remove();
      optimisticSubmitBubble = null;
      optimisticSubmitMarkdownEl = null;
      if (!keepBusy && !streamingBubble) {
        sendBtn.style.display = 'inline-flex';
        stopBtn.style.display = 'none';
        thinkingEl.style.display = 'none';
      }
    }

    function beginImmediateSubmitFeedback() {
      clearImmediateSubmitFeedback({ keepBusy: true });
      setEmptyStateVisible(false);
      if (composerEl) composerEl.classList.add('submit-pending');

      optimisticSubmitBubble = document.createElement('div');
      optimisticSubmitBubble.className = 'message assistant optimistic-submit';
      optimisticSubmitBubble.setAttribute('aria-live', 'polite');
      optimisticSubmitMarkdownEl = document.createElement('div');
      optimisticSubmitMarkdownEl.className = 'markdown-body immediate-submit-feedback';
      optimisticSubmitMarkdownEl.innerHTML = '<span class="immediate-submit-pulse" aria-hidden="true"></span><span>Assessing the shape of the request…</span>';
      optimisticSubmitBubble.appendChild(optimisticSubmitMarkdownEl);
      messagesEl.appendChild(optimisticSubmitBubble);
      const submitReserve = Math.max(72, (pendingReviewsEl ? pendingReviewsEl.offsetHeight : 0) + 16);
      messagesEl.style.paddingBottom = submitReserve + 'px';
      messagesEl.style.scrollPaddingBottom = submitReserve + 'px';
      messagesEl.scrollTop = messagesEl.scrollHeight;

      sendBtn.style.display = 'none';
      stopBtn.style.display = 'inline-flex';
      thinkingEl.style.display = 'flex';
    }

    function submitPrompt() {
      const text = promptEl.value.trim();
      if (!text) return;
      beginImmediateSubmitFeedback();
      vscode.postMessage({ type: 'send', text });
      promptEl.value = '';
      autoresize();
      queueDraftSave();
    }

    function queueDraftSave() {
      if (draftSaveTimer) clearTimeout(draftSaveTimer);
      draftSaveTimer = setTimeout(() => {
        vscode.postMessage({ type: 'saveDraft', text: promptEl.value });
      }, 250);
    }

    function createRoleHeader(roleMeta, messageId) {
      const header = document.createElement('div');
      header.className = 'message-header';
      const left = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'message-role-title';
      title.textContent = roleMeta?.title || 'Message';
      left.appendChild(title);
      if (roleMeta?.subtitle) {
        const subtitle = document.createElement('div');
        subtitle.className = 'message-role-subtitle';
        subtitle.textContent = roleMeta.subtitle;
        left.appendChild(subtitle);
      }
      const hoverActions = document.createElement('div');
      hoverActions.className = 'message-actions-hover';
      [['Copy','copyMessage'],['Retry','retryMessage'],['Pin','pinMessage']].forEach(([label, type]) => {
        const btn = document.createElement('button');
        btn.className = 'message-mini-btn';
        btn.textContent = label;
        btn.addEventListener('click', () => vscode.postMessage({ type, messageId }));
        hoverActions.appendChild(btn);
      });
      header.appendChild(left);
      header.appendChild(hoverActions);
      return header;
    }

    function renderVerdictBanner(verdict) {
      if (!verdict) return null;
      const banner = document.createElement('div');
      banner.className = 'verdict-banner verdict-' + verdict.level;
      const label = document.createElement('span');
      label.className = 'verdict-label';
      label.textContent = verdict.level;
      const summary = document.createElement('span');
      summary.textContent = verdict.summary;
      banner.appendChild(label);
      banner.appendChild(summary);
      return banner;
    }

    function renderToolTrace(trace) {
      if (!Array.isArray(trace) || trace.length === 0) return null;
      const details = document.createElement('details');
      details.className = 'tool-trace';
      const summary = document.createElement('summary');
      summary.textContent = 'Tool trace (' + trace.length + ')';
      details.appendChild(summary);
      const list = document.createElement('div');
      list.className = 'tool-trace-list';
      for (const entry of trace) {
        const item = document.createElement('div');
        item.className = 'tool-trace-item';
        const head = document.createElement('div');
        head.className = 'tool-trace-head';
        head.innerHTML = '<span>' + escapeHtml(entry.tool || 'tool') + '</span><span>' + escapeHtml(entry.status || '') + '</span>';
        const meta = document.createElement('div');
        meta.className = 'tool-trace-meta';
        meta.textContent = (entry.argsSummary || '') + (entry.filesAffected?.length ? ' • ' + entry.filesAffected.join(', ') : '') + (Number.isFinite(entry.durationMs) ? ' • ' + entry.durationMs + 'ms' : '');
        item.appendChild(head);
        item.appendChild(meta);
        list.appendChild(item);
      }
      details.appendChild(list);
      return details;
    }

    function renderProvenance(message, trace) {
      const div = document.createElement('div');
      div.className = 'message-provenance';
      div.textContent = trace && trace.length > 0
        ? 'Provenance: grounded in executed tools and rendered output.'
        : 'Provenance: rendered output without executed tool trace.';
      return div;
    }

    function renderContextFooter(text) {
      if (!text) return null;
      const div = document.createElement('div');
      div.className = 'message-context-footer';

      // Parse optional anchor-status sentinel: [anchor-status:STATE:LABEL]
      // If found, strip sentinel from display text and append a styled badge.
      // NOTE: backslashes are doubled because this code is inside a JS template literal
      // in getHtml(). At runtime, the template literal strips single backslashes
      // (\s → s, \[ → [), so \\s → \s and \\[ → \[ after evaluation.
      const sentinelRe = /\\s*\\[anchor-status:([a-z]+):([^\\]]*)\\]\\s*$/;
      const match = text.match(sentinelRe);
      if (match) {
        const anchorState = match[1]; // promoted|rebound|drifted|archived|native|canonical
        const anchorLabel = match[2];
        const cleanText = text.replace(sentinelRe, '').trimEnd();
        // Render prefix (e.g. "Instance: xxx • ") as plain text
        const prefix = document.createTextNode(cleanText);
        div.appendChild(prefix);
        // Render the badge
        const badge = document.createElement('span');
        badge.className = 'anchor-state-badge anchor-state-' + anchorState;
        badge.textContent = anchorLabel ? anchorState + ': ' + anchorLabel : anchorState;
        badge.title = 'Semantic anchor migration state';
        div.appendChild(badge);
      } else {
        div.textContent = text;
      }
      return div;
    }

    function renderImplicitEntityNotice(text) {
      if (!text) return null;
      const div = document.createElement('div');
      div.className = 'implicit-entity-notice';
      div.textContent = text;
      return div;
    }

    function getActionState(messageId, actionId) {
      return actionStates.get(messageId + ':' + actionId) || { status: 'idle', error: '' };
    }

    function renderMessageActions(message, actions) {
      if (!Array.isArray(actions) || actions.length === 0) return null;
      const wrap = document.createElement('div');
      wrap.className = 'message-actions';
      for (const action of actions) {
        const state = getActionState(message.id, action.id);
        const btn = document.createElement('button');
        btn.className = 'message-action-btn ' + (action.kind === 'primary' ? 'primary' : 'secondary') + (state.status === 'loading' ? ' loading' : '');
        btn.textContent = action.label;
        btn.disabled = state.status === 'loading';
        btn.addEventListener('click', () => {
          if (state.status === 'loading') return;
          vscode.postMessage({ type: 'runMessageAction', messageId: message.id, actionId: action.id });
        });
        wrap.appendChild(btn);
        if (state.status === 'failed' && state.error) {
          const error = document.createElement('div');
          error.className = 'message-action-error';
          error.textContent = state.error;
          wrap.appendChild(error);
        }
      }
      return wrap;
    }

    function scheduleVerification(container) {
      if (!container || typeof window.linkifyEntities !== 'function') return;
      if (verifyTimer) clearTimeout(verifyTimer);
      verifyTimer = setTimeout(() => {
        const names = Array.from(container.querySelectorAll('a.entity-link'))
          .map((a) => a.getAttribute('data-entity-name') || a.getAttribute('data-uri') || a.textContent || '')
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 100);
        if (names.length === 0) return;
        const requestId = 'verify_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        pendingVerification.set(requestId, container);
        vscode.postMessage({ type: 'verifyEntities', requestId, names });
      }, 80);
    }

    function applyEntityVerification(container, results) {
      if (!container) return;
      for (const link of container.querySelectorAll('a.entity-link')) {
        const name = (link.getAttribute('data-entity-name') || link.getAttribute('data-uri') || link.textContent || '').trim();
        const status = results?.[name]?.status || 'unverified';
        link.classList.remove('entity-verified', 'entity-latent', 'entity-tension', 'entity-unverified');
        link.classList.add('entity-' + status);
      }
    }

    function schedulePostRenderWork(node, options) {
      if (!node) return;
      const opts = options || {};
      requestAnimationFrame(() => {
        if (typeof window.applyEntityLinks === 'function') {
          window.applyEntityLinks(node);
        }

        function isStructuredEnvelope(obj) {
          return !!(obj && typeof obj === 'object' && typeof obj.summary === 'string' &&
            ('goal_status' in obj || 'recommended_next_steps' in obj));
        }

        function tryParseEnvelopeText(text) {
          if (!text) return null;
          const raw = String(text).trim();
          if (!raw) return null;

          const candidates = [];
          candidates.push(raw);

          if (raw.charCodeAt(0) === 96 && raw.charCodeAt(1) === 96 && raw.charCodeAt(2) === 96) {
            let body = raw;
            if (body.slice(0, 7) === String.fromCharCode(96, 96, 96, 106, 115, 111, 110)) {
              body = body.slice(7);
            } else {
              body = body.slice(3);
            }
            if (body.length >= 3 && body.charCodeAt(body.length - 1) === 96 && body.charCodeAt(body.length - 2) === 96 && body.charCodeAt(body.length - 3) === 96) {
              body = body.slice(0, -3);
            }
            body = body.trim();
            if (body) candidates.push(body);
          }

          const firstBrace = raw.indexOf('{');
          const lastBrace = raw.lastIndexOf('}');
          if (firstBrace >= 0 && lastBrace > firstBrace) {
            const objectText = raw.slice(firstBrace, lastBrace + 1).trim();
            if (objectText) candidates.push(objectText);
          }

          for (const candidate of candidates) {
            try {
              const parsed = JSON.parse(candidate);
              if (isStructuredEnvelope(parsed)) {
                return parsed;
              }
            } catch (_e) {
            }
          }

          return null;
        }

        function replaceEnvelopeElement(target, obj) {
          if (!target || !obj || typeof window.renderEnvelope !== 'function') return false;
          const wrapper = document.createElement('div');
          wrapper.innerHTML = window.renderEnvelope(obj);
          const rendered = wrapper.firstElementChild;
          if (!rendered) return false;
          if (obj && typeof obj === 'object') {
            // The renderer now emits data-action-label directly on each
            // button (it also drops dead/synthetic "Step N" entries), so
            // index-based reassignment from steps[] would mis-align after
            // skipped entries. Only set Do-all label list, which is whole-list.
            const steps = Array.isArray(obj.recommended_next_steps) ? obj.recommended_next_steps : [];
            const labels = steps.map((step) => (step && typeof step.label === 'string' ? step.label : '')).filter(Boolean);
            const doAllButton = rendered.querySelector('.dg-envelope-do-all');
            if (doAllButton && labels.length > 0) {
              doAllButton.setAttribute('data-action-labels', JSON.stringify(labels));
            }
          }
          target.replaceWith(rendered);
          return true;
        }

        if (typeof window.renderEnvelope === 'function') {
          node.querySelectorAll('pre').forEach((pre) => {
            const code = pre.querySelector('code');
            const text = code ? (code.textContent || '') : (pre.textContent || '');
            const parsed = tryParseEnvelopeText(text);
            if (parsed) {
              replaceEnvelopeElement(pre, parsed);
            }
          });

          node.querySelectorAll('code').forEach((code) => {
            if (!code.parentElement || code.closest('.dg-envelope')) return;
            const parsed = tryParseEnvelopeText(code.textContent || '');
            if (parsed) {
              replaceEnvelopeElement(code, parsed);
            }
          });

          Array.from(node.children || []).forEach((child) => {
            if (!child) return;
            if (child.classList && child.classList.contains('dg-envelope')) return;
            if (child.tagName === 'PRE' || child.tagName === 'CODE') return;
            const parsed = tryParseEnvelopeText(child.textContent || '');
            if (parsed) {
              replaceEnvelopeElement(child, parsed);
            }
          });
        }

        // Wire envelope action chip clicks
        node.querySelectorAll('.dg-envelope-action:not([data-wired])').forEach((btn) => {
          btn.setAttribute('data-wired', '1');
          btn.addEventListener('click', () => {
            const actionId = btn.getAttribute('data-action-id') || '';
            const label = btn.getAttribute('data-action-label') || '';
            if (actionId || label) {
              vscode.postMessage({ type: 'selectRecommendedAction', actionId, label });
            }
          });
        });
        node.querySelectorAll('.dg-envelope-do-all:not([data-wired])').forEach((btn) => {
          btn.setAttribute('data-wired', '1');
          btn.addEventListener('click', () => {
            let labels = [];
            const raw = btn.getAttribute('data-action-labels') || '[]';
            try {
              const parsed = JSON.parse(raw);
              if (Array.isArray(parsed)) labels = parsed.map((label) => String(label || '')).filter(Boolean);
            } catch (_e) {
            }
            vscode.postMessage({ type: 'doAllRecommendedActions', labels });
          });
        });
        if (opts.verify !== false) {
          scheduleVerification(node);
        }
        if (opts.stickToBottom !== false) {
          const renderReserve = Math.max(72, (pendingReviewsEl ? pendingReviewsEl.offsetHeight : 0) + 16);
          messagesEl.style.paddingBottom = renderReserve + 'px';
          messagesEl.style.scrollPaddingBottom = renderReserve + 'px';
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
      });
    }

    function renderAssistantBody(message) {
      const wrapper = document.createElement('div');
      wrapper.className = 'markdown-body';
      const renderMarkdown = window.renderMarkdown || ((s) => escapeHtml(s));
      const rawContent = String(message && message.content ? message.content : '');
      const normalizedCandidate = String(message && (message.fullContent || message.content) ? (message.fullContent || message.content) : '');
      const normalizeEnvelopeFence = window.normalizeEnvelopeFence || ((s) => s);
      const tryParseEnvelope = window.tryParseEnvelope || (() => null);
      const normalizedContent = normalizeEnvelopeFence(rawContent);
      const normalizedCandidateContent = normalizeEnvelopeFence(normalizedCandidate);
      const envelope = tryParseEnvelope(normalizedContent) || tryParseEnvelope(normalizedCandidateContent);
      if (envelope && typeof window.renderEnvelope === 'function') {
        wrapper.innerHTML = window.renderEnvelope(envelope);
      } else {
        let html = renderMarkdown(normalizedContent);
        if (typeof window.linkifyEntities === 'function') {
          html = window.linkifyEntities(html) || html;
        }
        wrapper.innerHTML = html;
      }
      schedulePostRenderWork(wrapper, { verify: false, stickToBottom: false });
      return wrapper;
    }

    function createMessageNode(message, actions, roleMeta, contextFooter, uiState) {
      const bubble = document.createElement('div');
      bubble.className = 'message ' + message.role;
      bubble.dataset.messageId = message.id || '';
      if (roleMeta) bubble.appendChild(createRoleHeader(roleMeta, message.id));

      if (message.role === 'assistant') {
        const state = uiState || {};
        const body = renderAssistantBody(message);
        bubble.appendChild(body);
        const verdict = renderVerdictBanner(state.verdict || null);
        if (verdict) bubble.appendChild(verdict);
        const implicit = renderImplicitEntityNotice(message.implicitEntityNotice);
        if (implicit) bubble.appendChild(implicit);
        const trace = renderToolTrace(state.toolTrace || []);
        if (trace) bubble.appendChild(trace);
        bubble.appendChild(renderProvenance(message, state.toolTrace || []));
        const actionBlock = renderMessageActions(message, actions);
        if (actionBlock) bubble.appendChild(actionBlock);
        const footer = renderContextFooter(contextFooter);
        if (footer) bubble.appendChild(footer);
      } else {
        if (roleMeta) {
          const body = document.createElement('div');
          body.className = 'message-text';
          body.textContent = message.content || '';
          bubble.appendChild(body);
        } else {
          bubble.textContent = message.content || '';
        }
        const atts = Array.isArray(message.attachments) ? message.attachments : [];
        if (atts.length > 0) {
          const wrap = document.createElement('div');
          wrap.className = 'message-attachments';
          for (const att of atts) {
            if (att.kind === 'image' && att.dataBase64) {
              const img = document.createElement('img');
              img.className = 'message-attachment-thumb';
              img.alt = att.name || 'attachment';
              img.title = (att.name || '') + ' · ' + (att.mimeType || 'image') + ' · ' + formatAttachmentSize(att.size);
              img.src = 'data:' + (att.mimeType || 'image/png') + ';base64,' + att.dataBase64;
              wrap.appendChild(img);
            } else {
              const chip = document.createElement('div');
              chip.className = 'message-attachment-file';
              const icon = att.kind === 'image' ? '🖼️' : '📄';
              chip.textContent = icon + ' ' + (att.name || 'attachment') + ' · ' + (att.mimeType || 'file') + ' · ' + formatAttachmentSize(att.size);
              wrap.appendChild(chip);
            }
          }
          bubble.appendChild(wrap);
        }
        const footer = renderContextFooter(contextFooter);
        if (footer) bubble.appendChild(footer);
      }
      return bubble;
    }

    function addMessage(message, actions, roleMeta, contextFooter, uiState) {
      setEmptyStateVisible(false);
      const node = createMessageNode(message, actions, roleMeta, contextFooter, uiState);
      messagesEl.appendChild(node);
      requestAnimationFrame(() => {
        const messageReserve = Math.max(72, (pendingReviewsEl ? pendingReviewsEl.offsetHeight : 0) + 16);
        messagesEl.style.paddingBottom = messageReserve + 'px';
        messagesEl.style.scrollPaddingBottom = messageReserve + 'px';
        messagesEl.scrollTop = messagesEl.scrollHeight;
      });
    }

    function rerenderMessageActions(messageId) {
      const bubble = messagesEl.querySelector('.message[data-message-id="' + messageId + '"]');
      if (!bubble) return;
      const state = vscode.getState() || {};
      const messages = state.messages || [];
      const entry = messages.find((m) => m.message?.id === messageId);
      if (!entry) return;
      // IN-PLACE replacement. The previous implementation called
      // bubble.remove() then addMessage(...) which appends to the END of
      // #messages. That moved the bubble to the bottom of the conversation
      // every time an action-state update arrived, creating the symptom
      // "the SUMMARY card / chips suddenly disappear from where they were".
      // It also fired the addMessage forced-scroll-to-bottom, which is why
      // scrolling back manually appeared to bring the card back: the card was
      // never gone, just moved.
      const newBubble = createMessageNode(
        entry.message,
        entry.actions,
        entry.roleMeta,
        entry.contextFooter,
        entry.uiState || { toolTrace: [], verdict: null },
      );
      bubble.replaceWith(newBubble);
    }

    function startStreaming() {
      clearImmediateSubmitFeedback({ keepBusy: true });
      setEmptyStateVisible(false);
      streamingRaw = '';
      streamingBubble = document.createElement('div');
      streamingBubble.className = 'message assistant';
      streamingMarkdownEl = document.createElement('div');
      streamingMarkdownEl.className = 'markdown-body';
      streamingBubble.appendChild(streamingMarkdownEl);
      messagesEl.appendChild(streamingBubble);
      schedulePostRenderWork(streamingMarkdownEl, { verify: false });
      sendBtn.style.display = 'none';
      stopBtn.style.display = 'inline-flex';
      thinkingEl.style.display = 'flex';
    }

    function updateStreaming(chunk) {
      if (!streamingBubble || !streamingMarkdownEl) return;
      streamingRaw += chunk;
      const renderMarkdown = window.renderMarkdown || ((s) => escapeHtml(s));
      const normalizeEnvelopeFence = window.normalizeEnvelopeFence || ((s) => s);
      const tryParseEnvelope = window.tryParseEnvelope || (() => null);
      const normalizedContent = normalizeEnvelopeFence(streamingRaw);
      const envelope = tryParseEnvelope(normalizedContent);
      if (envelope && typeof window.renderEnvelope === 'function') {
        streamingMarkdownEl.innerHTML = window.renderEnvelope(envelope);
      } else {
        // Hide an unclosed trailing structured-envelope block while it streams.
        // The contract emits the envelope as a fenced code block at the end of
        // the message. While the closing fence has not yet arrived, markdown-it
        // would render the partial JSON as a raw code block — flashing braces
        // and field names at the user before the final card replaces it.
        // Substitute a "Building structured response…" placeholder until either
        // the fence closes (normalizeEnvelopeFence + the fence plugin then
        // render the card) or streaming ends and the final addMessage takes over.
        // NOTE: this code is inside a JS template literal in getHtml() — single
        // backslashes are stripped at evaluation, so doubled backslashes are
        // required to reach the runtime regex/string.
        const FENCE = String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96);
        let display = normalizedContent;
        const fenceOpen = display.lastIndexOf(FENCE);
        let hidPartial = false;
        if (fenceOpen >= 0) {
          const afterFence = display.slice(fenceOpen + 3);
          // Closing fence is on its own line. If we don't find one after the
          // most recent opening fence, the block is unclosed.
          const closeRe = new RegExp('\\n[ \\t]*' + FENCE + '[ \\t]*$');
          const hasClose = closeRe.test('\\n' + afterFence);
          if (!hasClose) {
            const firstLineEnd = afterFence.indexOf('\\n');
            const lang = (firstLineEnd >= 0 ? afterFence.slice(0, firstLineEnd) : afterFence).trim().toLowerCase();
            const body = firstLineEnd >= 0 ? afterFence.slice(firstLineEnd + 1) : '';
            const looksJson = lang === '' || lang === 'json' || lang === 'jsonc';
            const bodyTrimmed = body.replace(/^\\s+/, '');
            const looksEnvelope = bodyTrimmed.charAt(0) === '{' && (
              bodyTrimmed.indexOf('"summary"') >= 0 ||
              bodyTrimmed.indexOf('"goal_status"') >= 0 ||
              bodyTrimmed.indexOf('"recommended_next_steps"') >= 0
            );
            if (looksJson && looksEnvelope) {
              display = display.slice(0, fenceOpen).replace(/\\s+$/, '') +
                '\\n\\n_Building structured response…_\\n';
              hidPartial = true;
            }
          }
        }
        if (!hidPartial) {
          // Bare top-level JSON envelope (no fence). Same idea: if we see an
          // unbalanced "{" with "summary" inside near the tail, hide it.
          const summaryIdx = display.search(/\\{\\s*[\\s\\S]*?"summary"\\s*:/);
          if (summaryIdx >= 0) {
            let depth = 0, inStr = false, esc = false, quote = '', balanced = false;
            // Walk back to the enclosing '{' at depth 0.
            let braceStart = -1, dBack = 0, sBack = false, eBack = false, qBack = '';
            for (let j = summaryIdx; j >= 0; j--) {
              const ch = display[j];
              if (sBack) {
                if (eBack) { eBack = false; continue; }
                if (ch === '\\\\') { eBack = true; continue; }
                if (ch === qBack) sBack = false;
                continue;
              }
              if (ch === '"' || ch === "'") { sBack = true; qBack = ch; continue; }
              if (ch === '}') dBack++;
              else if (ch === '{') { if (dBack === 0) { braceStart = j; break; } dBack--; }
            }
            if (braceStart >= 0) {
              for (let i = braceStart; i < display.length; i++) {
                const ch = display[i];
                if (inStr) {
                  if (esc) { esc = false; continue; }
                  if (ch === '\\\\') { esc = true; continue; }
                  if (ch === quote) inStr = false;
                  continue;
                }
                if (ch === '"' || ch === "'") { inStr = true; quote = ch; continue; }
                if (ch === '{') depth++;
                else if (ch === '}') { depth--; if (depth === 0) { balanced = true; break; } }
              }
              if (!balanced) {
                display = display.slice(0, braceStart).replace(/\\s+$/, '') +
                  '\\n\\n_Building structured response…_\\n';
              }
            }
          }
        }
        let html = renderMarkdown(display);
        if (typeof window.linkifyEntities === 'function') {
          html = window.linkifyEntities(html) || html;
        }
        streamingMarkdownEl.innerHTML = html;
      }
      schedulePostRenderWork(streamingMarkdownEl, { verify: false });
    }

    function endStreaming() {
      if (streamingBubble) streamingBubble.remove();
      streamingBubble = null;
      streamingMarkdownEl = null;
      streamingRaw = '';
      clearImmediateSubmitFeedback();
      sendBtn.style.display = 'inline-flex';
      stopBtn.style.display = 'none';
      thinkingEl.style.display = 'none';
      toolProgressListEl.innerHTML = '';
    }

    function restoreState(payload) {
      clearImmediateSubmitFeedback();
      const entries = (payload?.messages || []).map((message) => ({ 
        message,
        actions: [],
        roleMeta: message.role === 'assistant'
          ? { title: 'DreamGraph Architect', subtitle: 'Graph-grounded assistant' }
          : message.role === 'user'
            ? { title: 'You' }
            : { title: 'System' },
        contextFooter: message.role === 'assistant'
          ? 'Instance: ' + (message.instanceId || 'default') + ' • Actions require explicit click • Trace reflects real tool execution'
          : message.role === 'user'
            ? (() => {
                const anchor = message.anchor;
                if (!anchor) return 'Instance: ' + (message.instanceId || 'default');
                const status = anchor.migrationStatus || 'native';
                const label = anchor.canonicalId
                  ? ((anchor.canonicalKind || 'entity') + ':' + anchor.canonicalId)
                  : (anchor.symbolPath || anchor.label);
                const anchorText = status === 'promoted'
                  ? 'Anchor: promoted to ' + label
                  : status === 'rebound'
                    ? 'Anchor: rebound to ' + label
                    : status === 'drifted'
                      ? 'Anchor: drifted near ' + label
                      : status === 'archived'
                        ? 'Anchor: archived (' + label + ')'
                        : (anchor.canonicalId ? 'Anchor: canonical ' + label : 'Anchor: native ' + label);
                return 'Instance: ' + (message.instanceId || 'default') + ' • ' + anchorText;
              })()
            : 'Instance: ' + (message.instanceId || 'default') + ' • System message',
        uiState: {
          toolTrace: Array.isArray(message.toolTrace) ? message.toolTrace : [],
          verdict: message.verdict || null,
        },
      }));
      vscode.setState({ ...(vscode.getState() || {}), messages: entries });
      messagesEl.innerHTML = '';
      if (entries.length === 0) {
        setEmptyStateVisible(true);
        return;
      }
      setEmptyStateVisible(false);
      for (const entry of entries) {
        addMessage(entry.message, entry.actions, entry.roleMeta, entry.contextFooter, entry.uiState);
      }
    }

    promptEl.addEventListener('input', () => {
      autoresize();
      queueDraftSave();
    });
    promptEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        submitPrompt();
      }
    });
    sendBtn.addEventListener('click', submitPrompt);
    stopBtn.addEventListener('click', () => {
      clearImmediateSubmitFeedback();
      vscode.postMessage({ type: 'stop' });
    });
    clearBtn.addEventListener('click', () => {
      clearImmediateSubmitFeedback();
      vscode.postMessage({ type: 'clear' });
    });
    attachBtn.addEventListener('click', () => vscode.postMessage({ type: 'pickAttachments' }));
    const autonomyResetBtn = document.getElementById('autonomy-reset-btn');
    if (autonomyResetBtn) autonomyResetBtn.addEventListener('click', () => vscode.postMessage({ type: 'resetAutonomy' }));
    // Patch #1.5: header autonomy dropdown posts setAutonomyMode (handler exists since v1).
    const autonomyModeSelect = document.getElementById('autonomy-mode-select');
    if (autonomyModeSelect) {
      autonomyModeSelect.addEventListener('change', () => vscode.postMessage({ type: 'setAutonomyMode', mode: autonomyModeSelect.value }));
    }
    // Patch #2: install a single 1Hz ticker that renders the TimeBudget pill
    // from the latest cached params. Provider-agnostic — pure client clock.
    (function installTimeBudgetTicker() {
      const fmt = function(ms) {
        if (ms <= 0) return '0:00';
        const totalSec = Math.floor(ms / 1000);
        const m = Math.floor(totalSec / 60);
        const s = totalSec - m * 60;
        return String(m) + ':' + (s < 10 ? '0' + s : String(s));
      };
      const render = function() {
        const el = document.getElementById('time-budget');
        if (!el) return;
        const tb = window.__dgTimeBudget;
        if (!tb) {
          el.textContent = '—';
          el.classList.remove('time-budget-active', 'time-budget-low', 'time-budget-exhausted');
          el.style.opacity = '0.5';
          return;
        }
        const elapsed = Math.max(0, Date.now() - tb.startedAt);
        const remaining = Math.max(0, tb.totalMs - elapsed);
        el.textContent = fmt(remaining) + ' / ' + fmt(tb.totalMs);
        el.style.opacity = '1';
        const pctLeft = remaining / tb.totalMs;
        el.classList.toggle('time-budget-exhausted', remaining <= 0);
        el.classList.toggle('time-budget-low', remaining > 0 && pctLeft <= 0.2);
        el.classList.toggle('time-budget-active', remaining > 0);
      };
      window.__dgRenderTimeBudget = render;
      setInterval(render, 1000);
      render();
    })();
    providerSelect.addEventListener('change', () => vscode.postMessage({ type: 'changeProvider', provider: providerSelect.value }));
    modelSelect.addEventListener('change', () => vscode.postMessage({ type: 'changeModel', model: modelSelect.value }));
    setApiKeyBtn.addEventListener('click', () => vscode.postMessage({ type: 'setApiKey' }));
    document.querySelectorAll('.example-prompt-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        promptEl.value = btn.getAttribute('data-example') || '';
        autoresize();
        promptEl.focus();
      });
    });

    // Clipboard image paste — intercept paste events on the prompt area
    // and forward image data to the extension host for attachment.
    promptEl.addEventListener('paste', (event) => {
      const items = event.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith('image/')) {
          event.preventDefault();
          const blob = item.getAsFile();
          if (!blob) return;
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result;
            if (typeof dataUrl !== 'string') return;
            // dataUrl format: "data:image/png;base64,iVBOR..."
            const commaIdx = dataUrl.indexOf(',');
            if (commaIdx < 0) return;
            const dataBase64 = dataUrl.slice(commaIdx + 1);
            const mimeType = item.type || 'image/png';
            vscode.postMessage({ type: 'pasteImage', dataBase64, mimeType });
          };
          reader.readAsDataURL(blob);
          return; // handle only the first image
        }
      }
    });

    vscode.postMessage({ type: 'refreshPendingReviews' });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'pendingReviews':
          renderPendingReviews(msg.reviews, msg.collapsed);
          break;
        case 'state':
          restoreState(msg.state);
          break;
        case 'restoreDraft':
          promptEl.value = msg.text || '';
          autoresize();
          break;
        case 'stream-start':
          startStreaming();
          break;
        case 'stream-chunk':
          updateStreaming(msg.chunk || '');
          break;
        case 'stream-thinking':
          if (msg.active) clearImmediateSubmitFeedback({ keepBusy: true });
          thinkingEl.style.display = msg.active ? 'flex' : 'none';
          break;
        case 'stream-end':
          endStreaming();
          break;
        case 'tool-progress': {
          const visibleWindow = 5;
          const row = document.createElement('div');
          row.className = 'tool-row-live tool-row-enter';
          row.innerHTML = '<span class="tool-name">' + escapeHtml(msg.tool || 'tool') + '</span><span class="tool-message">' + escapeHtml(msg.message || '') + '</span>';
          // Newest on top: prepend.
          if (toolProgressListEl.firstChild) {
            toolProgressListEl.insertBefore(row, toolProgressListEl.firstChild);
          } else {
            toolProgressListEl.appendChild(row);
          }
          // Trigger enter animation on next frame.
          requestAnimationFrame(() => {
            row.classList.remove('tool-row-enter');
          });

          const liveRows = Array.from(toolProgressListEl.querySelectorAll('.tool-row-live'));
          liveRows.forEach((item, depth) => {
            if (depth >= visibleWindow) {
              // Animate out then remove.
              item.style.setProperty('--tool-progress-opacity', '0');
              item.style.setProperty('--tool-progress-scale', '0.7');
              item.style.setProperty('--tool-progress-blur', '3px');
              setTimeout(() => { item.remove(); }, 220);
              return;
            }
            const scale = Math.max(0.78, 1 - (depth * 0.07));
            const opacity = Math.max(0.25, 1 - (depth * 0.22));
            const blur = Math.min(2.0, depth * 0.45);
            item.style.setProperty('--tool-progress-scale', String(scale));
            item.style.setProperty('--tool-progress-opacity', String(opacity));
            item.style.setProperty('--tool-progress-blur', blur.toFixed(2) + 'px');
          });
          break;
        }
        case 'addMessage': {
          if (msg.message && msg.message.role === 'assistant') {
            clearImmediateSubmitFeedback();
          }
          const uiState = { toolTrace: [...lastToolTrace], verdict: lastVerdict };
          const state = vscode.getState() || {};
          const entries = [...(state.messages || []), {
            message: msg.message,
            actions: msg.actions || [],
            roleMeta: msg.roleMeta,
            contextFooter: msg.contextFooter,
            uiState: uiState,
          }];
          vscode.setState({ ...state, messages: entries });
          addMessage(msg.message, msg.actions || [], msg.roleMeta, msg.contextFooter, uiState);
          break;
        }
        case 'messageActionState': {
          actionStates.set(msg.messageId + ':' + msg.actionId, { status: msg.status, error: msg.error || '' });
          rerenderMessageActions(msg.messageId);
          break;
        }
        case 'entityStatus': {
          const container = pendingVerification.get(msg.requestId);
          if (container) {
            applyEntityVerification(container, msg.results || {});
            pendingVerification.delete(msg.requestId);
          }
          break;
        }
        case 'toolTrace':
          lastToolTrace = Array.isArray(msg.calls) ? msg.calls : [];
          break;
        case 'verdict':
          lastVerdict = msg.verdict || null;
          break;
        case 'updateModels': {
          providerSelect.innerHTML = '';
          for (const p of msg.providers || []) {
            const opt = document.createElement('option');
            opt.value = p;
            opt.textContent = p;
            if (p === msg.current?.provider) opt.selected = true;
            providerSelect.appendChild(opt);
          }
          modelSelect.innerHTML = '';
          for (const m of msg.models || []) {
            const opt = document.createElement('option');
            opt.value = m;
            opt.textContent = m;
            if (m === msg.current?.model) opt.selected = true;
            modelSelect.appendChild(opt);
          }
          const customOpt = document.createElement('option');
          customOpt.value = '__custom__';
          customOpt.textContent = '+ Custom model…';
          modelSelect.appendChild(customOpt);
          break;
        }
        case 'setAttachments': {
          attachmentsEl.innerHTML = '';
          for (const attachment of msg.attachments || []) {
            const chip = document.createElement('div');
            chip.className = 'attachment-chip';
            chip.innerHTML = '<span class="chip-icon">' + (attachment.kind === 'image' ? '🖼️' : '📄') + '</span><span>' + escapeHtml(attachment.name) + '</span>';
            const remove = document.createElement('button');
            remove.className = 'attachment-remove';
            remove.textContent = '×';
            remove.addEventListener('click', () => vscode.postMessage({ type: 'removeAttachment', id: attachment.id }));
            chip.appendChild(remove);
            attachmentsEl.appendChild(chip);
          }
          break;
        }
        case 'error':
          clearImmediateSubmitFeedback();
          console.error(msg.error);
          break;
        case 'autonomyStatus': {
          const bar = document.getElementById('autonomy-bar');
          const label = document.getElementById('autonomy-mode-label');
          const counter = document.getElementById('autonomy-counter');
          const resetBtn = document.getElementById('autonomy-reset-btn');
          // Patch #1.5: header dropdown + pass-budget pill mirror state.
          const modeSelect = document.getElementById('autonomy-mode-select');
          const passBudget = document.getElementById('pass-budget');
          const timeBudgetEl = document.getElementById('time-budget');
          if (bar && label && counter && resetBtn) {
            const s = msg.status;
            bar.style.display = 'flex';
            label.textContent = s.mode.charAt(0).toUpperCase() + s.mode.slice(1);
            label.className = 'autonomy-mode autonomy-mode-' + s.mode;
            counter.textContent = s.countingActive ? s.summary : '';
            resetBtn.style.display = s.mode !== 'cautious' || s.countingActive ? 'inline-flex' : 'none';
            if (modeSelect && modeSelect.value !== s.mode) modeSelect.value = s.mode;
            if (passBudget) {
              // ADR-153: PassBudget is required and must be visible. We render
              // remaining/total whenever a budget exists, even when not actively
              // counting, so the user always knows the cap.
              const total = (typeof s.totalAuthorized === 'number' && s.totalAuthorized > 0)
                ? s.totalAuthorized : null;
              if (total !== null) {
                const remaining = typeof s.remaining === 'number' ? s.remaining : total;
                passBudget.textContent = String(remaining) + ' / ' + String(total);
                passBudget.classList.toggle('pass-budget-active', !!s.countingActive);
                passBudget.classList.toggle('pass-budget-low', remaining <= Math.max(1, Math.floor(total * 0.2)));
              } else {
                passBudget.textContent = '— / —';
                passBudget.classList.remove('pass-budget-active', 'pass-budget-low');
              }
            }
            // Patch #2: cache TimeBudget params + render via shared 1Hz ticker
            // (initialized once at startup). When no time budget is active we
            // null the cache so the ticker shows the placeholder dash.
            if (timeBudgetEl) {
              const totalMs = typeof s.timeBudgetTotalMs === 'number' && s.timeBudgetTotalMs > 0 ? s.timeBudgetTotalMs : 0;
              const startedAt = typeof s.timeBudgetStartedAtEpochMs === 'number' ? s.timeBudgetStartedAtEpochMs : 0;
              window.__dgTimeBudget = (totalMs > 0 && startedAt > 0) ? { totalMs: totalMs, startedAt: startedAt } : null;
              if (typeof window.__dgRenderTimeBudget === 'function') window.__dgRenderTimeBudget();
            }
          }
          break;
        }
        case 'budgetStatus': {
          // Phase 5 — opt-in debug pill. The host only posts this message
          // when dreamgraph.architect.budgetPillEnabled === true, so we
          // simply render whatever arrives.
          const pill = document.getElementById('budget-pill');
          const pressureEl = document.getElementById('budget-pill-pressure');
          const tokensEl = document.getElementById('budget-pill-tokens');
          const debtEl = document.getElementById('budget-pill-debt');
          const componentsEl = document.getElementById('budget-pill-components');
          if (pill && pressureEl && tokensEl && debtEl && componentsEl) {
            const s = msg.status;
            pill.style.display = 'flex';
            pressureEl.textContent = s.pressureLabel;
            pressureEl.className = 'budget-pill-pressure budget-pill-pressure-' + s.pressureLabel;
            tokensEl.textContent = s.lastActualTokens + '/' + s.expectedTokens + ' tok';
            debtEl.textContent = (s.debtTokens >= 0 ? 'debt ' : 'credit ') + Math.abs(s.debtTokens);
            const parts = Object.entries(s.components || {})
              .sort(function(a, b) { return Number(b[1]) - Number(a[1]); })
              .slice(0, 4)
              .map(function(entry) { return entry[0] + '=' + entry[1]; });
            componentsEl.textContent = parts.length > 0 ? '· ' + parts.join(' ') : '';
            pill.title = 'turn ' + s.turn + ' · model ' + s.modelId + ' · delta ' + s.delta;
          }
          break;
        }
        case 'recommendedActions': {
          const targetBubble = messagesEl.querySelector('.message[data-message-id="' + msg.messageId + '"]');
          if (targetBubble) {
            const existing = targetBubble.querySelector('.recommended-actions');
            if (existing) existing.remove();
            const wrapper = document.createElement('div');
            wrapper.className = 'recommended-actions';
            for (const action of msg.actions || []) {
              const chip = document.createElement('button');
              chip.className = 'action-chip';
              chip.textContent = action.label;
              if (action.rationale) chip.title = action.rationale;
              chip.addEventListener('click', () => vscode.postMessage({ type: 'selectRecommendedAction', actionId: action.id }));
              wrapper.appendChild(chip);
            }
            if (msg.doAllEligible && (msg.actions || []).length > 1) {
              const doAll = document.createElement('button');
              doAll.className = 'action-chip action-chip-all';
              doAll.textContent = 'Do all';
              doAll.addEventListener('click', () => vscode.postMessage({ type: 'doAllRecommendedActions' }));
              wrapper.appendChild(doAll);
            }
            targetBubble.appendChild(wrapper);
            const actionReserve = Math.max(72, (pendingReviewsEl ? pendingReviewsEl.offsetHeight : 0) + 16);
            messagesEl.style.paddingBottom = actionReserve + 'px';
            messagesEl.style.scrollPaddingBottom = actionReserve + 'px';
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }
          break;
        }
        case 'summaryCard': {
          // Render the SUMMARY pill card (goal/progress/uncertainty pills +
          // Suggested-Actions chips + Do all) underneath the assistant bubble.
          // Built by the host on every turn from the structured envelope or
          // a prose-derived fallback, so this fires regardless of whether
          // the model emitted a JSON envelope.
          const targetBubble = messagesEl.querySelector('.message[data-message-id="' + msg.messageId + '"]');
          if (!targetBubble || typeof window.renderEnvelope !== 'function') break;
          // Replace any prior card for this message — turns can be regenerated.
          const existing = targetBubble.querySelector('.dg-envelope-card-host');
          if (existing) existing.remove();
          const env = msg.envelope || {};
          const steps = Array.isArray(env.recommended_next_steps) ? env.recommended_next_steps : [];
          const host = document.createElement('div');
          host.className = 'dg-envelope-card-host';
          host.innerHTML = window.renderEnvelope({
            summary: env.summary || '',
            goal_status: env.goal_status,
            progress_status: env.progress_status,
            uncertainty: env.uncertainty,
            recommended_next_steps: steps,
          });
          // Renderer now emits data-action-id/label directly per surviving
          // chip and skips dead "Step N" entries, so an index walk over the
          // raw steps[] array would mis-align after any drops. Only the
          // Do-all whole-list label set is patched here.
          const labels = steps.map((s) => (s && typeof s.label === 'string' ? s.label : '')).filter(Boolean);
          const doAllBtn = host.querySelector('.dg-envelope-do-all');
          if (doAllBtn) {
            if (env.doAllEligible && labels.length > 1) {
              doAllBtn.setAttribute('data-action-labels', JSON.stringify(labels));
            } else {
              doAllBtn.remove();
            }
          }
          // Wire chip clicks (same protocol as the inline envelope card).
          host.querySelectorAll('.dg-envelope-action:not([data-wired])').forEach((btn) => {
            btn.setAttribute('data-wired', '1');
            btn.addEventListener('click', () => {
              const actionId = btn.getAttribute('data-action-id') || '';
              const label = btn.getAttribute('data-action-label') || '';
              if (actionId || label) {
                vscode.postMessage({ type: 'selectRecommendedAction', actionId, label });
              }
            });
          });
          host.querySelectorAll('.dg-envelope-do-all:not([data-wired])').forEach((btn) => {
            btn.setAttribute('data-wired', '1');
            btn.addEventListener('click', () => {
              let labelsOut = [];
              try {
                const parsed = JSON.parse(btn.getAttribute('data-action-labels') || '[]');
                if (Array.isArray(parsed)) labelsOut = parsed.map((l) => String(l || '')).filter(Boolean);
              } catch (_e) { /* ignore */ }
              vscode.postMessage({ type: 'doAllRecommendedActions', labels: labelsOut });
            });
          });
          targetBubble.appendChild(host);
          const summaryReserve = Math.max(72, (pendingReviewsEl ? pendingReviewsEl.offsetHeight : 0) + 16);
          messagesEl.style.paddingBottom = summaryReserve + 'px';
          messagesEl.style.scrollPaddingBottom = summaryReserve + 'px';
          messagesEl.scrollTop = messagesEl.scrollHeight;
          break;
        }
      }
    });

    autoresize();
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
