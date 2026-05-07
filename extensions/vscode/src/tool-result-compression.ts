/**
 * Phase 4 of NEVER_FAIL_BUDGET_DEBT_PLAN — multi-tier tool-result compression.
 *
 * Replaces the previous opt-in `truncateToolResult` hard char cap with a
 * pressure-aware policy driven by the per-turn `BudgetCoordinator`. The
 * coordinator owns all pressure decisions (Plan §4.0); this module only
 * reads `getPressure()` / `getRemainingTargetTokens()` and reports back via
 * `recordCompression(...)`.
 *
 * Policy (Plan §4.3):
 *  - pressure ≤ 0           → verbatim
 *  - 0 < pressure ≤ 0.5     → mild head/tail trim, only if content > expected slice
 *  - pressure > 0.5         → aggressive head/tail trim
 *  - server-side oversized envelopes (already self-marked with a truncation
 *    marker) are passed through verbatim — their pivot hint is more valuable
 *    than the raw bytes.
 *
 * Never refuses, never throws.
 */

/**
 * Compression mode names match those defined in `budget-coordinator.ts` so the
 * coordinator's compression history stays type-aligned end-to-end.
 */
export type CompressionMode =
  | 'verbatim'
  | 'expected'
  | 'debt-repay'
  | 'envelope-preserved';

/**
 * Minimal duck-typed coordinator contract for the tool-result layer. The
 * full `BudgetCoordinator` satisfies this; tests can supply a stub.
 */
export interface ToolCompressionCoordinator {
  getPressure(): number;
  getRemainingTargetTokens?(): number;
  recordCompression?(
    component: string,
    originalTokens: number,
    finalTokens: number,
    mode: CompressionMode,
  ): void;
}

export interface CompressToolResultOptions {
  /**
   * Per-tool slice budget in tokens. Defaults to 4 000 (~ ¼ of a 16 k turn).
   * The mild tier kicks in only when content exceeds this slice.
   */
  expectedSliceTokens?: number;
}

export interface CompressToolResultResult {
  content: string;
  originalChars: number;
  finalChars: number;
  mode: CompressionMode;
}

/** Markers emitted by upstream MCP tool implementations when they themselves
 * decide a payload is oversized. Re-trimming those would destroy the pivot
 * hint the server already preserved (see Plan §4.3). */
const SERVER_ENVELOPE_MARKERS: readonly string[] = [
  '[Truncated:',
  '[truncated,',
  '[truncated to',
  '*[Truncated',
  '[Tool result truncated to',
];

function looksLikeServerEnvelope(content: string): boolean {
  for (const marker of SERVER_ENVELOPE_MARKERS) {
    if (content.includes(marker)) return true;
  }
  return false;
}

function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / 4);
}

function reportCompression(
  coordinator: ToolCompressionCoordinator,
  toolName: string,
  originalChars: number,
  finalChars: number,
  mode: CompressionMode,
): void {
  if (!coordinator.recordCompression) return;
  try {
    coordinator.recordCompression(
      `tool:${toolName}`,
      estimateTokensFromChars(originalChars),
      estimateTokensFromChars(finalChars),
      mode,
    );
  } catch {
    // Reporting must never break the tool result pipeline.
  }
}

/**
 * Phase 4 entry point. Replaces `truncateToolResult(content, limit)`.
 */
export function compressToolResult(
  content: string,
  coordinator: ToolCompressionCoordinator,
  toolName: string,
  options?: CompressToolResultOptions,
): CompressToolResultResult {
  const originalChars = content.length;

  let pressure: number;
  try {
    pressure = coordinator.getPressure();
    if (!Number.isFinite(pressure)) pressure = -1;
  } catch {
    pressure = -1;
  }

  // Tier 0 — no pressure → verbatim.
  if (pressure <= 0) {
    reportCompression(coordinator, toolName, originalChars, originalChars, 'verbatim');
    return { content, originalChars, finalChars: originalChars, mode: 'verbatim' };
  }

  // Tier passthrough — server already trimmed; preserve its pivot hint.
  if (looksLikeServerEnvelope(content)) {
    reportCompression(
      coordinator,
      toolName,
      originalChars,
      originalChars,
      'envelope-preserved',
    );
    return {
      content,
      originalChars,
      finalChars: originalChars,
      mode: 'envelope-preserved',
    };
  }

  const expectedSliceTokens = Math.max(
    1_000,
    Math.floor(options?.expectedSliceTokens ?? 4_000),
  );
  const expectedSliceChars = expectedSliceTokens * 4;

  // Tier mild — 0 < pressure ≤ 0.5.
  if (pressure <= 0.5) {
    if (originalChars <= expectedSliceChars) {
      reportCompression(coordinator, toolName, originalChars, originalChars, 'verbatim');
      return { content, originalChars, finalChars: originalChars, mode: 'verbatim' };
    }
    const headChars = Math.floor(expectedSliceChars * 0.7);
    const tailChars = Math.floor(expectedSliceChars * 0.3);
    const omitted = originalChars - headChars - tailChars;
    const compressed =
      `${content.slice(0, headChars)}\n\n` +
      `[…${omitted} chars omitted (mild compression, tool=${toolName})…]\n\n` +
      `${content.slice(-tailChars)}`;
    reportCompression(coordinator, toolName, originalChars, compressed.length, 'expected');
    return {
      content: compressed,
      originalChars,
      finalChars: compressed.length,
      mode: 'expected',
    };
  }

  // Tier aggressive — pressure > 0.5.
  let remainingTokens: number;
  try {
    remainingTokens = coordinator.getRemainingTargetTokens?.() ?? expectedSliceTokens;
    if (!Number.isFinite(remainingTokens) || remainingTokens < 0) {
      remainingTokens = expectedSliceTokens;
    }
  } catch {
    remainingTokens = expectedSliceTokens;
  }
  // Aim for the smaller of the per-tool slice and what the coordinator says
  // is left. Floor at 2 000 chars so the LLM still sees something useful.
  const targetChars = Math.max(
    2_000,
    Math.min(expectedSliceChars, remainingTokens * 4),
  );
  if (originalChars <= targetChars) {
    reportCompression(coordinator, toolName, originalChars, originalChars, 'verbatim');
    return { content, originalChars, finalChars: originalChars, mode: 'verbatim' };
  }
  const headChars = Math.floor(targetChars * 0.6);
  const tailChars = Math.floor(targetChars * 0.4);
  const omitted = originalChars - headChars - tailChars;
  const compressed =
    `${content.slice(0, headChars)}\n\n` +
    `[…${omitted} chars omitted (aggressive compression, tool=${toolName}, pressure=high)…]\n\n` +
    `${content.slice(-tailChars)}`;
  reportCompression(coordinator, toolName, originalChars, compressed.length, 'debt-repay');
  return {
    content: compressed,
    originalChars,
    finalChars: compressed.length,
    mode: 'debt-repay',
  };
}
