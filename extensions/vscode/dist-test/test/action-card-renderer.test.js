"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const node_vm_1 = __importDefault(require("node:vm"));
const card_renderer_js_1 = require("../webview/card-renderer.js");
function renderEnvelope(envelope) {
    const context = { window: {} };
    node_vm_1.default.runInNewContext((0, card_renderer_js_1.getCardRendererScript)(), context);
    const fn = context.window.renderEnvelope;
    if (typeof fn !== 'function')
        throw new Error('renderEnvelope was not installed');
    return fn(envelope);
}
(0, node_test_1.default)('summary renderer disables privileged actions and suppresses mixed Do all', () => {
    const html = renderEnvelope({
        summary: 'Release is live.',
        recommended_next_steps: [
            { id: 'record', label: 'Record v10.6.0 release in DreamGraph knowledge graph' },
            { id: 'publish', label: 'Publish VSIX to VS Code Marketplace' },
        ],
    });
    strict_1.default.match(html, /data-blocked="true"/);
    strict_1.default.match(html, /Requires MCP graph-write tool enrich_seed_data/);
    strict_1.default.match(html, /Requires VSCE_PAT/);
    strict_1.default.doesNotMatch(html, />Do all</);
});
(0, node_test_1.default)('summary renderer trusts host capability checks', () => {
    const html = renderEnvelope({
        summary: 'Safe follow-ups.',
        doAllEligible: true,
        recommended_next_steps: [
            { id: 'a', label: 'Run focused tests', capabilityChecked: true },
            { id: 'b', label: 'Open release notes', capabilityChecked: true },
        ],
    });
    strict_1.default.doesNotMatch(html, /data-blocked="true"/);
    strict_1.default.match(html, />Do all</);
});
//# sourceMappingURL=action-card-renderer.test.js.map