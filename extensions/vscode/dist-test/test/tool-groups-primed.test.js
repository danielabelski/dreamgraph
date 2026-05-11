"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const tool_groups_js_1 = require("../tool-groups.js");
const autonomy_structured_js_1 = require("../autonomy-structured.js");
const AVAILABLE = [
    'query_resource',
    'graph_rag_retrieve',
    'read_source_code',
    'list_directory',
    'scan_database',
    'scan_project',
    'init_graph',
    'extract_api_surface',
    'dream_cycle',
    'normalize_dreams',
    'enrich_seed_data',
];
(0, node_test_1.default)('primed tool is exposed even when next prompt is terse', () => {
    const decision = (0, tool_groups_js_1.selectToolGroups)({
        task: 'chat',
        prompt: 'yes',
        autonomy: false,
        availableToolNames: AVAILABLE,
        primedTools: ['scan_database'],
    });
    strict_1.default.ok(decision.selected.includes('scan_database'), `expected scan_database in selection, got [${decision.selected.join(', ')}]`);
});
(0, node_test_1.default)('priming a tool also exposes its sibling group members', () => {
    const decision = (0, tool_groups_js_1.selectToolGroups)({
        task: 'chat',
        prompt: 'do it',
        autonomy: false,
        availableToolNames: AVAILABLE,
        primedTools: ['scan_project'],
    });
    // scan_project lives in project_scan group alongside init_graph + extract_api_surface
    strict_1.default.ok(decision.selected.includes('scan_project'));
    strict_1.default.ok(decision.selected.includes('init_graph'));
    strict_1.default.ok(decision.selected.includes('extract_api_surface'));
});
(0, node_test_1.default)('primed tools that are not in availableToolNames are skipped', () => {
    const decision = (0, tool_groups_js_1.selectToolGroups)({
        task: 'chat',
        prompt: 'yes',
        autonomy: false,
        availableToolNames: AVAILABLE,
        primedTools: ['nonexistent_tool'],
    });
    strict_1.default.ok(!decision.selected.includes('nonexistent_tool'));
});
(0, node_test_1.default)('no primed tools behaves identically to omitting the field', () => {
    const a = (0, tool_groups_js_1.selectToolGroups)({
        task: 'chat',
        prompt: 'hello',
        autonomy: false,
        availableToolNames: AVAILABLE,
    });
    const b = (0, tool_groups_js_1.selectToolGroups)({
        task: 'chat',
        prompt: 'hello',
        autonomy: false,
        availableToolNames: AVAILABLE,
        primedTools: [],
    });
    strict_1.default.deepEqual(a.selected, b.selected);
});
(0, node_test_1.default)('envelope tool/tool_args fields survive structured extraction', () => {
    const content = [
        'Here is what I suggest.',
        '',
        '```json',
        '{',
        '  "summary": "low graph density",',
        '  "recommended_next_steps": [',
        '    {',
        '      "id": "run-dream",',
        '      "label": "Run a dream cycle",',
        '      "tool": "dream_cycle",',
        '      "tool_args": { "strategy": "gap_detection" }',
        '    }',
        '  ]',
        '}',
        '```',
    ].join('\n');
    const env = (0, autonomy_structured_js_1.extractStructuredPassEnvelope)(content);
    strict_1.default.equal(env.nextSteps.length, 1);
    strict_1.default.equal(env.nextSteps[0].tool, 'dream_cycle');
    strict_1.default.deepEqual(env.nextSteps[0].toolArgs, { strategy: 'gap_detection' });
});
(0, node_test_1.default)('envelope without tool field leaves action.tool undefined', () => {
    const content = [
        '```json',
        '{',
        '  "summary": "refactor needed",',
        '  "recommended_next_steps": [',
        '    { "label": "Refactor module" }',
        '  ]',
        '}',
        '```',
    ].join('\n');
    const env = (0, autonomy_structured_js_1.extractStructuredPassEnvelope)(content);
    strict_1.default.equal(env.nextSteps.length, 1);
    strict_1.default.equal(env.nextSteps[0].tool, undefined);
    strict_1.default.equal(env.nextSteps[0].toolArgs, undefined);
});
//# sourceMappingURL=tool-groups-primed.test.js.map