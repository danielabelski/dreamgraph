"use strict";
/**
 * DreamGraph Dashboard View — Dockable WebviewView provider.
 *
 * Embeds the daemon's web dashboard (served at /status) inside a VS Code
 * sidebar panel via an iframe. Refreshes on visibility change and when
 * the daemon connection changes.
 */
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
exports.DashboardViewProvider = void 0;
const vscode = __importStar(require("vscode"));
/* ------------------------------------------------------------------ */
/*  Dashboard View Provider                                           */
/* ------------------------------------------------------------------ */
/**
 * DreamGraph Dashboard View — Dockable WebviewView provider.
 *
 * Embeds the daemon's web dashboard (served at /status) inside a VS Code
 * sidebar panel via an iframe. Refreshes on visibility change and when
 * the daemon connection changes.
 */
class DashboardViewProvider {
    _extensionUri;
    static viewType = "dreamgraph.dashboardView";
    static sidebarContainerId = "dreamgraph-sidebar";
    _view = null;
    _disposables = [];
    /** Daemon URL discovered at runtime by the instance resolver / connect command. */
    _daemonUrl = null;
    constructor(_extensionUri) {
        this._extensionUri = _extensionUri;
    }
    /**
     * Update the daemon URL used by the dashboard iframe.
     * Called by connectToInstance when the real port is discovered.
     */
    updateDaemonUrl(host, port) {
        if (!this._isValidPort(port)) {
            this._daemonUrl = null;
            this.refresh();
            return;
        }
        this._daemonUrl = `http://${host}:${port}/status`;
        this.refresh();
    }
    _isValidPort(port) {
        return Number.isInteger(port) && port !== null && port !== undefined && port > 0 && port <= 65535;
    }
    get isVisible() {
        return this._view?.visible ?? false;
    }
    /* ---- WebviewViewProvider ---- */
    resolveWebviewView(webviewView, _context, _token) {
        this._view = webviewView;
        const daemonUrl = this._getDaemonUrl();
        webviewView.webview.options = {
            enableScripts: true,
        };
        webviewView.webview.html = this._getHtml(daemonUrl);
        // Refresh iframe when view becomes visible
        this._disposables.push(webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                const url = this._getDaemonUrl();
                webviewView.webview.html = this._getHtml(url);
            }
        }));
        webviewView.onDidDispose(() => {
            this._view = null;
        }, null, this._disposables);
    }
    /**
     * Force-refresh the dashboard content.
     */
    refresh() {
        if (this._view) {
            const url = this._getDaemonUrl();
            this._view.webview.html = this._getHtml(url);
        }
    }
    /**
     * Focus the dashboard view in the sidebar.
     * Also ensures the DreamGraph activity-bar container becomes visible.
     */
    async open() {
        await this.ensureContainerVisible();
        await vscode.commands.executeCommand("dreamgraph.dashboardView.focus");
    }
    /**
     * Best-effort repair for the DreamGraph activity bar icon/container.
     * If the custom container has been hidden or moved, reveal it again.
     */
    async ensureContainerVisible() {
        try {
            await vscode.commands.executeCommand(`${DashboardViewProvider.sidebarContainerId}.focus`);
            return;
        }
        catch {
            // Fall through to repair commands below.
        }
        try {
            await vscode.commands.executeCommand("workbench.view.extension.dreamgraph-sidebar");
            return;
        }
        catch {
            // Continue to broader repair attempts.
        }
        try {
            await vscode.commands.executeCommand("workbench.action.resetViewLocations");
        }
        catch {
            // Ignore and continue to the direct focus fallback.
        }
        try {
            await vscode.commands.executeCommand(`${DashboardViewProvider.sidebarContainerId}.focus`);
        }
        catch {
            // Last resort below.
        }
        try {
            await vscode.commands.executeCommand("dreamgraph.dashboardView.focus");
        }
        catch {
            // Give up silently; caller can still surface UX elsewhere.
        }
    }
    /* ---- Helpers ---- */
    _getDaemonUrl() {
        // Prefer the runtime-discovered URL (set by connectToInstance)
        if (this._daemonUrl)
            return this._daemonUrl;
        // Fallback to settings (used before first connect)
        const config = vscode.workspace.getConfiguration("dreamgraph");
        const host = config.get("daemonHost") ?? "127.0.0.1";
        const configuredPort = config.get("daemonPort");
        const port = this._isValidPort(configuredPort) ? configuredPort : 8100;
        return `http://${host}:${port}/status`;
    }
    _getHtml(daemonUrl) {
        const nonce = getNonce();
        const origin = (() => {
            try {
                return new URL(daemonUrl).origin;
            }
            catch {
                return "http://127.0.0.1:8100";
            }
        })();
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; frame-src ${origin}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    * { margin: 0; padding: 0; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: var(--vscode-editor-background); }
    iframe { width: 100%; height: 100%; border: none; }
    .offline {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      height: 100%; color: var(--vscode-descriptionForeground); font-family: var(--vscode-font-family);
      gap: 12px; padding: 24px; text-align: center;
    }
    .offline button {
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      border: none; border-radius: 4px; padding: 6px 16px; cursor: pointer;
      font-family: inherit; font-size: 13px;
    }
    .offline button:hover { background: var(--vscode-button-hoverBackground); }
  </style>
</head>
<body>
  <iframe id="dash" src="${daemonUrl}"></iframe>
  <div class="offline" id="offline" style="display:none">
    <span style="font-size:32px">🧠</span>
    <div>DreamGraph daemon is not reachable.</div>
    <div style="font-size:12px">Resolved daemon URL: <code>${daemonUrl}</code></div>
    <button onclick="location.reload()">Retry</button>
  </div>
  <script nonce="${nonce}">
    const iframe = document.getElementById("dash");
    const offline = document.getElementById("offline");
    let loaded = false;
    const showOffline = () => {
      if (loaded) return;
      iframe.style.display = "none";
      offline.style.display = "flex";
    };
    iframe.addEventListener("error", showOffline);
    const timeout = setTimeout(showOffline, 10000);
    iframe.addEventListener("load", () => {
      loaded = true;
      clearTimeout(timeout);
    });
  </script>
</body>
</html>`;
    }
    /* ---- Dispose ---- */
    dispose() {
        for (const d of this._disposables)
            d.dispose();
        this._disposables = [];
    }
}
exports.DashboardViewProvider = DashboardViewProvider;
/* ------------------------------------------------------------------ */
/*  Utility                                                           */
/* ------------------------------------------------------------------ */
function getNonce() {
    let text = "";
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
}
//# sourceMappingURL=dashboard-view.js.map