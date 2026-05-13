/**
 * Streaming/post-receive transform from the strict `architect_pass_envelope`
 * JSON output (OpenAI structured-output mode) to the legacy content shape:
 *
 *     <narrative markdown>
 *
 *     ```json
 *     { ... legacy envelope (summary/goal_status/...) ... }
 *     ```
 *
 * Why transform instead of teaching every downstream parser the new shape:
 *   - Six existing parsers (autonomy-structured, autonomy-contract,
 *     envelope-utils, card-renderer, autonomy-loop, chat-panel webview)
 *     all consume the legacy fenced-JSON shape. Swapping the shape would
 *     require touching every one and risk regressing the lenient extractors
 *     that already absorb model drift.
 *   - The strict schema is a SOURCE-side guarantee. Once we have a clean
 *     parse, projecting it back into the legacy shape is one place,
 *     trivially testable, and leaves the rest of the pipeline untouched.
 *
 * The extractor also handles streaming: while the model is emitting the
 * raw JSON object character-by-character, we forward only the unescaped
 * contents of the `narrative` string field to the live `onChunk` callback,
 * so the user sees clean prose stream into the bubble (no `{"narrative":`
 * noise). When the stream ends, callers ask for the legacy-projected
 * content via `finalize(rawFullText)`.
 *
 * Streaming assumes the model emits `narrative` as the FIRST field. OpenAI
 * strict json_schema mode emits properties in the order they appear in the
 * schema definition, and `narrative` is declared first in
 * `architect-pass-schema.ts`. If a future provider re-orders fields the
 * extractor still produces a correct FINAL projection (via finalize); only
 * the live streaming UX degrades to "shows raw JSON until complete".
 */
import { ARCHITECT_PASS_SCHEMA_NAME, isArchitectPassEnvelope, type ArchitectPassEnvelope } from './architect-pass-schema.js';
export interface LegacyEnvelopeProjection {
    /** Plain prose body (markdown). Empty string when projection failed. */
    narrative: string;
    /** Full legacy-shaped content: `<narrative>\n\n` + fenced ```json envelope. */
    legacyContent: string;
    /** Parsed strict envelope when the input was a strict envelope. */
    strict: ArchitectPassEnvelope | null;
}
/**
 * Project a strict architect-pass envelope into the legacy "prose + fenced
 * JSON envelope" shape that every downstream parser already understands.
 * Returns `null` when the input is not a strict envelope (caller falls back
 * to legacy behaviour).
 */
export declare function projectStrictEnvelopeToLegacy(rawContent: string): LegacyEnvelopeProjection | null;
/**
 * Stateful streaming extractor. Feed raw chunks as they arrive from the
 * provider; the extractor returns the user-visible narrative text to
 * forward to the live UI. On stream completion call `finalize(fullRawText)`
 * to obtain the legacy-projected content for downstream parsers.
 *
 * Behaviour when the input is not a strict envelope (legacy fenced-JSON
 * model output, or a provider with structured output disabled):
 *   - `feed()` returns the raw chunk unchanged (transparent passthrough).
 *   - `finalize()` returns the original content unchanged.
 */
export declare class StrictNarrativeStreamExtractor {
    private rawBuf;
    private decisionMade;
    private isStrict;
    private state;
    /** Pending unprocessed chars while inside the narrative string. */
    private inStringBuf;
    feed(chunk: string): string;
    /**
     * Returns `{ legacyContent, narrative, strict }` for downstream use.
     * Falls back to the raw content unchanged when projection fails (e.g.
     * truncated stream, provider drift, structured-output disabled).
     */
    finalize(): {
        content: string;
        projection: LegacyEnvelopeProjection | null;
    };
    /** Total raw bytes received so far. Useful for telemetry. */
    rawLength(): number;
    private _consumeStrictBuffer;
}
export { ARCHITECT_PASS_SCHEMA_NAME, isArchitectPassEnvelope };
//# sourceMappingURL=architect-pass-projection.d.ts.map