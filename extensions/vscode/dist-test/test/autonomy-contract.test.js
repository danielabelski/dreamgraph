"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const autonomy_contract_js_1 = require("../autonomy-contract.js");
(0, node_test_1.default)('contract block includes json requirement', () => {
    const block = (0, autonomy_contract_js_1.getStructuredResponseContractBlock)();
    strict_1.default.ok(block.includes('```json'));
    strict_1.default.ok(block.includes('recommended_next_steps'));
    strict_1.default.ok(block.includes('goal_status'));
    strict_1.default.ok(block.includes('exactly one fenced'));
});
(0, node_test_1.default)('extracts structured json envelope blocks', () => {
    const content = [
        'Summary text',
        '```json',
        JSON.stringify({
            summary: 'Implemented next slice',
            goal_status: 'partial',
            progress_status: 'advancing',
            uncertainty: 'low',
            recommended_next_steps: [
                { label: 'Mount header', priority: 1, eligible: true, within_scope: true }
            ]
        }, null, 2),
        '```'
    ].join('\n');
    const blocks = (0, autonomy_contract_js_1.extractJsonEnvelopeBlocks)(content);
    strict_1.default.equal(blocks.length, 1);
    strict_1.default.equal(blocks[0].goal_status, 'partial');
    strict_1.default.equal(blocks[0].recommended_next_steps?.[0]?.label, 'Mount header');
});
(0, node_test_1.default)('returns primary structured json envelope', () => {
    const content = [
        '```json',
        JSON.stringify({ summary: 'Primary', goal_status: 'partial' }),
        '```',
        '```json',
        JSON.stringify({ summary: 'Secondary', goal_status: 'complete' }),
        '```'
    ].join('\n');
    const block = (0, autonomy_contract_js_1.extractPrimaryJsonEnvelope)(content);
    strict_1.default.equal(block?.summary, 'Primary');
    strict_1.default.equal((0, autonomy_contract_js_1.hasStructuredEnvelope)(content), true);
});
(0, node_test_1.default)('ignores malformed json blocks', () => {
    const content = '```json\n{ nope }\n```';
    const blocks = (0, autonomy_contract_js_1.extractJsonEnvelopeBlocks)(content);
    strict_1.default.equal(blocks.length, 0);
    strict_1.default.equal((0, autonomy_contract_js_1.hasStructuredEnvelope)(content), false);
});
(0, node_test_1.default)('extracts envelope from a fenced block with no language hint', () => {
    const content = [
        'Some prose first.',
        '```',
        JSON.stringify({
            summary: 'Lang-less fence',
            goal_status: 'partial',
            recommended_next_steps: [{ label: 'next', priority: 1 }],
        }, null, 2),
        '```',
    ].join('\n');
    const block = (0, autonomy_contract_js_1.extractPrimaryJsonEnvelope)(content);
    strict_1.default.ok(block, 'expected envelope from lang-less fence');
    strict_1.default.equal(block?.summary, 'Lang-less fence');
    strict_1.default.equal(block?.recommended_next_steps?.[0]?.label, 'next');
});
(0, node_test_1.default)('extracts bare top-level JSON envelope (no fence at all)', () => {
    const content = [
        'Done. Here is the envelope:',
        '',
        JSON.stringify({
            summary: 'Bare envelope',
            goal_status: 'complete',
            recommended_next_steps: [],
        }, null, 2),
        '',
        'Trailing prose after envelope.',
    ].join('\n');
    const block = (0, autonomy_contract_js_1.extractPrimaryJsonEnvelope)(content);
    strict_1.default.ok(block, 'expected bare JSON envelope to be extracted');
    strict_1.default.equal(block?.summary, 'Bare envelope');
    strict_1.default.equal(block?.goal_status, 'complete');
});
(0, node_test_1.default)('repairs envelopes containing smart quotes and trailing commas', () => {
    const quirky = [
        '```json',
        '{',
        '  \u201Csummary\u201D: \u201CExtended thinking quirks\u201D,',
        '  \u201Cgoal_status\u201D: \u201Cpartial\u201D,',
        '  \u201Crecommended_next_steps\u201D: [',
        '    { \u201Clabel\u201D: \u201CKeep going\u201D, \u201Cpriority\u201D: 1, },',
        '  ],',
        '}',
        '```',
    ].join('\n');
    const block = (0, autonomy_contract_js_1.extractPrimaryJsonEnvelope)(quirky);
    strict_1.default.ok(block, 'lenient repair should rescue smart-quoted envelope');
    strict_1.default.equal(block?.summary, 'Extended thinking quirks');
    strict_1.default.equal(block?.recommended_next_steps?.length, 1);
    strict_1.default.equal(block?.recommended_next_steps?.[0]?.label, 'Keep going');
});
(0, node_test_1.default)('preserves // and , ] sequences inside string values during repair', () => {
    const tricky = [
        '```json',
        JSON.stringify({
            summary: 'Run //test, ] check',
            goal_status: 'partial',
            recommended_next_steps: [{ label: 'a, b ] c', priority: 1 }],
        }, null, 2),
        '```',
    ].join('\n');
    const block = (0, autonomy_contract_js_1.extractPrimaryJsonEnvelope)(tricky);
    strict_1.default.ok(block, 'expected envelope with tricky string content');
    strict_1.default.equal(block?.summary, 'Run //test, ] check');
    strict_1.default.equal(block?.recommended_next_steps?.[0]?.label, 'a, b ] c');
});
(0, node_test_1.default)('does not falsely match a non-envelope JSON object that happens to have summary', () => {
    const content = [
        'Tool input echo:',
        '```json',
        JSON.stringify({ summary: 'just a tool arg, no envelope keys' }, null, 2),
        '```',
    ].join('\n');
    const blocks = (0, autonomy_contract_js_1.extractJsonEnvelopeBlocks)(content);
    strict_1.default.equal(blocks.length, 0);
});
//# sourceMappingURL=autonomy-contract.test.js.map