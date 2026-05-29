/**
 * DreamGraph Dashboard View — Dockable WebviewView provider.
 *
 * Embeds the daemon's web dashboard (served at /status) inside a VS Code
 * sidebar panel via an iframe. Refreshes on visibility change and when
 * the daemon connection changes.
 */
import * as vscode from "vscode";
/**
 * DreamGraph Dashboard View — Dockable WebviewView provider.
 *
 * Embeds the daemon's web dashboard (served at /status) inside a VS Code
 * sidebar panel via an iframe. Refreshes on visibility change and when
 * the daemon connection changes.
 */
export declare class DashboardViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    private readonly _extensionUri;
    static readonly viewType = "dreamgraph.dashboardView";
    static readonly sidebarContainerId = "dreamgraph-sidebar";
    private _view;
    private _disposables;
    /** Daemon URL discovered at runtime by the instance resolver / connect command. */
    private _daemonUrl;
    constructor(_extensionUri: vscode.Uri);
    /**
     * Update the daemon URL used by the dashboard iframe.
     * Called by connectToInstance when the real port is discovered.
     */
    updateDaemonUrl(host: string, port: number): void;
    private _isValidPort;
    get isVisible(): boolean;
    resolveWebviewView(webviewView: vscode.WebviewView, _context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken): void;
    /**
     * Force-refresh the dashboard content.
     */
    refresh(): void;
    /**
     * Focus the dashboard view in the sidebar.
     * Also ensures the DreamGraph activity-bar container becomes visible.
     */
    open(): Promise<void>;
    /**
     * Best-effort repair for the DreamGraph activity bar icon/container.
     * If the custom container has been hidden or moved, reveal it again.
     */
    ensureContainerVisible(): Promise<void>;
    private _getDaemonUrl;
    private _getHtml;
    dispose(): void;
}
//# sourceMappingURL=dashboard-view.d.ts.map