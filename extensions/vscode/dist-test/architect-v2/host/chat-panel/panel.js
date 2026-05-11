"use strict";
// architect-v2/host/chat-panel/panel.ts
// M7 — v2 Architect ChatPanel (parity rewrite, zero v1 reuse).
//
// STRICT ISOLATION (ADR-140 + ADR-171):
//   - No imports from v1 surfaces.
//   - The webview NEVER receives provider output. It receives only:
//       * pre-rendered markdown produced by `renderPass({cards, trailingNote})`
//       * high-level state transitions (idle / running / waiting / error)
//       * tool-trace projections derived from PassResult.outcomes
//   - host/ is a wiring layer (per ADR-171 carve-out) and may import
//     `vscode`. Cognition surfaces stay behind the orchestrator port.
//
// User-facing concepts preserved (NOT v1 implementation):
//   * conversation thread (user echo + assistant rendered cards)
//   * autonomy mode picker
//   * pass-budget readout
//   * tool-trace strip
//   * provider/api-key surface
//   * reset / cancel controls
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ArchitectV2Panel = void 0;
const vscode = __importStar(require("vscode"));
const index_js_1 = require("../../autonomy/index.js");
const index_js_2 = require("../../cards/index.js");
const index_js_3 = require("../../providers/index.js");
const index_js_4 = require("../index.js");
const vscode_memento_store_js_1 = require("../vscode-memento-store.js");
const vscode_fallback_signal_provider_js_1 = require("../vscode-fallback-signal-provider.js");
const mcp_client_bridge_js_1 = require("../mcp-client-bridge.js");
const webview_js_1 = require("./webview.js");
const PREFS_KEY = "architectV2.prefs";
const TRANSCRIPT_KEY = "architectV2.transcript";
const SECRETS_KEY_PREFIX = "architectV2.apiKey.";
const DEFAULT_MODE = "conscientious";
const DEFAULT_PROVIDER = "anthropic";
const TASK_ID = "architect-v2-chat-task";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatActivityLabel(reason, toolName) {
    const verb = reason === "verification"
        ? "Verifying"
        : reason === "enrichment"
            ? "Enriching"
            : "Running";
    return `${verb} ${toolName}`;
}
function isAutonomyMode(value) {
    return (value === "cautious" ||
        value === "conscientious" ||
        value === "eager" ||
        value === "autonomous");
}
function deriveBudgetView(state, mode) {
    if (state) {
        return {
            remaining: state.passBudget.remaining,
            total: state.passBudget.total,
        };
    }
    const profile = (0, index_js_1.getModeProfile)(mode);
    return { remaining: profile.defaultPassBudget, total: profile.defaultPassBudget };
}
function projectTrace(outcomes) {
    return outcomes.map((o) => ({
        tool: o.tool,
        succeeded: o.kind === "success",
        summary: o.kind === "success"
            ? `${o.tool} succeeded (${o.artifacts.length} artifact(s)).`
            : o.kind === "failure"
                ? `${o.tool} failed: ${o.failureReason}`
                : `${o.tool} partial: blocked by ${o.blockedBy}`,
        atEpochMs: o.executedAtEpochMs,
    }));
}
function describeError(err) {
    if (err instanceof Error)
        return err.message;
    try {
        return String(err);
    }
    catch {
        return "Unknown error.";
    }
}
class ArchitectV2Panel {
    static viewType = "dreamgraph.architectV2View";
    context;
    mcpClient;
    view = null;
    host = null;
    hostBuildKey = null;
    taskState = null;
    mode = DEFAULT_MODE;
    providerId = DEFAULT_PROVIDER;
    /** Model id per provider. Falls back to provider default when missing. */
    modelByProvider = {};
    isRunning = false;
    cancelled = false;
    /** Live tool ticker: the currently-running capability (pulse) and recent ones (fading). */
    activityCurrent = null;
    activityRecent = [];
    transcript = [];
    static ACTIVITY_RECENT_LIMIT = 5;
    static TRANSCRIPT_LIMIT = 200;
    constructor(options) {
        this.context = options.context;
        this.mcpClient = options.mcpClient;
        const prefs = this.readPrefs();
        if (prefs.mode && isAutonomyMode(prefs.mode))
            this.mode = prefs.mode;
        if (prefs.providerId && (0, index_js_3.hasProvider)(prefs.providerId)) {
            this.providerId = prefs.providerId;
        }
        if (prefs.modelByProvider) {
            this.modelByProvider = { ...prefs.modelByProvider };
        }
        this.transcript = this.readTranscript();
    }
    // -------------------------------------------------------------------------
    // WebviewViewProvider
    // -------------------------------------------------------------------------
    async resolveWebviewView(webviewView) {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, "dist"),
                vscode.Uri.joinPath(this.context.extensionUri, "media"),
            ],
        };
        // Mirror v1's order: register the message handler BEFORE assigning
        // html so the webview's first 'ready' postMessage cannot race the
        // listener registration. v1 (chat-panel.ts) survives the race
        // through happenstance; v2 had occasional empty-dropdown reports
        // because its ready→postInit chain is the ONLY init path.
        webviewView.webview.onDidReceiveMessage((msg) => void this.handleMessage(msg));
        // Seed providers + models directly into the initial HTML so the
        // dropdowns are populated on first paint regardless of whether the
        // ready/postMessage round-trip lands. This is the v1 parity move:
        // v1's getHtml() bakes provider/model <option> tags into the HTML
        // string itself, then `updateModels` only refreshes them. v2 was
        // postMessage-only, which is why "empty dropdowns" kept reproducing.
        const seedProviders = (0, index_js_3.listProviders)().map((p) => ({
            id: p.id,
            displayName: p.displayName,
        }));
        const seedModels = await this.collectModelsForCurrentProvider();
        webviewView.webview.html = (0, webview_js_1.renderHtml)({
            webview: webviewView.webview,
            extensionUri: this.context.extensionUri,
            providers: seedProviders,
            models: seedModels,
            providerId: this.providerId,
            modelId: this.currentModelId(),
            mode: this.mode,
        });
        // Rehydrate when the view becomes visible again (mirrors v1's
        // onDidChangeVisibility → rehydrateWebview). Without this, returning
        // to the panel after switching away leaves dropdowns blank because
        // the webview is recreated but never re-receives 'init'.
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible)
                void this.postInit();
        });
        webviewView.onDidDispose(() => {
            this.view = null;
        });
        // Belt-and-braces: push init immediately as well as on 'ready'.
        // VS Code queues postMessage calls until the webview attaches its
        // listener, so this is safe and guarantees the dropdowns get
        // populated even if the 'ready' round-trip is dropped.
        void this.postInit();
    }
    dispose() {
        this.view = null;
    }
    // -------------------------------------------------------------------------
    // Message handling
    // -------------------------------------------------------------------------
    async handleMessage(msg) {
        switch (msg.kind) {
            case "ready":
                await this.postInit();
                return;
            case "submit":
                await this.runSubmission(msg.text);
                return;
            case "cancel":
                // The orchestrator is a single awaited promise per pass; we
                // can't kill mid-flight, but flagging cancellation lets us
                // discard the result and reset UI state when it returns.
                this.cancelled = true;
                return;
            case "reset":
                this.taskState = null;
                this.cancelled = false;
                this.isRunning = false;
                await this.clearTranscript();
                await this.post({ kind: "cleared" });
                await this.postAutonomy();
                await this.post({ kind: "status", status: "idle" });
                return;
            case "open-settings":
                // Always prompts for the CURRENT provider only — the provider
                // is selected via the dropdown, not via this button.
                await this.promptForApiKey({ force: true });
                return;
            case "set-autonomy-mode":
                if (isAutonomyMode(msg.mode)) {
                    this.mode = msg.mode;
                    await this.savePrefs();
                    // Reset task so next submission picks up the new budget.
                    this.taskState = null;
                    await this.postAutonomy();
                }
                return;
            case "set-provider":
                await this.handleSetProvider(msg.providerId);
                return;
            case "set-model":
                await this.handleSetModel(msg.modelId);
                return;
            case "diagnostic":
                // Renderer reports unclassifiable / failing output. Surface in
                // the extension log so it can be picked up by telemetry / dream
                // cycles. Closes the visible \u21d2 typed \u21d2 recordable loop.
                console.warn(`[architect-v2] webview diagnostic scope=${msg.scope}: ${msg.sample}`);
                return;
            default: {
                const _exhaustive = msg;
                void _exhaustive;
                return;
            }
        }
    }
    async runSubmission(text) {
        const trimmed = text.trim();
        if (trimmed.length === 0)
            return;
        if (this.isRunning) {
            await this.post({
                kind: "error",
                message: "A pass is already in flight; cancel or wait for it to finish.",
            });
            return;
        }
        await this.recordTranscriptEntry({
            kind: "user-echo",
            text: trimmed,
            atEpochMs: Date.now(),
        });
        await this.post({ kind: "user-echo", text: trimmed });
        // Resolve API key + lazy-build host.
        const apiKey = await this.readApiKey();
        if (!apiKey || apiKey.length === 0) {
            await this.post({
                kind: "error",
                message: "No API key configured for provider '" +
                    this.providerId +
                    "'. Use the Settings button (key icon) to set one.",
            });
            await this.post({ kind: "status", status: "error" });
            return;
        }
        let host;
        try {
            host = await this.ensureHost(apiKey);
        }
        catch (err) {
            // Typed provider-config errors get surfaced as structured panel
            // errors so the user immediately knows the model id is bad and
            // gets a list of valid alternatives.
            if (err instanceof index_js_3.UnknownModelError) {
                await this.post({
                    kind: "error",
                    message: `Provider '${err.providerId}' does not advertise model '${err.modelId}'. ` +
                        `Pick one of: ${err.availableModelIds.join(", ") || "(none)"}.`,
                });
                // Auto-fall back to the provider default so the panel keeps
                // working; broadcast settings so the dropdown reflects it.
                delete this.modelByProvider[this.providerId];
                await this.savePrefs();
                await this.broadcastSettings();
                await this.post({ kind: "status", status: "error" });
                return;
            }
            await this.post({
                kind: "error",
                message: "Failed to initialize architect host: " + describeError(err),
            });
            await this.post({ kind: "status", status: "error" });
            return;
        }
        if (!this.taskState) {
            this.taskState = this.buildInitialTaskState(trimmed);
        }
        const userIntent = { text: trimmed };
        this.isRunning = true;
        this.cancelled = false;
        await this.post({ kind: "status", status: "running" });
        try {
            // Multi-pass continuation loop. The orchestrator returns a
            // `continuation` directive when more work is required to satisfy
            // the user intent (read tool → synthesize, etc.). We keep running
            // passes until the orchestrator stops requesting continuation,
            // the pass budget is exhausted, the user cancels, or the mode
            // forbids autonomous follow-ups (cautious requires confirmation
            // between every pass).
            let result = await host.runPass({
                taskState: this.taskState,
                userIntent,
            });
            while (true) {
                if (this.cancelled) {
                    // Discard the result and reset UI; do NOT advance taskState.
                    this.cancelled = false;
                    this.isRunning = false;
                    await this.post({
                        kind: "error",
                        message: "Pass cancelled by user; result discarded.",
                    });
                    await this.post({ kind: "status", status: "idle" });
                    return;
                }
                this.taskState = result.newTaskState;
                const markdown = (0, index_js_2.renderPass)({
                    cards: result.cards,
                    trailingNote: result.trailingNote,
                });
                const chunks = [];
                for (const card of result.cards) {
                    chunks.push({ kind: card.kind, markdown: (0, index_js_2.renderCard)(card) });
                }
                const noteMd = (0, index_js_2.renderTrailingNote)(result.trailingNote);
                if (noteMd.length > 0) {
                    chunks.push({ kind: "note", markdown: noteMd });
                }
                const passIndex = result.newTaskState.passes.length - 1;
                await this.recordTranscriptEntry({
                    kind: "pass-rendered",
                    markdown,
                    passIndex,
                    chunks,
                    atEpochMs: Date.now(),
                });
                await this.post({
                    kind: "pass-rendered",
                    markdown,
                    passIndex,
                    chunks,
                });
                await this.post({
                    kind: "trace",
                    entries: projectTrace(result.outcomes),
                });
                await this.postAutonomy();
                const wantsContinuation = result.newTaskState.status === "running" &&
                    !!result.continuation &&
                    result.newTaskState.passBudget.remaining > 0 &&
                    this.mode !== "cautious" &&
                    !this.cancelled;
                if (!wantsContinuation) {
                    break;
                }
                // Stream activity reset between passes so the ticker rebuilds.
                this.activityCurrent = null;
                this.activityRecent.length = 0;
                await this.post({ kind: "activity", current: null, recent: [] });
                await this.post({ kind: "status", status: "running" });
                result = await host.runPass({
                    taskState: this.taskState,
                    userIntent,
                });
            }
            const nextStatus = result.newTaskState.status === "running"
                ? "idle"
                : result.newTaskState.status === "paused_for_user"
                    ? "waiting-for-user"
                    : "idle";
            await this.post({
                kind: "status",
                status: nextStatus,
                detail: result.deltaSummary,
            });
        }
        catch (err) {
            await this.post({
                kind: "error",
                message: "Pass failed: " + describeError(err),
            });
            await this.post({ kind: "status", status: "error" });
        }
        finally {
            this.isRunning = false;
            // Clear the live ticker once the pass settles, regardless of
            // outcome; the next submission rebuilds it from scratch.
            this.activityCurrent = null;
            this.activityRecent.length = 0;
            await this.post({ kind: "activity", current: null, recent: [] });
        }
    }
    // -------------------------------------------------------------------------
    // Outbound messages
    // -------------------------------------------------------------------------
    async post(msg) {
        if (!this.view)
            return;
        try {
            await this.view.webview.postMessage(msg);
        }
        catch {
            // Webview disposed mid-post; ignore.
        }
    }
    async postInit() {
        const providers = (0, index_js_3.listProviders)().map((p) => ({
            id: p.id,
            displayName: p.displayName,
        }));
        const models = await this.collectModelsForCurrentProvider();
        console.log(`[architect-v2] postInit providers=${providers.length} models=${models.length} provider=${this.providerId}`);
        await this.post({
            kind: "init",
            state: {
                providerId: this.providerId,
                modelId: this.currentModelId(),
                hasApiKey: (await this.readApiKey()).length > 0,
                mode: this.mode,
                passBudget: deriveBudgetView(this.taskState, this.mode),
                providers,
                models,
                transcript: [...this.transcript],
            },
        });
    }
    async postAutonomy() {
        await this.post({
            kind: "autonomy",
            mode: this.mode,
            passBudget: deriveBudgetView(this.taskState, this.mode),
        });
    }
    // -------------------------------------------------------------------------
    // Host wiring (lazy)
    // -------------------------------------------------------------------------
    async ensureHost(apiKey) {
        const modelId = this.currentModelId();
        // Include MCP connection state in the build key so the host gets
        // rebuilt the moment the daemon comes online. Without this, an
        // early ensureHost() called before the daemon connected would cache
        // a host with an empty tool catalog forever, leaving the LLM with
        // "no tool inventory was exposed to me" for the rest of the session.
        const mcpReady = this.mcpClient?.isConnected === true ? "1" : "0";
        const buildKey = `${this.providerId}:${modelId}:${apiKey.length}:${apiKey.slice(-4)}:mcp${mcpReady}`;
        if (this.host && this.hostBuildKey === buildKey)
            return this.host;
        const workspaceState = new vscode_memento_store_js_1.VSCodeMementoStore(this.context.workspaceState);
        const fallback = new vscode_fallback_signal_provider_js_1.VSCodeFallbackSignalProvider();
        const mcpClient = this.mcpClient
            ? new mcp_client_bridge_js_1.V1McpClientBridge(this.mcpClient)
            : undefined;
        console.log(`[architect-v2] ensureHost provider=${this.providerId} model=${modelId} mcpReady=${mcpReady}`);
        this.host = await (0, index_js_4.createArchitectHost)({
            providerId: this.providerId,
            modelIdOverride: modelId,
            providerConfig: { apiKey },
            workspaceState,
            fallback,
            mcpClient,
            onExecutorEvent: (event) => this.handleExecutorEvent(event),
        });
        this.hostBuildKey = buildKey;
        return this.host;
    }
    // -------------------------------------------------------------------------
    // Live activity ticker
    // -------------------------------------------------------------------------
    /**
     * Translate raw executor events into the panel's ticker model and
     * post the new state to the webview. Provider-neutral: the host wrap
     * emits these events identically for every provider (ADR-179).
     */
    handleExecutorEvent(event) {
        const toolName = event.toolName ?? event.capabilityId;
        if (event.phase === "start") {
            if (this.activityCurrent) {
                this.activityRecent.unshift(this.activityCurrent);
                if (this.activityRecent.length > ArchitectV2Panel.ACTIVITY_RECENT_LIMIT) {
                    this.activityRecent.length = ArchitectV2Panel.ACTIVITY_RECENT_LIMIT;
                }
            }
            this.activityCurrent = {
                capabilityId: event.capabilityId,
                toolName,
                label: formatActivityLabel(event.invocationReasonKind, toolName),
                atEpochMs: event.atEpochMs,
            };
        }
        else {
            // 'end' — only retire the current item if it matches; out-of-order
            // ends (e.g. concurrent verification) just get appended to recent.
            if (this.activityCurrent &&
                this.activityCurrent.capabilityId === event.capabilityId) {
                this.activityRecent.unshift(this.activityCurrent);
                if (this.activityRecent.length > ArchitectV2Panel.ACTIVITY_RECENT_LIMIT) {
                    this.activityRecent.length = ArchitectV2Panel.ACTIVITY_RECENT_LIMIT;
                }
                this.activityCurrent = null;
            }
        }
        void this.post({
            kind: "activity",
            current: this.activityCurrent,
            recent: [...this.activityRecent],
        });
    }
    buildInitialTaskState(goal) {
        const profile = (0, index_js_1.getModeProfile)(this.mode);
        const now = Date.now();
        return {
            id: TASK_ID,
            goal,
            mode: this.mode,
            profile,
            passBudget: (0, index_js_1.createPassBudget)(profile.defaultPassBudget),
            timeBudget: (0, index_js_1.createTimeBudget)(profile.defaultTimeBudgetMs, now),
            passes: [],
            blockers: [],
            status: "running",
        };
    }
    // -------------------------------------------------------------------------
    // Prefs + secrets
    // -------------------------------------------------------------------------
    readPrefs() {
        return (this.context.workspaceState.get(PREFS_KEY) ?? {});
    }
    async savePrefs() {
        const prefs = {
            mode: this.mode,
            providerId: this.providerId,
            modelByProvider: { ...this.modelByProvider },
        };
        await this.context.workspaceState.update(PREFS_KEY, prefs);
    }
    readTranscript() {
        const raw = this.context.workspaceState.get(TRANSCRIPT_KEY, []);
        return raw.filter((entry) => {
            if (!entry || typeof entry !== "object")
                return false;
            if (entry.kind === "user-echo")
                return typeof entry.text === "string";
            return (entry.kind === "pass-rendered" &&
                typeof entry.markdown === "string" &&
                typeof entry.passIndex === "number" &&
                Array.isArray(entry.chunks));
        });
    }
    async recordTranscriptEntry(entry) {
        this.transcript.push(entry);
        if (this.transcript.length > ArchitectV2Panel.TRANSCRIPT_LIMIT) {
            this.transcript.splice(0, this.transcript.length - ArchitectV2Panel.TRANSCRIPT_LIMIT);
        }
        await this.context.workspaceState.update(TRANSCRIPT_KEY, [...this.transcript]);
    }
    async clearTranscript() {
        this.transcript.length = 0;
        await this.context.workspaceState.update(TRANSCRIPT_KEY, []);
    }
    secretKey(providerId = this.providerId) {
        return SECRETS_KEY_PREFIX + providerId;
    }
    async readApiKey(providerId = this.providerId) {
        return (await this.context.secrets.get(this.secretKey(providerId))) ?? "";
    }
    /**
     * Prompts the user for an API key for the CURRENT provider. Provider
     * is selected via the dropdown (`set-provider`), not here — this
     * dialog never asks the user to pick a provider. When `force` is
     * false the dialog is a no-op when a key is already stored, so a
     * provider switch can call this for first-time setup without
     * re-prompting on every selection.
     */
    async promptForApiKey(opts) {
        if (!opts.force) {
            const existing = await this.readApiKey();
            if (existing.length > 0) {
                await this.broadcastSettings();
                return;
            }
        }
        const value = await vscode.window.showInputBox({
            title: `Architect v2: API key for ${this.providerId}`,
            prompt: "Stored in VS Code SecretStorage; never written to settings.json. Leave blank to clear.",
            password: true,
            ignoreFocusOut: true,
        });
        if (value === undefined) {
            await this.broadcastSettings();
            return;
        }
        if (value.length === 0) {
            await this.context.secrets.delete(this.secretKey());
        }
        else {
            await this.context.secrets.store(this.secretKey(), value);
        }
        this.host = null;
        this.hostBuildKey = null;
        await this.broadcastSettings();
    }
    // -------------------------------------------------------------------------
    // Provider / model selection
    // -------------------------------------------------------------------------
    currentModelId() {
        const stored = this.modelByProvider[this.providerId];
        if (stored && stored.length > 0)
            return stored;
        return (0, index_js_3.getProvider)(this.providerId).defaultModelId;
    }
    async collectModelsForCurrentProvider() {
        try {
            const provider = (0, index_js_3.getProvider)(this.providerId);
            const models = await provider.listModels();
            return models.map((m) => ({ id: m.id, displayName: m.displayName }));
        }
        catch {
            return [];
        }
    }
    async broadcastSettings() {
        const models = await this.collectModelsForCurrentProvider();
        await this.post({
            kind: "settings",
            hasApiKey: (await this.readApiKey()).length > 0,
            providerId: this.providerId,
            modelId: this.currentModelId(),
            models,
        });
    }
    async handleSetProvider(providerId) {
        if (!(0, index_js_3.hasProvider)(providerId))
            return;
        if (providerId === this.providerId) {
            await this.broadcastSettings();
            return;
        }
        this.providerId = providerId;
        await this.savePrefs();
        // Drop any task that was scoped to the old provider.
        this.taskState = null;
        this.host = null;
        this.hostBuildKey = null;
        // Per spec: when switching provider, only prompt for a key if
        // none is stored yet for the newly-selected provider. Otherwise
        // the user changes the key explicitly via the key icon.
        const existing = await this.readApiKey();
        if (existing.length === 0) {
            // First-time prompt for this provider. Non-blocking from the
            // webview's perspective — the dialog is fire-and-forget.
            void this.promptForApiKey({ force: true });
        }
        else {
            await this.broadcastSettings();
        }
    }
    async handleSetModel(modelId) {
        const ids = await (0, index_js_3.listModelIds)(this.providerId);
        if (!ids.includes(modelId)) {
            await this.post({
                kind: "error",
                message: `Model '${modelId}' is not advertised by provider '${this.providerId}'.`,
            });
            await this.broadcastSettings();
            return;
        }
        this.modelByProvider = { ...this.modelByProvider, [this.providerId]: modelId };
        await this.savePrefs();
        this.host = null;
        this.hostBuildKey = null;
        await this.broadcastSettings();
    }
}
exports.ArchitectV2Panel = ArchitectV2Panel;
//# sourceMappingURL=panel.js.map