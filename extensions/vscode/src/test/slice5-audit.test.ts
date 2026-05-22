import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('Slice 5 audit: hover actions are wired for copy, retry, and pin', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'chat-panel.ts'), 'utf8');
  assert.match(source, /type: 'retryMessage'/);
  assert.match(source, /type: 'copyMessage'/);
  assert.match(source, /type: 'pinMessage'/);
  assert.match(source, /message-mini-btn/);
});

test('Slice 5 audit: action execution remains allowlisted and explicit-click only', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'chat-panel.ts'), 'utf8');
  assert.match(source, /ACTION_ALLOWLIST = new Set\(\['tool', 'show_full', 'copilot_login', 'codex_login'\]\)/);
  assert.match(source, /metaTag\?: 'copilot_login_required' \| 'codex_login_required'/);
  assert.match(source, /failureCode === 'COPILOT_NOT_LOGGED_IN' \|\| failureCode === 'CODEX_NOT_LOGGED_IN'/);
  assert.match(source, /terminal\.sendText\(`\$\{binaryName\} login`\)/);
  assert.match(source, /addEventListener\('click', \(\) => \{/);
  assert.doesNotMatch(source, /runMessageAction[^\n]*onload/i);
});

test('Slice 5 audit: resource guards remain in place', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'chat-panel.ts'), 'utf8');
  assert.match(source, /MAX_RENDERED_MESSAGE_CHARS = 100_000/);
  assert.match(source, /MAX_ENTITY_LINKS_PER_MESSAGE = 100/);
  assert.match(source, /MAX_VERIFICATION_BATCH_SIZE = 50/);
  assert.match(source, /VERIFICATION_TIMEOUT_MS = 5_000/);
});

test('Slice 5 audit: styles include context footer, action buttons, and implicit entity notice', () => {
  const styles = readFileSync(join(process.cwd(), 'src', 'webview', 'styles.ts'), 'utf8');
  assert.match(styles, /\.message-context-footer/);
  assert.match(styles, /\.message-actions/);
  assert.match(styles, /\.message-action-btn\.loading/);
  assert.match(styles, /\.implicit-entity-notice/);
});

test('Slice 5 audit: codex-cli is selectable and routes through native ProviderPort', () => {
  const chatPanel = readFileSync(join(process.cwd(), 'src', 'chat-panel.ts'), 'utf8');
  const architectLlm = readFileSync(join(process.cwd(), 'src', 'architect-llm.ts'), 'utf8');
  const pkg = readFileSync(join(process.cwd(), 'package.json'), 'utf8');

  assert.match(architectLlm, /export type ArchitectProvider = .*"codex-cli"/);
  assert.match(architectLlm, /export const CODEX_CLI_MODELS = \[/);
  assert.match(architectLlm, /provider !== "codex-cli"/);
  assert.match(chatPanel, /providers: \['anthropic', 'openai', 'ollama', 'lmstudio', 'copilot-cli', 'codex-cli'\]/);
  assert.match(chatPanel, /const codexCliRoute = nativeCliProvider === 'codex-cli'/);
  assert.match(chatPanel, /runPassViaCodexCli\(/);
  assert.match(chatPanel, /private _buildCodexCliProviderOptions\(\): CodexCliProviderPortOptions/);
  assert.match(chatPanel, /CODEX_AUTHORITATIVE_TOOL_CATALOG/);
  assert.match(pkg, /"codex-cli"/);
  assert.match(pkg, /"dreamgraph\.architect\.codexCli\.command"/);
});

test('Slice 6 audit: codex-cli live tool trace and final reconciliation are wired', () => {
  const chatPanel = readFileSync(join(process.cwd(), 'src', 'chat-panel.ts'), 'utf8');
  const codexProviderPort = readFileSync(join(process.cwd(), 'src', 'architect-core', 'adapters', 'codex-cli', 'provider-port.ts'), 'utf8');
  const codexPorts = readFileSync(join(process.cwd(), 'src', 'architect-core', 'adapters', 'codex-cli', 'orchestrator-ports.ts'), 'utf8');

  assert.match(codexProviderPort, /readonly auditLive\?: CodexCliMcpAuditLivePort/);
  assert.match(codexProviderPort, /readonly onToolCall\?: \(runId: string, call: RecordedMcpToolCall\) => void/);
  assert.match(codexProviderPort, /input\.abortSignal\?\.aborted === true/);
  assert.match(codexPorts, /interface CodexCliMcpAuditLivePort/);
  assert.match(chatPanel, /const auditLive = createHostAuditLive\(\{ auditDirAbsPath \}\)/);
  assert.match(chatPanel, /onToolCall: \(runId: string, call: RecordedMcpToolCall\): void => \{/);
  assert.match(chatPanel, /this\._reconcileCliAuditToolTrace\(result\.runId, result\.toolCalls\)/);
  assert.match(chatPanel, /this\._lastToolTrace\[liveIndex\] = authoritativeEntry/);
});

test('Slice 6 audit: codex-cli host timeout and forced-report evidence preserve partial progress', () => {
  const chatPanel = readFileSync(join(process.cwd(), 'src', 'chat-panel.ts'), 'utf8');
  const helpers = readFileSync(join(process.cwd(), 'src', 'chat-panel', 'helpers.ts'), 'utf8');

  assert.match(chatPanel, /provider === 'copilot-cli' \|\| provider === 'codex-cli'/);
  assert.match(chatPanel, /provider === 'copilot-cli' \? 'copilotCli\.timeoutMs' : 'codexCli\.timeoutMs'/);
  assert.match(chatPanel, /Evidence from the just-finished pass:\\n\$\{evidenceDigest\}/);
  assert.match(chatPanel, /internalPrompt: true/);
  assert.match(chatPanel, /preserveExistingToolTrace: true/);
  assert.match(chatPanel, /perTurn\.internalPrompt === true/);
  assert.match(chatPanel, /options\.preserveExistingToolTrace !== true/);
  assert.match(chatPanel, /audited tool calls prove progress\/evidence only/);
  assert.match(chatPanel, /Do not call the original prompt fulfilled unless the requested final answer\/report was actually delivered/);
  assert.match(helpers, /trace\.length > 0[\s\S]*Partial progress:/);
  assert.doesNotMatch(helpers, /trace\.length > 0 && failedCount === 0\)\)/);
});
