/**
 * Phase 4 of NEVER_FAIL_BUDGET_DEBT_PLAN — multi-tier tool-result compression.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compressToolResult,
  type CompressionMode,
  type ToolCompressionCoordinator,
} from '../tool-result-compression.js';

interface RecordedCompression {
  component: string;
  originalTokens: number;
  finalTokens: number;
  mode: CompressionMode;
}

function makeCoordinator(opts: {
  pressure: number;
  remainingTargetTokens?: number;
}): ToolCompressionCoordinator & { recorded: RecordedCompression[] } {
  const recorded: RecordedCompression[] = [];
  return {
    recorded,
    getPressure: () => opts.pressure,
    getRemainingTargetTokens: () => opts.remainingTargetTokens ?? 8000,
    recordCompression: (component, originalTokens, finalTokens, mode) => {
      recorded.push({ component, originalTokens, finalTokens, mode });
    },
  };
}

test("Phase 4 — pressure ≤ 0 returns content verbatim", () => {
  const coord = makeCoordinator({ pressure: -0.2 });
  const content = 'x'.repeat(50_000);
  const result = compressToolResult(content, coord, 'read_source_code');
  assert.equal(result.content, content);
  assert.equal(result.mode, 'verbatim');
  assert.equal(result.originalChars, 50_000);
  assert.equal(result.finalChars, 50_000);
  assert.equal(coord.recorded.length, 1);
  assert.equal(coord.recorded[0].mode, 'verbatim');
  assert.equal(coord.recorded[0].component, 'tool:read_source_code');
});

test("Phase 4 — server-side envelope passthrough preserved under any pressure", () => {
  const coord = makeCoordinator({ pressure: 0.9 });
  const content =
    'header bytes\n' + 'x'.repeat(40_000) + '\n[Truncated: 90000/120000 chars]';
  const result = compressToolResult(content, coord, 'fetch_web_page');
  assert.equal(result.mode, 'envelope-preserved');
  assert.equal(result.content, content); // unchanged
  assert.equal(coord.recorded[0].mode, 'envelope-preserved');
});

test("Phase 4 — mild tier (0 < pressure ≤ 0.5) leaves small payloads verbatim", () => {
  const coord = makeCoordinator({ pressure: 0.3 });
  const content = 'x'.repeat(2_000); // far below default 4 000-token slice (≈ 16 000 chars)
  const result = compressToolResult(content, coord, 'list_directory');
  assert.equal(result.mode, 'verbatim');
  assert.equal(result.content, content);
});

test("Phase 4 — mild tier trims when content exceeds expected slice", () => {
  const coord = makeCoordinator({ pressure: 0.3 });
  const content = 'A'.repeat(40_000) + 'B'.repeat(40_000); // 80 000 chars > 16 000 slice
  const result = compressToolResult(content, coord, 'search_source_code');
  assert.equal(result.mode, 'expected');
  assert.ok(result.finalChars < result.originalChars);
  assert.ok(result.content.includes('mild compression'));
  assert.ok(result.content.startsWith('A')); // head retained
  assert.ok(result.content.endsWith('B')); // tail retained
});

test("Phase 4 — aggressive tier (pressure > 0.5) trims hard with high-pressure marker", () => {
  const coord = makeCoordinator({ pressure: 0.8, remainingTargetTokens: 1_000 });
  const content = 'A'.repeat(60_000) + 'B'.repeat(60_000);
  const result = compressToolResult(content, coord, 'read_source_code');
  assert.equal(result.mode, 'debt-repay');
  assert.ok(result.finalChars < result.originalChars);
  // Floor of 2 000 chars + marker + tail; well under original 120 000.
  assert.ok(result.finalChars < 10_000);
  assert.ok(result.content.includes('aggressive compression'));
  assert.ok(result.content.includes('pressure=high'));
});

test("Phase 4 — coordinator that throws does not break the pipeline", () => {
  const coord: ToolCompressionCoordinator = {
    getPressure: () => {
      throw new Error('boom');
    },
  };
  const content = 'verbatim payload';
  const result = compressToolResult(content, coord, 'misbehaving');
  assert.equal(result.mode, 'verbatim');
  assert.equal(result.content, content);
});

test("Phase 4 — recordCompression that throws does not break the pipeline", () => {
  const coord: ToolCompressionCoordinator = {
    getPressure: () => 0.3,
    recordCompression: () => {
      throw new Error('boom');
    },
  };
  const content = 'A'.repeat(40_000) + 'B'.repeat(40_000);
  const result = compressToolResult(content, coord, 'read_source_code');
  assert.equal(result.mode, 'expected');
  assert.ok(result.finalChars < result.originalChars);
});

test("Phase 4 — pressure-tier ordering is monotonic (verbatim ≤ mild ≤ aggressive in trim depth)", () => {
  const content = 'A'.repeat(80_000);
  const verbatim = compressToolResult(content, makeCoordinator({ pressure: -1 }), 't').finalChars;
  const mild = compressToolResult(content, makeCoordinator({ pressure: 0.3 }), 't').finalChars;
  const aggressive = compressToolResult(
    content,
    makeCoordinator({ pressure: 0.9, remainingTargetTokens: 1_000 }),
    't',
  ).finalChars;
  assert.ok(verbatim >= mild, `verbatim (${verbatim}) >= mild (${mild})`);
  assert.ok(mild >= aggressive, `mild (${mild}) >= aggressive (${aggressive})`);
});
