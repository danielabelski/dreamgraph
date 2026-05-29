"use strict";
/**
 * Source-level contract tests for Adaptive Future Engine Slice 6.
 *
 * These stay source-based because ContextInspector binds to VS Code APIs and
 * ContextBuilder construction requires live extension services.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const typesSource = node_fs_1.default.readFileSync(node_path_1.default.resolve(process.cwd(), 'src/types.ts'), 'utf8');
const contextBuilderSource = node_fs_1.default.readFileSync(node_path_1.default.resolve(process.cwd(), 'src/context-builder.ts'), 'utf8');
const inspectorSource = node_fs_1.default.readFileSync(node_path_1.default.resolve(process.cwd(), 'src/context-inspector.ts'), 'utf8');
(0, node_test_1.default)('ReasoningPacket carries task preamble and adaptive future diagnostics', () => {
    strict_1.default.match(typesSource, /taskPreamble\?:\s*TaskPreambleCompilerDiagnostic/);
    strict_1.default.match(typesSource, /adaptiveFutureJudgment\?:\s*AdaptiveFutureJudgmentDiagnostic/);
    strict_1.default.match(typesSource, /omit_not_economical/);
    strict_1.default.match(typesSource, /validation_failed/);
});
(0, node_test_1.default)('ContextBuilder compiles bounded task preamble metadata into rendered context', () => {
    strict_1.default.match(contextBuilderSource, /const\s+taskPreambleCandidates\s*=\s*included\.filter/);
    strict_1.default.match(contextBuilderSource, /maxPreambleTokens\s*=\s*Math\.min\(300/);
    strict_1.default.match(contextBuilderSource, /## Task Preamble Compiler/);
    strict_1.default.match(contextBuilderSource, /## Adaptive Future Judgment/);
    strict_1.default.match(contextBuilderSource, /bounded evidence exceeded task preamble budget/);
});
(0, node_test_1.default)('ContextInspector exposes compact compiler and judgment diagnostics', () => {
    strict_1.default.match(inspectorSource, /Task Preamble Compiler:/);
    strict_1.default.match(inspectorSource, /Adaptive Future Judgment:/);
    strict_1.default.match(inspectorSource, /omitted-context reasons:/);
    strict_1.default.match(inspectorSource, /future objections:/);
    strict_1.default.match(inspectorSource, /selected model layer:/);
});
//# sourceMappingURL=adaptive-future-inspector.test.js.map