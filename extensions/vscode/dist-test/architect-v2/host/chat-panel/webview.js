"use strict";
// architect-v2/host/chat-panel/webview.ts
// M7 — HTML scaffold for the v2 Architect ChatPanel.
//
// STRICT ISOLATION: nothing here imports v1. The webview script is
// inlined as a string with a per-resolve nonce; markdown-it and
// DOMPurify are loaded via webview URIs from `dist/vendor/` (shipped by
// the build:vendor step). Provider output never crosses this seam —
// the inline script only consumes the typed message protocol from
// `messages.ts`.
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
exports.renderHtml = renderHtml;
const vscode = __importStar(require("vscode"));
function escAttr(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function renderOptions(items, selectedId) {
    if (items.length === 0)
        return "";
    return items
        .map((it) => {
        const sel = it.id === selectedId ? " selected" : "";
        return `<option value="${escAttr(it.id)}"${sel}>${escAttr(it.displayName || it.id)}</option>`;
    })
        .join("");
}
function renderHtml(input) {
    const { webview, extensionUri } = input;
    const providerOpts = renderOptions(input.providers ?? [], input.providerId);
    const modelOpts = renderOptions(input.models ?? [], input.modelId);
    const modeSel = input.mode ?? "conscientious";
    const nonce = makeNonce();
    const mdUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "vendor", "markdown-it.min.js"));
    const dpUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "vendor", "purify.min.js"));
    const csp = `default-src 'none'; ` +
        `img-src ${webview.cspSource} https: data:; ` +
        `style-src 'unsafe-inline' ${webview.cspSource}; ` +
        `script-src 'nonce-${nonce}' ${webview.cspSource};`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Architect v2</title>
  <style>${STYLES}</style>
</head>
<body>
  <header class="bar">
    <span class="brand">Architect v2</span>
    <select id="provider" class="picker" title="LLM provider">${providerOpts}</select>
    <select id="model" class="picker" title="Model">${modelOpts}</select>
    <select id="mode" class="picker" title="Autonomy mode">
      <option value="cautious"${modeSel === "cautious" ? " selected" : ""}>cautious</option>
      <option value="conscientious"${modeSel === "conscientious" ? " selected" : ""}>conscientious</option>
      <option value="eager"${modeSel === "eager" ? " selected" : ""}>eager</option>
      <option value="autonomous"${modeSel === "autonomous" ? " selected" : ""}>autonomous</option>
    </select>
    <span id="budget" class="budget" title="Pass budget">— / —</span>
    <span class="grow"></span>
    <button id="key" class="iconbtn" title="API key">🔑</button>
    <button id="reset" class="iconbtn" title="Clear conversation">🗑</button>
  </header>

  <div id="status-bar" class="status idle">
    <span id="status-dot" class="dot"></span>
    <span id="status-text">idle</span>
    <span id="status-detail"></span>
  </div>

  <div id="activity" class="activity empty" aria-live="polite" aria-label="Tool activity">
    <div id="activity-current" class="activity-current"></div>
    <ol id="activity-recent" class="activity-recent"></ol>
  </div>

  <main id="thread" aria-live="polite"></main>

  <section id="trace" class="trace empty" aria-label="Tool trace">
    <header class="trace-head">
      <span>Tool trace</span>
      <button id="trace-toggle" class="textbtn">hide</button>
    </header>
    <ol id="trace-list"></ol>
  </section>

  <footer class="composer">
    <textarea id="input" rows="2" placeholder="Ask the v2 Architect…"></textarea>
    <div class="composer-actions">
      <button id="send" class="primary">Send</button>
      <button id="cancel" class="danger" hidden>Cancel</button>
    </div>
  </footer>

  <script nonce="${nonce}" src="${mdUri.toString()}"></script>
  <script nonce="${nonce}" src="${dpUri.toString()}"></script>
  <script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}
function makeNonce() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
// ---------------------------------------------------------------------------
// Inline styles
// ---------------------------------------------------------------------------
const STYLES = `
:root {
  --bg: var(--vscode-sideBar-background, #1e1e1e);
  --fg: var(--vscode-foreground, #d4d4d4);
  --muted: var(--vscode-descriptionForeground, #888);
  --border: var(--vscode-panel-border, #333);
  --accent: var(--vscode-button-background, #0e639c);
  --accent-fg: var(--vscode-button-foreground, #fff);
  --danger: var(--vscode-errorForeground, #f48771);
  --warn: var(--vscode-editorWarning-foreground, #cca700);
  --ok: var(--vscode-charts-green, #5a8e5a);
  --user-bg: var(--vscode-textBlockQuote-background, #2a2d2e);
  --code-bg: var(--vscode-textCodeBlock-background, #2a2a2a);
  --font: var(--vscode-font-family, sans-serif);
  --mono: var(--vscode-editor-font-family, monospace);
}
* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0;
  height: 100%;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font);
  font-size: 13px;
}
body {
  display: flex;
  flex-direction: column;
  height: 100vh;
}
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
}
.bar .brand { font-weight: 600; }
.bar .grow { flex: 1; }
.bar select {
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  padding: 2px 4px;
  font-size: 12px;
}
.bar select.picker {
  min-width: 110px;
  max-width: 160px;
  text-overflow: ellipsis;
}
.budget {
  font-family: var(--mono);
  color: var(--muted);
  font-size: 11px;
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: 3px;
}
.iconbtn, .textbtn, .primary, .danger {
  background: transparent;
  color: var(--fg);
  border: 1px solid var(--border);
  padding: 2px 8px;
  cursor: pointer;
  font-size: 12px;
  border-radius: 3px;
}
.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
.danger { color: var(--danger); border-color: var(--danger); }
.iconbtn { padding: 2px 6px; }
.textbtn { border: none; color: var(--muted); }
button:hover { filter: brightness(1.1); }
.status {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font-size: 11px;
  border-bottom: 1px solid var(--border);
  color: var(--muted);
}
.status .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.status.running .dot { background: var(--accent); animation: pulse 1.2s infinite; }
.status.error .dot { background: var(--danger); }
.status.error { color: var(--danger); }
.status.waiting-for-user .dot { background: var(--warn); }
.status.waiting-for-user { color: var(--warn); }
.status.idle .dot { background: var(--ok); }
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
#status-detail { margin-left: 8px; opacity: 0.8; }
main#thread {
  flex: 1;
  overflow-y: auto;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.empty-state {
  margin: auto;
  max-width: 520px;
  width: 100%;
  border: 1px dashed var(--border);
  border-radius: 6px;
  padding: 18px;
  color: var(--muted);
  text-align: center;
}
.empty-state h2 {
  margin: 0 0 6px;
  color: var(--fg);
  font-size: 16px;
}
.empty-state p { margin: 0 0 14px; }
.empty-actions {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(145px, 1fr));
  gap: 8px;
}
.empty-action {
  background: transparent;
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 8px 10px;
  cursor: pointer;
  text-align: left;
}
.empty-action strong { display: block; margin-bottom: 2px; }
.empty-action span { display: block; color: var(--muted); font-size: 11px; }
.empty-action:hover { border-color: var(--accent); }
.bubble {
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 8px 10px;
}
.bubble.user {
  background: var(--user-bg);
  align-self: flex-end;
  max-width: 90%;
  white-space: pre-wrap;
}
.bubble.assistant {
  align-self: stretch;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: transparent;
  border: none;
  padding: 0;
}
.card {
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 8px 10px;
  background: var(--bg);
}
.card.kind-blocker { border-left: 3px solid var(--danger); }
.card.kind-fallback { border-left: 3px solid var(--warn); }
.card.kind-completion { border-left: 3px solid var(--ok); }
.card.kind-nextstep { border-left: 3px solid var(--accent); }
.card.kind-decision { border-left: 3px solid var(--accent); }
.card.kind-verification { border-left: 3px solid var(--ok); }
.card.kind-note { border-left: 3px solid var(--muted); background: var(--user-bg); }
.card.kind-system-error { border-left: 3px solid var(--danger); }
.card.kind-unknown { border-left: 3px solid var(--warn); background: var(--code-bg); }
.card-diagnostic-banner {
  font-size: 10px;
  color: var(--warn);
  font-family: var(--mono);
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.card-pills { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0 6px; }
.pill {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  font-family: var(--mono);
  padding: 1px 6px;
  border-radius: 10px;
  background: var(--code-bg);
  border: 1px solid var(--border);
  color: var(--muted);
  text-transform: lowercase;
}
.pill .pill-k { opacity: 0.7; }
.pill .pill-v { color: var(--fg); font-weight: 500; }
.pill.pill-graph-rich   { border-color: var(--ok); color: var(--ok); }
.pill.pill-graph-absent { border-color: var(--danger); color: var(--danger); }
.pill.pill-graph-sparse { border-color: var(--warn); color: var(--warn); }
.pill.pill-status-stopped { border-color: var(--danger); color: var(--danger); }
.pill.pill-status-paused_for_user { border-color: var(--warn); color: var(--warn); }
.pill.pill-certainty-high { border-color: var(--ok); color: var(--ok); }
.pill.pill-certainty-low  { border-color: var(--warn); color: var(--warn); }
.card-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.action-btn {
  background: var(--accent);
  color: var(--accent-fg);
  border: 1px solid var(--accent);
  border-radius: 3px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
  font-family: var(--font);
}
.action-btn:hover { filter: brightness(1.15); }
.action-btn.secondary {
  background: transparent;
  color: var(--fg);
  border-color: var(--border);
}
.card table { border-collapse: collapse; margin: 4px 0; font-size: 12px; }
.card th, .card td {
  border: 1px solid var(--border);
  padding: 2px 6px;
  text-align: left;
  vertical-align: top;
}
.card th { background: var(--code-bg); }
.bubble.assistant h3 {
  font-size: 12px;
  margin: 8px 0 4px;
  color: var(--muted);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.bubble.assistant code {
  font-family: var(--mono);
  background: var(--code-bg);
  padding: 1px 4px;
  border-radius: 2px;
  font-size: 12px;
}
.bubble.assistant pre {
  background: var(--code-bg);
  padding: 8px;
  border-radius: 4px;
  overflow-x: auto;
  font-family: var(--mono);
  font-size: 12px;
}
.bubble.assistant blockquote {
  border-left: 3px solid var(--border);
  margin: 6px 0;
  padding: 2px 0 2px 8px;
  color: var(--muted);
}
.bubble.assistant hr {
  border: none;
  border-top: 1px solid var(--border);
  margin: 12px 0;
}
.bubble.assistant ul, .bubble.assistant ol { padding-left: 20px; margin: 4px 0; }
.bubble.error {
  border-color: var(--danger);
  color: var(--danger);
  background: transparent;
}
.bubble.system-note {
  font-size: 11px;
  color: var(--muted);
  border-style: dashed;
}
.pass-meta {
  font-size: 10px;
  color: var(--muted);
  margin-bottom: 4px;
  font-family: var(--mono);
}
section.trace {
  border-top: 1px solid var(--border);
  font-size: 11px;
  max-height: 30vh;
  overflow-y: auto;
}
section.trace.empty { display: none; }
section.trace.collapsed ol { display: none; }
.trace-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 10px;
  color: var(--muted);
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: 0.06em;
}
section.trace ol {
  margin: 0;
  padding: 0 10px 6px 30px;
}
section.trace li {
  padding: 2px 0;
  font-family: var(--mono);
}
section.trace li.fail { color: var(--danger); }
section.trace li.ok { color: var(--ok); }
.composer {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-top: 1px solid var(--border);
  padding: 8px 10px;
}
.composer textarea {
  width: 100%;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  font-family: var(--font);
  font-size: 13px;
  padding: 6px 8px;
  resize: vertical;
  min-height: 38px;
}
.composer textarea:focus { outline: 1px solid var(--accent); border-color: var(--accent); }
.composer-actions { display: flex; gap: 6px; justify-content: flex-end; }

/* Live tool ticker (ADR-179: provider-neutral seam) */
.activity { padding: 6px 12px 4px; min-height: 0; }
.activity.empty { display: none; }
.activity-current {
  font-size: 12px;
  font-weight: 500;
  color: var(--accent, var(--vscode-textLink-foreground));
  animation: dg-pulse 1.4s ease-in-out infinite;
  margin-bottom: 2px;
}
.activity-current:empty { display: none; }
.activity-recent { list-style: none; padding: 0; margin: 0; }
.activity-recent li {
  font-size: 11px;
  color: var(--muted, var(--vscode-descriptionForeground));
  line-height: 1.3;
  transform-origin: left center;
}
.activity-recent li.r0 { opacity: 0.7; }
.activity-recent li.r1 { opacity: 0.55; transform: scale(0.97); }
.activity-recent li.r2 { opacity: 0.4;  transform: scale(0.94); }
.activity-recent li.r3 { opacity: 0.28; transform: scale(0.91); }
.activity-recent li.r4 { opacity: 0.18; transform: scale(0.88); }
@keyframes dg-pulse {
  0%, 100% { opacity: 1;   transform: scale(1); }
  50%      { opacity: 0.55; transform: scale(0.985); }
}
`;
// ---------------------------------------------------------------------------
// Inline webview script. Pure DOM + message protocol; no network calls;
// no provider concepts. Uses markdown-it + DOMPurify globals loaded via
// the two preceding <script src=…> tags.
// ---------------------------------------------------------------------------
// IMPORTANT: SCRIPT is a String.raw template so JS escape sequences
// (e.g. \n inside string and regex literals) survive verbatim into the
// inlined webview script. A regular backtick template would interpret
// \n as a newline, mangling string and regex literals at host-eval time
// and producing "Uncaught SyntaxError: Invalid or unexpected token".
const SCRIPT = String.raw `
(function () {
  function __dgFatal(stage, err) {
    try {
      var pre = document.createElement('pre');
      pre.style.cssText = 'color:#f88;background:#300;padding:8px;white-space:pre-wrap;font:11px monospace;border:1px solid #f44;margin:8px;';
      pre.textContent = '[v2 webview crash @ ' + stage + '] ' + (err && (err.stack || err.message) || String(err));
      (document.body || document.documentElement).appendChild(pre);
    } catch (_) {}
  }
  window.addEventListener('error', function (e) { __dgFatal('window.error', e.error || e.message); });
  try {
  const vscode = acquireVsCodeApi();
  const md = (typeof window.markdownit === 'function')
    ? window.markdownit({ html: false, linkify: true, breaks: false })
    : null;
  const sanitize = (typeof window.DOMPurify !== 'undefined' && typeof window.DOMPurify.sanitize === 'function')
    ? (s) => window.DOMPurify.sanitize(s)
    : (s) => s;

  const $ = (id) => document.getElementById(id);
  const thread = $('thread');
  const traceSection = $('trace');
  const traceList = $('trace-list');
  const traceToggle = $('trace-toggle');
  const statusBar = $('status-bar');
  const statusText = $('status-text');
  const statusDetail = $('status-detail');
  const activitySection = $('activity');
  const activityCurrentEl = $('activity-current');
  const activityRecentEl = $('activity-recent');
  const budgetEl = $('budget');
  const modeSelect = $('mode');
  const providerSelect = $('provider');
  const modelSelect = $('model');
  const keyBtn = $('key');
  const resetBtn = $('reset');
  const sendBtn = $('send');
  const cancelBtn = $('cancel');
  const inputEl = $('input');

  function setStatus(status, detail) {
    statusBar.classList.remove('idle', 'running', 'error', 'waiting-for-user');
    statusBar.classList.add(status);
    statusText.textContent = status.replace(/-/g, ' ');
    statusDetail.textContent = detail || '';
    if (status === 'running') {
      sendBtn.hidden = true;
      cancelBtn.hidden = false;
      inputEl.disabled = true;
    } else {
      sendBtn.hidden = false;
      cancelBtn.hidden = true;
      inputEl.disabled = false;
    }
  }

  const EMPTY_ACTIONS = [
    {
      label: 'Scan project',
      hint: 'Map structure and risks',
      text: 'Scan this project and summarize the architecture, important files, risks, and recommended next steps.',
    },
    {
      label: 'Explain current file',
      hint: 'Use editor context',
      text: 'Explain the currently active file, including its purpose, important symbols, dependencies, and likely change points.',
    },
    {
      label: 'Find next task',
      hint: 'Propose actionable work',
      text: 'Inspect available project context and propose the next highest-value task with a concise implementation plan.',
    },
  ];

  function hasThreadContent() {
    return !!thread.querySelector('.bubble, .card');
  }

  function removeEmptyState() {
    const existing = thread.querySelector('.empty-state');
    if (existing) existing.remove();
  }

  function renderEmptyStateIfNeeded() {
    if (hasThreadContent()) {
      removeEmptyState();
      return;
    }
    if (thread.querySelector('.empty-state')) return;
    const wrap = document.createElement('section');
    wrap.className = 'empty-state';
    wrap.setAttribute('aria-label', 'Architect quick actions');
    const title = document.createElement('h2');
    title.textContent = 'What should Architect do?';
    const desc = document.createElement('p');
    desc.textContent = 'Start with a provider-agnostic task. Architect will select the needed tools for the request.';
    const actions = document.createElement('div');
    actions.className = 'empty-actions';
    for (const action of EMPTY_ACTIONS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'empty-action';
      const strong = document.createElement('strong');
      strong.textContent = action.label;
      const span = document.createElement('span');
      span.textContent = action.hint;
      btn.appendChild(strong);
      btn.appendChild(span);
      btn.addEventListener('click', () => {
        vscode.postMessage({ kind: 'submit', text: action.text });
      });
      actions.appendChild(btn);
    }
    wrap.appendChild(title);
    wrap.appendChild(desc);
    wrap.appendChild(actions);
    thread.appendChild(wrap);
  }

  function replayTranscript(transcript) {
    thread.innerHTML = '';
    const entries = Array.isArray(transcript) ? transcript : [];
    for (const entry of entries) {
      if (!entry || typeof entry.kind !== 'string') continue;
      if (entry.kind === 'user-echo' && typeof entry.text === 'string') {
        appendUser(entry.text);
      } else if (entry.kind === 'pass-rendered') {
        appendAssistant(entry.markdown || '', typeof entry.passIndex === 'number' ? entry.passIndex : 0, entry.chunks);
      }
    }
    renderEmptyStateIfNeeded();
  }

  function appendBubble(kind, html) {
    removeEmptyState();
    const div = document.createElement('div');
    div.className = 'bubble ' + kind;
    div.innerHTML = html;
    thread.appendChild(div);
    thread.scrollTop = thread.scrollHeight;
    return div;
  }

  function appendUser(text) {
    removeEmptyState();
    const div = document.createElement('div');
    div.className = 'bubble user';
    div.textContent = text;
    thread.appendChild(div);
    thread.scrollTop = thread.scrollHeight;
  }

  function appendError(message) {
    removeEmptyState();
    // Errors are typed at the message-protocol layer (kind:'error') and
    // get a dedicated DOM renderer here so they participate in the same
    // visual contract as model cards (kind-blocker styling, sanitized
    // content). They never bypass into a raw bubble.
    const card = document.createElement('div');
    card.className = 'card kind-blocker kind-system-error';
    const h3 = document.createElement('h3');
    h3.textContent = 'System error';
    card.appendChild(h3);
    const body = document.createElement('div');
    body.className = 'card-body';
    const p = document.createElement('p');
    p.textContent = String(message == null ? '(no message)' : message);
    body.appendChild(p);
    card.appendChild(body);
    thread.appendChild(card);
    thread.scrollTop = thread.scrollHeight;
  }

  function appendAssistant(markdown, passIndex, chunks) {
    removeEmptyState();
    const div = document.createElement('div');
    div.className = 'bubble assistant';
    const meta = document.createElement('div');
    meta.className = 'pass-meta';
    meta.textContent = 'pass #' + (passIndex + 1);
    div.appendChild(meta);
    // PREFERRED PATH: typed chunks come pre-classified by the host
    // (visible => typed => recordable => rendered invariant). We render
    // each chunk with its declared kind, so unclassified output is
    // structurally impossible on this path.
    if (Array.isArray(chunks) && chunks.length > 0) {
      for (const c of chunks) {
        if (!c || typeof c.markdown !== 'string') continue;
        const trimmed = c.markdown.trim();
        if (!trimmed) continue;
        div.appendChild(renderCardChunk(trimmed, typeof c.kind === 'string' ? c.kind : null));
      }
    } else {
      // Legacy fallback: split concatenated markdown and infer kind.
      const splitMd = String(markdown || '').split(/\n\n---\n\n/);
      for (const chunk of splitMd) {
        const trimmed = chunk.trim();
        if (!trimmed) continue;
        div.appendChild(renderCardChunk(trimmed, null));
      }
    }
    thread.appendChild(div);
    thread.scrollTop = thread.scrollHeight;
  }

  // Closed taxonomy mirror of cards/render.ts (ADR-160). The H3 title is
  // emitted by the deterministic renderer; a prefix match yields the kind.
  // The trailing note (renderTrailingNote) opens with an italic
  // "Note from model:" — classified here as 'note' so it gets its own
  // border and no action buttons.
  const CARD_TITLE_TO_KIND = {
    'goal': 'goal',
    'plan': 'plan',
    'context': 'context',
    'decision': 'decision',
    'edit': 'edit',
    'verification': 'verification',
    'blocker': 'blocker',
    'next step': 'nextstep',
    'completion': 'completion',
    'fallback': 'fallback',
    'outcome': 'outcome',
  };
  function classifyCard(rendered) {
    const em = rendered.querySelector('em');
    if (em && /^Note from model:?$/.test((em.textContent || '').trim())) return 'note';
    const h3 = rendered.querySelector('h3');
    const h3text = (h3 ? h3.textContent || '' : '').trim().toLowerCase();
    for (const prefix of Object.keys(CARD_TITLE_TO_KIND)) {
      if (h3text.indexOf(prefix) === 0) return CARD_TITLE_TO_KIND[prefix];
    }
    return 'unknown';
  }

  // Convert the renderer's pill-line (a paragraph of inline <code>k:v</code>
  // spans) into proper chip elements. The renderer guarantees the pills
  // appear as the first <p> immediately after the H3 header.
  function chipifyPills(cardEl) {
    const h3 = cardEl.querySelector('h3');
    if (!h3) return;
    const next = h3.nextElementSibling;
    if (!next || next.tagName !== 'P') return;
    const codes = next.querySelectorAll('code');
    if (codes.length === 0) return;
    let allPills = true;
    const pills = [];
    codes.forEach((c) => {
      const txt = (c.textContent || '').trim();
      const idx = txt.indexOf(':');
      if (idx <= 0) { allPills = false; return; }
      pills.push({ k: txt.slice(0, idx), v: txt.slice(idx + 1) });
    });
    if (!allPills || pills.length === 0) return;
    // Also confirm the paragraph has only code+whitespace (no prose).
    const text = (next.textContent || '').replace(/\s+/g, '');
    const codeText = Array.from(codes).map((c) => (c.textContent || '').replace(/\s+/g, '')).join('');
    if (text !== codeText) return;
    const wrap = document.createElement('div');
    wrap.className = 'card-pills';
    for (const p of pills) {
      const span = document.createElement('span');
      span.className = 'pill pill-' + p.k + ' pill-' + p.k + '-' + p.v.replace(/[^a-z0-9_-]/gi, '');
      const k = document.createElement('span'); k.className = 'pill-k'; k.textContent = p.k;
      const v = document.createElement('span'); v.className = 'pill-v'; v.textContent = p.v;
      span.appendChild(k);
      span.appendChild(document.createTextNode(' '));
      span.appendChild(v);
      wrap.appendChild(span);
    }
    next.replaceWith(wrap);
  }

  // For a 'nextstep' card: extract the model's chosen tool/action and
  // append a real action button. Clicking sends a 'continue' submit so
  // the autonomy loop advances.
  function buttonifyNextStep(cardEl) {
    let toolName = null;
    let actionLabel = null;
    cardEl.querySelectorAll('p').forEach((p) => {
      const t = (p.textContent || '').trim();
      let m = t.match(/^Tool:\s*(.+)$/);
      if (m && !toolName) toolName = m[1].trim();
      m = t.match(/^Action:\s*(.+)$/);
      if (m && !actionLabel) actionLabel = m[1].trim();
    });
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    const cont = document.createElement('button');
    cont.className = 'action-btn';
    cont.textContent = actionLabel ? ('Continue: ' + actionLabel) : 'Continue';
    if (toolName) cont.title = 'Will run ' + toolName;
    cont.addEventListener('click', () => {
      vscode.postMessage({ kind: 'submit', text: 'continue' });
    });
    const skip = document.createElement('button');
    skip.className = 'action-btn secondary';
    skip.textContent = 'Reject';
    skip.addEventListener('click', () => {
      vscode.postMessage({ kind: 'submit', text: 'reject this next step and propose a different approach' });
    });
    actions.appendChild(cont);
    actions.appendChild(skip);
    cardEl.appendChild(actions);
  }

  // Map from the canonical Card.kind (taxonomy in cards/types.ts) to
  // the CSS suffix used on the rendered DOM card. Kept in sync with
  // CARD_TITLE_TO_KIND for the legacy text-inference path.
  const CARD_KIND_TO_CSS = {
    'goal': 'goal',
    'plan': 'plan',
    'context': 'context',
    'decision': 'decision',
    'edit': 'edit',
    'verification': 'verification',
    'blocker': 'blocker',
    'next-step': 'nextstep',
    'completion': 'completion',
    'fallback': 'fallback',
    'outcome': 'outcome',
    'note': 'note',
  };

  function renderCardChunk(markdownChunk, declaredKind) {
    const card = document.createElement('div');
    card.className = 'card';
    if (md) {
      card.innerHTML = sanitize(md.render(markdownChunk));
    } else {
      card.textContent = markdownChunk;
    }
    // Prefer the host-declared kind (typed pipeline) over text inference.
    let kind;
    if (declaredKind && Object.prototype.hasOwnProperty.call(CARD_KIND_TO_CSS, declaredKind)) {
      kind = CARD_KIND_TO_CSS[declaredKind];
    } else {
      kind = classifyCard(card);
    }
    card.classList.add('kind-' + kind);
    if (kind === 'unknown') {
      // Invariant: visible => typed => recordable => rendered. An unknown
      // chunk means an upstream renderer emitted output we cannot type.
      // Surface it as a visible diagnostic AND notify the host so it can
      // be recorded (telemetry / dream cycle). The raw chunk is shown
      // safely inside a labelled diagnostic frame, never as a bare wall.
      const banner = document.createElement('div');
      banner.className = 'card-diagnostic-banner';
      banner.textContent = 'Unclassified renderer output - reported to host';
      card.insertBefore(banner, card.firstChild);
      vscode.postMessage({
        kind: 'diagnostic',
        scope: 'render-unknown',
        sample: markdownChunk.slice(0, 500),
      });
    }
    chipifyPills(card);
    if (kind === 'nextstep') buttonifyNextStep(card);
    return card;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function renderTrace(entries) {
    traceList.innerHTML = '';
    if (!entries || entries.length === 0) {
      traceSection.classList.add('empty');
      return;
    }
    traceSection.classList.remove('empty');
    for (const e of entries) {
      const li = document.createElement('li');
      li.className = e.succeeded ? 'ok' : 'fail';
      li.textContent = (e.succeeded ? '✓ ' : '✗ ') + e.tool + ' — ' + e.summary;
      traceList.appendChild(li);
    }
  }

  function setBudget(remaining, total) {
    budgetEl.textContent = remaining + ' / ' + total;
  }

  function renderActivity(current, recent) {
    const recentArr = Array.isArray(recent) ? recent : [];
    const empty = !current && recentArr.length === 0;
    activitySection.classList.toggle('empty', empty);
    activityCurrentEl.textContent = current ? current.label : '';
    activityRecentEl.innerHTML = '';
    for (let i = 0; i < recentArr.length && i < 5; i++) {
      const li = document.createElement('li');
      li.className = 'r' + i;
      li.textContent = recentArr[i].label;
      activityRecentEl.appendChild(li);
    }
  }

  function setMode(mode) {
    if (modeSelect.value !== mode) modeSelect.value = mode;
  }

  function fillSelect(el, items, selectedId) {
    el.innerHTML = '';
    for (const item of items) {
      const opt = document.createElement('option');
      opt.value = item.id;
      opt.textContent = item.displayName || item.id;
      if (item.id === selectedId) opt.selected = true;
      el.appendChild(opt);
    }
    if (selectedId && el.value !== selectedId) el.value = selectedId;
  }

  function setProviders(providers, providerId) {
    fillSelect(providerSelect, providers, providerId);
  }

  function setModels(models, modelId) {
    if (!models || models.length === 0) {
      modelSelect.innerHTML = '<option value="">(no models)</option>';
      modelSelect.disabled = true;
      return;
    }
    modelSelect.disabled = false;
    fillSelect(modelSelect, models, modelId);
  }

  function setKeyButton(hasApiKey, providerId) {
    keyBtn.title = hasApiKey
      ? ('API key set for ' + providerId + ' — click to change')
      : ('No API key for ' + providerId + ' — click to set');
    keyBtn.textContent = hasApiKey ? '🔑' : '⚠';
  }

  // ---- inbound ----
  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg.kind !== 'string') return;
    switch (msg.kind) {
      case 'init':
        try {
          console.log('[architect-v2 webview] init', {
            providers: (msg.state.providers || []).length,
            models: (msg.state.models || []).length,
            providerId: msg.state.providerId,
            modelId: msg.state.modelId,
          });
        } catch (e) { /* noop */ }
        setMode(msg.state.mode);
        setBudget(msg.state.passBudget.remaining, msg.state.passBudget.total);
        setProviders(msg.state.providers || [], msg.state.providerId);
        setModels(msg.state.models || [], msg.state.modelId);
        setKeyButton(msg.state.hasApiKey, msg.state.providerId);
        replayTranscript(msg.state.transcript);
        setStatus('idle');
        if (!msg.state.providers || msg.state.providers.length === 0) {
          vscode.postMessage({
            kind: 'diagnostic',
            scope: 'render-empty',
            sample: 'init delivered with empty providers list',
          });
        }
        break;
      case 'status':
        setStatus(msg.status, msg.detail);
        break;
      case 'pass-rendered':
        appendAssistant(msg.markdown, msg.passIndex, msg.chunks);
        break;
      case 'user-echo':
        appendUser(msg.text);
        break;
      case 'trace':
        renderTrace(msg.entries);
        break;
      case 'autonomy':
        setMode(msg.mode);
        setBudget(msg.passBudget.remaining, msg.passBudget.total);
        break;
      case 'settings':
        setModels(msg.models || [], msg.modelId);
        setKeyButton(msg.hasApiKey, msg.providerId);
        if (providerSelect.value !== msg.providerId) providerSelect.value = msg.providerId;
        break;
      case 'cleared':
        thread.innerHTML = '';
        renderTrace([]);
        renderActivity(null, []);
        renderEmptyStateIfNeeded();
        break;
      case 'activity':
        renderActivity(msg.current, msg.recent);
        break;
      case 'error':
        appendError(msg.message);
        break;
    }
  });

  // ---- outbound ----
  function send() {
    const text = inputEl.value;
    if (!text || !text.trim()) return;
    vscode.postMessage({ kind: 'submit', text });
    inputEl.value = '';
  }
  sendBtn.addEventListener('click', send);
  inputEl.addEventListener('keydown', (e) => {
    // Enter sends; Shift+Enter inserts a newline. Ctrl/Cmd+Enter also
    // sends so muscle memory from Copilot/Cursor still works.
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      send();
    }
  });
  cancelBtn.addEventListener('click', () => {
    vscode.postMessage({ kind: 'cancel' });
  });
  resetBtn.addEventListener('click', () => {
    vscode.postMessage({ kind: 'reset' });
  });
  keyBtn.addEventListener('click', () => {
    vscode.postMessage({ kind: 'open-settings' });
  });
  modeSelect.addEventListener('change', () => {
    vscode.postMessage({ kind: 'set-autonomy-mode', mode: modeSelect.value });
  });
  providerSelect.addEventListener('change', () => {
    vscode.postMessage({ kind: 'set-provider', providerId: providerSelect.value });
  });
  modelSelect.addEventListener('change', () => {
    if (!modelSelect.value) return;
    vscode.postMessage({ kind: 'set-model', modelId: modelSelect.value });
  });
  traceToggle.addEventListener('click', () => {
    const collapsed = traceSection.classList.toggle('collapsed');
    traceToggle.textContent = collapsed ? 'show' : 'hide';
  });

  renderEmptyStateIfNeeded();
  vscode.postMessage({ kind: 'ready' });
  } catch (err) { __dgFatal('init', err); }
})();
`;
//# sourceMappingURL=webview.js.map