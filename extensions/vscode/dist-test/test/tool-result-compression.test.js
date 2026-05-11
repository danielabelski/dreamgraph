"use strict";
/**
 * Phase 4 of NEVER_FAIL_BUDGET_DEBT_PLAN — multi-tier tool-result compression.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const tool_result_compression_js_1 = require("../tool-result-compression.js");
function makeCoordinator(opts) {
    const recorded = [];
    return {
        recorded,
        getPressure: () => opts.pressure,
        getRemainingTargetTokens: () => opts.remainingTargetTokens ?? 8000,
        recordCompression: (component, originalTokens, finalTokens, mode) => {
            recorded.push({ component, originalTokens, finalTokens, mode });
        },
    };
}
(0, node_test_1.default)("Phase 4 — pressure ≤ 0 returns content verbatim", () => {
    const coord = makeCoordinator({ pressure: -0.2 });
    const content = 'x'.repeat(50_000);
    const result = (0, tool_result_compression_js_1.compressToolResult)(content, coord, 'read_source_code');
    strict_1.default.equal(result.content, content);
    strict_1.default.equal(result.mode, 'verbatim');
    strict_1.default.equal(result.originalChars, 50_000);
    strict_1.default.equal(result.finalChars, 50_000);
    strict_1.default.equal(coord.recorded.length, 1);
    strict_1.default.equal(coord.recorded[0].mode, 'verbatim');
    strict_1.default.equal(coord.recorded[0].component, 'tool:read_source_code');
});
(0, node_test_1.default)("Phase 4 — server-side envelope passthrough preserved under any pressure", () => {
    const coord = makeCoordinator({ pressure: 0.9 });
    const content = 'header bytes\n' + 'x'.repeat(40_000) + '\n[Truncated: 90000/120000 chars]';
    const result = (0, tool_result_compression_js_1.compressToolResult)(content, coord, 'fetch_web_page');
    strict_1.default.equal(result.mode, 'envelope-preserved');
    strict_1.default.equal(result.content, content); // unchanged
    strict_1.default.equal(coord.recorded[0].mode, 'envelope-preserved');
});
(0, node_test_1.default)("Phase 4 — mild tier (0 < pressure ≤ 0.5) leaves small payloads verbatim", () => {
    const coord = makeCoordinator({ pressure: 0.3 });
    const content = 'x'.repeat(2_000); // far below default 4 000-token slice (≈ 16 000 chars)
    const result = (0, tool_result_compression_js_1.compressToolResult)(content, coord, 'list_directory');
    strict_1.default.equal(result.mode, 'verbatim');
    strict_1.default.equal(result.content, content);
});
(0, node_test_1.default)("Phase 4 — mild tier trims when content exceeds expected slice", () => {
    const coord = makeCoordinator({ pressure: 0.3 });
    const content = 'A'.repeat(40_000) + 'B'.repeat(40_000); // 80 000 chars > 16 000 slice
    const result = (0, tool_result_compression_js_1.compressToolResult)(content, coord, 'search_source_code');
    strict_1.default.equal(result.mode, 'expected');
    strict_1.default.ok(result.finalChars < result.originalChars);
    strict_1.default.ok(result.content.includes('mild compression'));
    strict_1.default.ok(result.content.startsWith('A')); // head retained
    strict_1.default.ok(result.content.endsWith('B')); // tail retained
});
(0, node_test_1.default)("Phase 4 — aggressive tier (pressure > 0.5) trims hard with high-pressure marker", () => {
    const coord = makeCoordinator({ pressure: 0.8, remainingTargetTokens: 1_000 });
    const content = 'A'.repeat(60_000) + 'B'.repeat(60_000);
    const result = (0, tool_result_compression_js_1.compressToolResult)(content, coord, 'read_source_code');
    strict_1.default.equal(result.mode, 'debt-repay');
    strict_1.default.ok(result.finalChars < result.originalChars);
    // Floor of 2 000 chars + marker + tail; well under original 120 000.
    strict_1.default.ok(result.finalChars < 10_000);
    strict_1.default.ok(result.content.includes('aggressive compression'));
    strict_1.default.ok(result.content.includes('pressure=high'));
});
(0, node_test_1.default)("Phase 4 — coordinator that throws does not break the pipeline", () => {
    const coord = {
        getPressure: () => {
            throw new Error('boom');
        },
    };
    const content = 'verbatim payload';
    const result = (0, tool_result_compression_js_1.compressToolResult)(content, coord, 'misbehaving');
    strict_1.default.equal(result.mode, 'verbatim');
    strict_1.default.equal(result.content, content);
});
(0, node_test_1.default)("Phase 4 — recordCompression that throws does not break the pipeline", () => {
    const coord = {
        getPressure: () => 0.3,
        recordCompression: () => {
            throw new Error('boom');
        },
    };
    const content = 'A'.repeat(40_000) + 'B'.repeat(40_000);
    const result = (0, tool_result_compression_js_1.compressToolResult)(content, coord, 'read_source_code');
    strict_1.default.equal(result.mode, 'expected');
    strict_1.default.ok(result.finalChars < result.originalChars);
});
(0, node_test_1.default)("Phase 4 — pressure-tier ordering is monotonic (verbatim ≤ mild ≤ aggressive in trim depth)", () => {
    const content = 'A'.repeat(80_000);
    const verbatim = (0, tool_result_compression_js_1.compressToolResult)(content, makeCoordinator({ pressure: -1 }), 't').finalChars;
    const mild = (0, tool_result_compression_js_1.compressToolResult)(content, makeCoordinator({ pressure: 0.3 }), 't').finalChars;
    const aggressive = (0, tool_result_compression_js_1.compressToolResult)(content, makeCoordinator({ pressure: 0.9, remainingTargetTokens: 1_000 }), 't').finalChars;
    strict_1.default.ok(verbatim >= mild, `verbatim (${verbatim}) >= mild (${mild})`);
    strict_1.default.ok(mild >= aggressive, `mild (${mild}) >= aggressive (${aggressive})`);
});
//# sourceMappingURL=tool-result-compression.test.js.map