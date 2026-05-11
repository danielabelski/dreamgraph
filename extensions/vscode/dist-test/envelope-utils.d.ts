/**
 * envelope-utils.ts — Shared lenient extractor for the structured continuation envelope.
 *
 * Why it exists:
 * - The autonomy loop (host) and the chat webview both need to recognize the
 *   same JSON envelope emitted by the LLM. Historically the host used a strict
 *   regex + JSON.parse while the webview ran a separate, slightly more
 *   forgiving parser. When the two diverge, the user sees raw JSON in the
 *   bubble AND autonomy stops continuing — both at once. This module gives
 *   the host the same lenient behaviour the webview already aspires to, so
 *   either side fails or succeeds in lockstep.
 *
 * The webview cannot import this file directly (it ships as a template-string
 * inline script). The webview-side equivalent in `webview/card-renderer.ts`
 * mirrors this logic and must be kept in sync. See the SYNC marker comments
 * in both files.
 */
import type { StructuredActionEnvelope } from './autonomy-contract.js';
/**
 * Validate that an arbitrary parsed value looks like a structured continuation
 * envelope. Mirrors `isEnvelopeShape` in card-renderer.ts.
 */
export declare function isEnvelopeShape(value: unknown): value is StructuredActionEnvelope;
/**
 * Light, string-aware JSON repair targeted at the small set of quirks LLMs
 * (especially Claude with extended thinking) emit:
 *   - NBSP between tokens
 *   - smart quotes used as the JSON quote character
 *   - trailing commas before } or ]
 *   - // line comments and block comments
 *
 * The trailing-comma and comment passes are string-aware so a label like
 * "Run //test" or "Hello, ]bracket" is preserved. Smart-quote substitution is
 * a blanket character replacement; if a smart quote appears inside an
 * already-quoted string body we lose that character's exact glyph but JSON
 * parsing succeeds — an acceptable trade for resilience.
 */
export declare function repairJsonish(src: string): string;
/**
 * String-aware balanced-brace finder. Returns the substring of `text` starting
 * at `startIdx` (which must point at '{') up to and including its matching
 * '}'. Returns null if no balance is found. Mirrors the webview helper of the
 * same name.
 */
export declare function findBalancedObject(text: string, startIdx: number): string | null;
/**
 * Normalize loose / drifted envelope shapes that LLMs sometimes emit into the
 * canonical shape that `isEnvelopeShape` accepts. Mirrors the
 * `normalizeLooseEnvelope` helper in webview/card-renderer.ts.
 *
 * Drifts handled:
 *  - `summary` is an object with arrays { discovered, changed, current_state,
 *    recommended_next_step } instead of a plain string.
 *  - `recommended_next_step` (singular) used at top level instead of plural.
 *  - Top-level wrapped under `{ autonomy, summary }` where `summary` carries
 *    the actual payload (Conscientious / Eager auto-pass envelope drift).
 */
export declare function normalizeLooseEnvelope(value: unknown): unknown;
/**
 * Try strict JSON.parse, then a single lenient pass via repairJsonish.
 * Returns a typed envelope only if the parsed object looks like a continuation
 * envelope. This intentionally rejects unrelated JSON objects so we don't
 * confuse e.g. tool argument blobs with envelopes.
 */
export declare function tryParseEnvelope(raw: string): StructuredActionEnvelope | null;
/**
 * Walk a free-form LLM response and return every embedded continuation
 * envelope, in document order. Handles three emission styles:
 *   1) ```json fenced blocks
 *   2) ``` fenced blocks with no language hint
 *   3) Bare top-level JSON objects containing a "summary" key
 * Each candidate body is run through `tryParseEnvelope` so quirks like smart
 * quotes and trailing commas are tolerated.
 */
export declare function extractEnvelopes(content: string): StructuredActionEnvelope[];
/**
 * Convenience: first envelope or undefined.
 */
export declare function extractPrimaryEnvelope(content: string): StructuredActionEnvelope | undefined;
//# sourceMappingURL=envelope-utils.d.ts.map