"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const architect_lens_js_1 = require("../architect-lens.js");
(0, node_test_1.default)('detectArchitectLens — silent default for empty / trivial prompts', () => {
    strict_1.default.equal((0, architect_lens_js_1.detectArchitectLens)({ prompt: '', intentMode: 'active_file' }).lens, 'generic');
    strict_1.default.equal((0, architect_lens_js_1.detectArchitectLens)({ prompt: 'rename variable foo to bar', intentMode: 'active_file' }).material, false);
    strict_1.default.equal((0, architect_lens_js_1.detectArchitectLens)({ prompt: 'fix typo in comment', intentMode: 'active_file' }).lens, 'generic');
});
(0, node_test_1.default)('detectArchitectLens — performance keywords select performance lens', () => {
    const result = (0, architect_lens_js_1.detectArchitectLens)({
        prompt: 'this query is slow, can we optimize the bottleneck?',
        intentMode: 'active_file',
    });
    strict_1.default.equal(result.lens, 'performance');
    strict_1.default.equal(result.material, true);
    strict_1.default.ok(result.confidence >= 0.6);
    strict_1.default.match(result.reason, /slow|optimize|bottleneck/);
});
(0, node_test_1.default)('detectArchitectLens — security keywords select security lens', () => {
    const result = (0, architect_lens_js_1.detectArchitectLens)({
        prompt: 'audit this auth handler for jwt vulnerabilities',
        intentMode: 'active_file',
    });
    strict_1.default.equal(result.lens, 'security');
    strict_1.default.equal(result.material, true);
});
(0, node_test_1.default)('detectArchitectLens — refactor keywords select refactor lens', () => {
    const result = (0, architect_lens_js_1.detectArchitectLens)({
        prompt: 'extract this duplicated block and clean up the helper',
        intentMode: 'active_file',
    });
    strict_1.default.equal(result.lens, 'refactor');
});
(0, node_test_1.default)('detectArchitectLens — debug keywords select debug lens', () => {
    const result = (0, architect_lens_js_1.detectArchitectLens)({
        prompt: 'why does this throw an exception? help me debug the stack trace',
        intentMode: 'active_file',
    });
    strict_1.default.equal(result.lens, 'debug');
});
(0, node_test_1.default)('detectArchitectLens — review keywords select review lens', () => {
    const result = (0, architect_lens_js_1.detectArchitectLens)({
        prompt: 'please code review this PR and flag any smell',
        intentMode: 'active_file',
    });
    strict_1.default.equal(result.lens, 'review');
});
(0, node_test_1.default)('detectArchitectLens — reliability keywords select reliability lens', () => {
    const result = (0, architect_lens_js_1.detectArchitectLens)({
        prompt: 'add a retry with timeout to make this idempotent',
        intentMode: 'active_file',
    });
    strict_1.default.equal(result.lens, 'reliability');
});
(0, node_test_1.default)('detectArchitectLens — explanatory ask_dreamgraph downgrades weak performance hits', () => {
    // Single keyword "optimize" at base 0.7 — gets downgraded under ask_dreamgraph
    // unless lens is debug/security/review.
    const result = (0, architect_lens_js_1.detectArchitectLens)({
        prompt: 'how does the planner optimize evidence selection?',
        intentMode: 'ask_dreamgraph',
    });
    strict_1.default.equal(result.lens, 'generic');
});
(0, node_test_1.default)('detectArchitectLens — security stays material under ask_dreamgraph', () => {
    const result = (0, architect_lens_js_1.detectArchitectLens)({
        prompt: 'how does authorization flow protect against injection?',
        intentMode: 'ask_dreamgraph',
    });
    strict_1.default.equal(result.lens, 'security');
});
(0, node_test_1.default)('detectArchitectLens — command source forces lens even without keywords', () => {
    const result = (0, architect_lens_js_1.detectArchitectLens)({
        prompt: 'do the thing',
        intentMode: 'active_file',
        commandSource: 'nightmareCycle',
    });
    strict_1.default.equal(result.lens, 'security');
    strict_1.default.ok(result.confidence >= 0.85);
});
(0, node_test_1.default)('lensLabel — capitalised display labels', () => {
    strict_1.default.equal((0, architect_lens_js_1.lensLabel)('performance'), 'Performance');
    strict_1.default.equal((0, architect_lens_js_1.lensLabel)('security'), 'Security');
    strict_1.default.equal((0, architect_lens_js_1.lensLabel)('generic'), 'Generic');
});
//# sourceMappingURL=architect-lens.test.js.map