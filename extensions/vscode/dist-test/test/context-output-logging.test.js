"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const chatPanelSource = node_fs_1.default.readFileSync(node_path_1.default.resolve(process.cwd(), 'src/chat-panel.ts'), 'utf8');
const extensionSource = node_fs_1.default.readFileSync(node_path_1.default.resolve(process.cwd(), 'src/extension.ts'), 'utf8');
(0, node_test_1.default)('ChatPanel context logging uses the injected shared ContextInspector', () => {
    strict_1.default.match(chatPanelSource, /private\s+contextInspector\?:\s+import\('\.\/context-inspector\.js'\)\.ContextInspector;/);
    strict_1.default.match(chatPanelSource, /public\s+setContextInspector\(inspector:\s+import\('\.\/context-inspector\.js'\)\.ContextInspector\):\s+void\s*\{\s*this\.contextInspector\s*=\s*inspector;\s*\}/);
    strict_1.default.match(chatPanelSource, /private\s+async\s+_logContextToOutput\([\s\S]*?if\s*\(!envelope\s*\|\|\s*!this\.contextInspector\)\s*return;[\s\S]*?this\.contextInspector\.logContextRequestBoundary\(\{[\s\S]*?\}\);[\s\S]*?this\.contextInspector\.logEnvelope\(envelope\);[\s\S]*?if\s*\(packet\)\s*\{[\s\S]*?this\.contextInspector\.logReasoningPacket\(packet\);[\s\S]*?\}[\s\S]*?\}/);
    strict_1.default.doesNotMatch(chatPanelSource, /new\s+ContextInspector\s*\(/);
    strict_1.default.doesNotMatch(chatPanelSource, /await\s+import\('\.\/context-inspector\.js'\)/);
});
(0, node_test_1.default)('extension activate wires the shared ContextInspector into ChatPanel', () => {
    strict_1.default.match(extensionSource, /const\s+contextInspector\s*=\s+new\s+ContextInspector\(\);/);
    strict_1.default.match(extensionSource, /chatPanel\.setContextInspector\(contextInspector\);/);
});
//# sourceMappingURL=context-output-logging.test.js.map