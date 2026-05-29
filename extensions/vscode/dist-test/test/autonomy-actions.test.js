"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const autonomy_js_1 = require("../autonomy.js");
(0, node_test_1.default)('do all eligible only for compatible actions', () => {
    const ranked = (0, autonomy_js_1.rankRecommendedActions)([
        { id: 'a1', label: 'One', priority: 1, eligible: true, withinScope: true },
        { id: 'a2', label: 'Two', priority: 2, eligible: true, withinScope: true },
    ]);
    strict_1.default.equal(ranked.doAllEligible, true);
});
(0, node_test_1.default)('eager selects strongest action under medium uncertainty when defining', () => {
    const ranked = (0, autonomy_js_1.rankRecommendedActions)([
        { id: 'a1', label: 'Add clickable actions', priority: 1, eligible: true, withinScope: true },
    ]);
    const selected = (0, autonomy_js_1.chooseActionForMode)('eager', ranked, {
        hasClearNextStep: true,
        uncertainty: 'medium',
        hasBlockingFailure: false,
        nextStepWithinScope: true,
        goalSufficientlyReached: false,
        progressStatus: 'advancing',
        nextStepIsDefining: true,
    });
    strict_1.default.equal(selected, 'a1');
});
(0, node_test_1.default)('capability guards block graph release records without graph-write MCP tool', () => {
    const guarded = (0, autonomy_js_1.applyRecommendedActionCapabilityGuards)([
        {
            id: 'record-release',
            label: 'Record v10.6.0 release in DreamGraph knowledge graph',
            priority: 1,
            eligible: true,
            withinScope: true,
        },
    ], { availableToolNames: ['read_local_file'], env: {} });
    strict_1.default.equal(guarded[0].eligible, false);
    strict_1.default.equal(guarded[0].blockers?.[0]?.kind, 'missing_tool');
    strict_1.default.match(guarded[0].blockers?.[0]?.label ?? '', /enrich_seed_data/);
    strict_1.default.equal((0, autonomy_js_1.rankRecommendedActions)(guarded).actions.length, 0);
});
(0, node_test_1.default)('capability guards allow graph release records when enrich_seed_data is exposed', () => {
    const guarded = (0, autonomy_js_1.applyRecommendedActionCapabilityGuards)([
        {
            id: 'record-release',
            label: 'Record v10.6.0 release in DreamGraph knowledge graph',
            priority: 1,
            eligible: true,
            withinScope: true,
        },
    ], { availableToolNames: ['enrich_seed_data'], env: {} });
    strict_1.default.equal(guarded[0].eligible, true);
    strict_1.default.equal(guarded[0].blockers, undefined);
});
(0, node_test_1.default)('capability guards block marketplace publish without VSCE_PAT', () => {
    const guarded = (0, autonomy_js_1.applyRecommendedActionCapabilityGuards)([
        {
            id: 'publish',
            label: 'Publish VSIX to VS Code Marketplace',
            priority: 1,
            eligible: true,
            withinScope: true,
        },
    ], { availableToolNames: ['run_command'], env: {} });
    strict_1.default.equal(guarded[0].eligible, false);
    strict_1.default.equal(guarded[0].blockers?.[0]?.kind, 'missing_secret');
    strict_1.default.match(guarded[0].blockers?.[0]?.label ?? '', /VSCE_PAT/);
});
(0, node_test_1.default)('capability guards allow marketplace publish when a marketplace PAT is present', () => {
    const guarded = (0, autonomy_js_1.applyRecommendedActionCapabilityGuards)([
        {
            id: 'publish',
            label: 'Publish VSIX to VS Code Marketplace',
            priority: 1,
            eligible: true,
            withinScope: true,
        },
    ], { availableToolNames: ['run_command'], env: { VSCE_PAT: 'present' } });
    strict_1.default.equal(guarded[0].eligible, true);
    strict_1.default.equal(guarded[0].blockers, undefined);
});
(0, node_test_1.default)('blocked actions make Do all ineligible', () => {
    const guarded = (0, autonomy_js_1.applyRecommendedActionCapabilityGuards)([
        { id: 'safe', label: 'Run focused tests', priority: 1, eligible: true, withinScope: true },
        { id: 'publish', label: 'Publish VSIX to VS Code Marketplace', priority: 2, eligible: true, withinScope: true },
    ], { availableToolNames: ['run_command'], env: {} });
    strict_1.default.equal((0, autonomy_js_1.computeDoAllEligibility)(guarded), false);
    strict_1.default.equal((0, autonomy_js_1.rankRecommendedActions)(guarded).actions.map((a) => a.id).join(','), 'safe');
});
//# sourceMappingURL=autonomy-actions.test.js.map