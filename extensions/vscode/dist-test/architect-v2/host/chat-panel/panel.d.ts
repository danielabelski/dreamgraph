import * as vscode from "vscode";
import { type V1McpClientLike } from "../mcp-client-bridge.js";
export interface ArchitectV2PanelOptions {
    readonly context: vscode.ExtensionContext;
    /**
     * Optional MCP client (v1-shaped) the panel will hand to
     * createArchitectHost. When omitted, the orchestrator runs in
     * sparse-mode and the DreamGraph adapters are Null.
     */
    readonly mcpClient?: V1McpClientLike;
}
export declare class ArchitectV2Panel implements vscode.WebviewViewProvider, vscode.Disposable {
    static readonly viewType = "dreamgraph.architectV2View";
    private readonly context;
    private readonly mcpClient;
    private view;
    private host;
    private hostBuildKey;
    private taskState;
    private mode;
    private providerId;
    /** Model id per provider. Falls back to provider default when missing. */
    private modelByProvider;
    private isRunning;
    private cancelled;
    /** Live tool ticker: the currently-running capability (pulse) and recent ones (fading). */
    private activityCurrent;
    private readonly activityRecent;
    private transcript;
    private static readonly ACTIVITY_RECENT_LIMIT;
    private static readonly TRANSCRIPT_LIMIT;
    constructor(options: ArchitectV2PanelOptions);
    resolveWebviewView(webviewView: vscode.WebviewView): Promise<void>;
    dispose(): void;
    private handleMessage;
    private runSubmission;
    private post;
    private postInit;
    private postAutonomy;
    private ensureHost;
    /**
     * Translate raw executor events into the panel's ticker model and
     * post the new state to the webview. Provider-neutral: the host wrap
     * emits these events identically for every provider (ADR-179).
     */
    private handleExecutorEvent;
    private buildInitialTaskState;
    private readPrefs;
    private savePrefs;
    private readTranscript;
    private recordTranscriptEntry;
    private clearTranscript;
    private secretKey;
    private readApiKey;
    /**
     * Prompts the user for an API key for the CURRENT provider. Provider
     * is selected via the dropdown (`set-provider`), not here — this
     * dialog never asks the user to pick a provider. When `force` is
     * false the dialog is a no-op when a key is already stored, so a
     * provider switch can call this for first-time setup without
     * re-prompting on every selection.
     */
    private promptForApiKey;
    private currentModelId;
    private collectModelsForCurrentProvider;
    private broadcastSettings;
    private handleSetProvider;
    private handleSetModel;
}
//# sourceMappingURL=panel.d.ts.map