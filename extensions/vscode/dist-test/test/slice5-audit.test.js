"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
(0, node_test_1.default)('Slice 5 audit: hover actions are wired for copy, retry, and pin', () => {
    const source = (0, node_fs_1.readFileSync)((0, node_path_1.join)(process.cwd(), 'src', 'chat-panel.ts'), 'utf8');
    strict_1.default.match(source, /type: 'retryMessage'/);
    strict_1.default.match(source, /type: 'copyMessage'/);
    strict_1.default.match(source, /type: 'pinMessage'/);
    strict_1.default.match(source, /message-mini-btn/);
});
(0, node_test_1.default)('Slice 5 audit: action execution remains allowlisted and explicit-click only', () => {
    const source = (0, node_fs_1.readFileSync)((0, node_path_1.join)(process.cwd(), 'src', 'chat-panel.ts'), 'utf8');
    strict_1.default.match(source, /ACTION_ALLOWLIST = new Set\(\['tool', 'show_full', 'copilot_login', 'codex_login'\]\)/);
    strict_1.default.match(source, /metaTag\?: 'copilot_login_required' \| 'codex_login_required'/);
    strict_1.default.match(source, /failureCode === 'COPILOT_NOT_LOGGED_IN' \|\| failureCode === 'CODEX_NOT_LOGGED_IN'/);
    strict_1.default.match(source, /terminal\.sendText\(`\$\{binaryName\} login`\)/);
    strict_1.default.match(source, /addEventListener\('click', \(\) => \{/);
    strict_1.default.doesNotMatch(source, /runMessageAction[^\n]*onload/i);
});
(0, node_test_1.default)('Slice 5 audit: resource guards remain in place', () => {
    const source = (0, node_fs_1.readFileSync)((0, node_path_1.join)(process.cwd(), 'src', 'chat-panel.ts'), 'utf8');
    strict_1.default.match(source, /MAX_RENDERED_MESSAGE_CHARS = 100_000/);
    strict_1.default.match(source, /MAX_ENTITY_LINKS_PER_MESSAGE = 100/);
    strict_1.default.match(source, /MAX_VERIFICATION_BATCH_SIZE = 50/);
    strict_1.default.match(source, /VERIFICATION_TIMEOUT_MS = 5_000/);
});
(0, node_test_1.default)('Slice 5 audit: styles include context footer, action buttons, and implicit entity notice', () => {
    const styles = (0, node_fs_1.readFileSync)((0, node_path_1.join)(process.cwd(), 'src', 'webview', 'styles.ts'), 'utf8');
    strict_1.default.match(styles, /\.message-context-footer/);
    strict_1.default.match(styles, /\.message-actions/);
    strict_1.default.match(styles, /\.message-action-btn\.loading/);
    strict_1.default.match(styles, /\.implicit-entity-notice/);
});
(0, node_test_1.default)('Slice 5 audit: codex-cli is selectable and routes through native ProviderPort', () => {
    const chatPanel = (0, node_fs_1.readFileSync)((0, node_path_1.join)(process.cwd(), 'src', 'chat-panel.ts'), 'utf8');
    const architectLlm = (0, node_fs_1.readFileSync)((0, node_path_1.join)(process.cwd(), 'src', 'architect-llm.ts'), 'utf8');
    const pkg = (0, node_fs_1.readFileSync)((0, node_path_1.join)(process.cwd(), 'package.json'), 'utf8');
    strict_1.default.match(architectLlm, /export type ArchitectProvider = .*"codex-cli"/);
    strict_1.default.match(architectLlm, /export const CODEX_CLI_MODELS = \[/);
    strict_1.default.match(architectLlm, /provider !== "codex-cli"/);
    strict_1.default.match(chatPanel, /providers: \['anthropic', 'openai', 'ollama', 'lmstudio', 'copilot-cli', 'codex-cli'\]/);
    strict_1.default.match(chatPanel, /const codexCliRoute = nativeCliProvider === 'codex-cli'/);
    strict_1.default.match(chatPanel, /runPassViaCodexCli\(/);
    strict_1.default.match(chatPanel, /private _buildCodexCliProviderOptions\(\): CodexCliProviderPortOptions/);
    strict_1.default.match(chatPanel, /CODEX_AUTHORITATIVE_TOOL_CATALOG/);
    strict_1.default.match(pkg, /"codex-cli"/);
    strict_1.default.match(pkg, /"dreamgraph\.architect\.codexCli\.command"/);
});
(0, node_test_1.default)('Slice 6 audit: codex-cli live tool trace and final reconciliation are wired', () => {
    const chatPanel = (0, node_fs_1.readFileSync)((0, node_path_1.join)(process.cwd(), 'src', 'chat-panel.ts'), 'utf8');
    const codexProviderPort = (0, node_fs_1.readFileSync)((0, node_path_1.join)(process.cwd(), 'src', 'architect-core', 'adapters', 'codex-cli', 'provider-port.ts'), 'utf8');
    const codexPorts = (0, node_fs_1.readFileSync)((0, node_path_1.join)(process.cwd(), 'src', 'architect-core', 'adapters', 'codex-cli', 'orchestrator-ports.ts'), 'utf8');
    strict_1.default.match(codexProviderPort, /readonly auditLive\?: CodexCliMcpAuditLivePort/);
    strict_1.default.match(codexProviderPort, /readonly onToolCall\?: \(runId: string, call: RecordedMcpToolCall\) => void/);
    strict_1.default.match(codexProviderPort, /input\.abortSignal\?\.aborted === true/);
    strict_1.default.match(codexPorts, /interface CodexCliMcpAuditLivePort/);
    strict_1.default.match(chatPanel, /const auditLive = createHostAuditLive\(\{ auditDirAbsPath \}\)/);
    strict_1.default.match(chatPanel, /onToolCall: \(runId: string, call: RecordedMcpToolCall\): void => \{/);
    strict_1.default.match(chatPanel, /this\._reconcileCliAuditToolTrace\(result\.runId, result\.toolCalls\)/);
    strict_1.default.match(chatPanel, /this\._lastToolTrace\[liveIndex\] = authoritativeEntry/);
});
//# sourceMappingURL=slice5-audit.test.js.map