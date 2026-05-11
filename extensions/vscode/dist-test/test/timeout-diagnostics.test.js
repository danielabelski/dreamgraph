"use strict";
/**
 * Tests for the timeout-diagnostics logging contract.
 *
 * The previous test relied on multi-line regex matches against chat-panel.ts
 * which broke whenever method bodies were refactored. This rewrite asserts:
 *
 *   - the ContextInspector format strings (small, stable, IS the contract)
 *   - that ChatPanel still wires diagnostics through (presence-only checks)
 *
 * ContextInspector is not instantiated directly because its constructor
 * binds to the `vscode` module, which the node:test harness does not load.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const inspectorSource = node_fs_1.default.readFileSync(node_path_1.default.resolve(process.cwd(), 'src/context-inspector.ts'), 'utf8');
const chatPanelSource = node_fs_1.default.readFileSync(node_path_1.default.resolve(process.cwd(), 'src/chat-panel.ts'), 'utf8');
(0, node_test_1.default)('ContextInspector exposes a logTimeoutDiagnostics method with structured fields', () => {
    strict_1.default.match(inspectorSource, /logTimeoutDiagnostics\(event:\s*\{/);
    strict_1.default.match(inspectorSource, /Timeout diagnostics:/);
    strict_1.default.match(inspectorSource, /request mode: \$\{event\.mode\}/);
    strict_1.default.match(inspectorSource, /timeout budget: \$\{event\.timeoutMs\} ms/);
    strict_1.default.match(inspectorSource, /recovery attempted: \$\{event\.recoveryAttempted \? "yes" : "no"\}/);
    strict_1.default.match(inspectorSource, /recovered: \$\{event\.recovered \? "yes" : "no"\}/);
});
(0, node_test_1.default)('ContextInspector includes provider, model, tool count, and reduced-context flags', () => {
    strict_1.default.match(inspectorSource, /provider: \$\{event\.provider\}/);
    strict_1.default.match(inspectorSource, /model: \$\{event\.model \?\? "\(unknown\)"\}/);
    strict_1.default.match(inspectorSource, /tool count: \$\{event\.toolCount \?\? 0\}/);
    strict_1.default.match(inspectorSource, /reduced context: \$\{event\.usedReducedContext \? "yes" : "no"\}/);
    strict_1.default.match(inspectorSource, /error: \$\{event\.errorMessage\}/);
});
(0, node_test_1.default)('ChatPanel defines _logTimeoutDiagnostics and forwards to the inspector', () => {
    strict_1.default.match(chatPanelSource, /private\s+_logTimeoutDiagnostics\(/);
    strict_1.default.match(chatPanelSource, /this\.contextInspector\?\.logTimeoutDiagnostics\(event\)/);
});
(0, node_test_1.default)('ChatPanel actually invokes _logTimeoutDiagnostics from the recovery path', () => {
    const occurrences = (chatPanelSource.match(/this\._logTimeoutDiagnostics\(\{/g) ?? []).length;
    strict_1.default.ok(occurrences >= 2, `expected >=2 _logTimeoutDiagnostics call sites, found ${occurrences}`);
});
//# sourceMappingURL=timeout-diagnostics.test.js.map