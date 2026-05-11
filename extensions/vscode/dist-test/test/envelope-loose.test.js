"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const envelope_utils_js_1 = require("../envelope-utils.js");
(0, node_test_1.default)('normalizes nested-summary envelope drift (autonomy + summary wrapper)', () => {
    const raw = JSON.stringify({
        autonomy: { completed: 1, remaining: 0, total_authorized: 1 },
        summary: {
            discovered: ['Health ok at foundation', 'Ops visibility weak'],
            changed: ['Appended Health Report section to plans/X.md'],
            current_state: ['Report exists in plans/'],
            recommended_next_step: 'Create dedicated standalone plan/report file',
        },
    });
    const env = (0, envelope_utils_js_1.tryParseEnvelope)(raw);
    strict_1.default.ok(env, 'envelope should be recognized after normalization');
    strict_1.default.equal(typeof env.summary, 'string');
    strict_1.default.match(env.summary, /Discovered:/);
    strict_1.default.match(env.summary, /Changed:/);
    strict_1.default.equal(env.recommended_next_steps?.length, 1);
    strict_1.default.equal(env.recommended_next_steps?.[0]?.label, 'Create dedicated standalone plan/report file');
});
(0, node_test_1.default)('promotes singular recommended_next_step to plural array', () => {
    const obj = {
        summary: 'flat summary',
        goal_status: 'partial',
        recommended_next_step: 'Do the thing',
    };
    const normalized = (0, envelope_utils_js_1.normalizeLooseEnvelope)(obj);
    strict_1.default.ok((0, envelope_utils_js_1.isEnvelopeShape)(normalized));
    const steps = normalized.recommended_next_steps;
    strict_1.default.equal(steps.length, 1);
    strict_1.default.equal(steps[0].label, 'Do the thing');
});
(0, node_test_1.default)('preserves canonical envelope unchanged', () => {
    const canonical = {
        summary: 'all good',
        goal_status: 'complete',
        recommended_next_steps: [{ id: 'a', label: 'A' }],
    };
    const env = (0, envelope_utils_js_1.tryParseEnvelope)(JSON.stringify(canonical));
    strict_1.default.ok(env);
    strict_1.default.equal(env.summary, 'all good');
    strict_1.default.equal(env.recommended_next_steps?.[0]?.label, 'A');
});
//# sourceMappingURL=envelope-loose.test.js.map