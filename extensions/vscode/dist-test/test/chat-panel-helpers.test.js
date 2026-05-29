"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const helpers_js_1 = require("../chat-panel/helpers.js");
function completedTrace(count) {
    return Array.from({ length: count }, (_, index) => ({
        tool: 'dreamgraph:query_resource',
        argsSummary: `uri ${index}`,
        filesAffected: [],
        durationMs: 5,
        status: 'completed',
    }));
}
(0, node_test_1.default)('deriveVerdict treats completed tool calls without delivered answer as partial progress', () => {
    const verdict = (0, helpers_js_1.deriveVerdict)('Pass aborted: [CANCELLED] Codex CLI run was cancelled by the host', completedTrace(40));
    strict_1.default.equal(verdict.level, 'partial');
    strict_1.default.match(verdict.summary, /Partial progress: 40 executed tool calls/);
    strict_1.default.doesNotMatch(verdict.summary, /Verified with/);
});
(0, node_test_1.default)('deriveVerdict keeps completed audited work partial when report says requested assessment remains incomplete', () => {
    const verdict = (0, helpers_js_1.deriveVerdict)('This run did not complete an adapter assessment. The assessment remains incomplete.', completedTrace(40));
    strict_1.default.equal(verdict.level, 'partial');
    strict_1.default.match(verdict.summary, /final completion was not established/);
});
(0, node_test_1.default)('deriveVerdict requires completion signal before showing verified tool-count banner', () => {
    const verdict = (0, helpers_js_1.deriveVerdict)('Assessment delivered.\n\n```json\n{"goal_status":"complete","progress_status":"advancing","uncertainty":"low"}\n```', completedTrace(2));
    strict_1.default.equal(verdict.level, 'verified');
    strict_1.default.equal(verdict.summary, 'Verified with 2 executed tool calls.');
});
(0, node_test_1.default)('deriveVerdict honors partial structured envelope over successful tool trace', () => {
    const verdict = (0, helpers_js_1.deriveVerdict)('Investigated the adapter, but no final assessment was delivered.\n\n```json\n{"goal_status":"partial","progress_status":"stalled","uncertainty":"high"}\n```', completedTrace(45));
    strict_1.default.equal(verdict.level, 'partial');
    strict_1.default.match(verdict.summary, /Partial progress: 45 executed tool calls/);
});
//# sourceMappingURL=chat-panel-helpers.test.js.map