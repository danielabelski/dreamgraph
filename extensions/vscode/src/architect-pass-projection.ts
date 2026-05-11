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

import {
  ARCHITECT_PASS_SCHEMA_NAME,
  isArchitectPassEnvelope,
  tryParseArchitectPassEnvelope,
  type ArchitectPassEnvelope,
} from './architect-pass-schema.js';

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
export function projectStrictEnvelopeToLegacy(rawContent: string): LegacyEnvelopeProjection | null {
  const strict = tryParseArchitectPassEnvelope(rawContent);
  if (!strict) return null;

  // Map strict steps -> legacy step shape. Empty-string sentinels for
  // optional fields collapse back to undefined so the legacy renderer
  // (card-renderer.ts) doesn't try to render "Run " buttons or empty
  // rationale tooltips.
  const legacySteps = strict.recommended_next_steps.map((step) => {
    const out: Record<string, unknown> = {
      id: step.id,
      label: step.label,
    };
    if (step.rationale.trim()) out.rationale = step.rationale;
    if (step.tool.trim()) {
      out.tool = step.tool;
      if (step.tool_args_json.trim()) {
        try {
          out.tool_args = JSON.parse(step.tool_args_json);
        } catch {
          // Malformed args from a non-strict provider — drop the binding
          // rather than crash the planner. Strict mode can't produce this
          // (the schema requires a string, content is up to the model).
        }
      }
    }
    return out;
  });

  const legacyEnvelope = {
    summary: strict.summary,
    goal_status: strict.goal_status,
    progress_status: strict.progress_status,
    uncertainty: strict.uncertainty,
    recommended_next_steps: legacySteps,
  };

  const narrative = strict.narrative;
  const fenced = '```json\n' + JSON.stringify(legacyEnvelope, null, 2) + '\n```';
  const legacyContent = narrative.trim().length > 0 ? `${narrative}\n\n${fenced}` : fenced;

  return { narrative, legacyContent, strict };
}

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
export class StrictNarrativeStreamExtractor {
  private rawBuf = '';
  private decisionMade = false;
  private isStrict = false;
  private state: 'before-narrative' | 'in-narrative' | 'after-narrative' = 'before-narrative';
  /** Pending unprocessed chars while inside the narrative string. */
  private inStringBuf = '';

  feed(chunk: string): string {
    this.rawBuf += chunk;

    if (!this.decisionMade) {
      // Decide once whether the response is a strict envelope. The first
      // non-whitespace char of a strict-mode response is always `{`. Any
      // other prefix means legacy text — fall back to transparent stream.
      const firstNonSpace = this.rawBuf.search(/\S/);
      if (firstNonSpace === -1) return ''; // still all whitespace, wait
      const ch = this.rawBuf[firstNonSpace];
      this.decisionMade = true;
      this.isStrict = ch === '{';
      if (!this.isStrict) {
        // Transparent passthrough mode: emit everything seen so far,
        // then mirror future chunks 1:1.
        const out = this.rawBuf;
        this.rawBuf = '';
        return out;
      }
      // Strict mode: do not emit the leading `{` or any pre-narrative
      // chars. Drop into state machine below.
    }

    if (!this.isStrict) {
      // Already decided non-strict; passthrough.
      const out = chunk;
      return out;
    }

    return this._consumeStrictBuffer();
  }

  /**
   * Returns `{ legacyContent, narrative, strict }` for downstream use.
   * Falls back to the raw content unchanged when projection fails (e.g.
   * truncated stream, provider drift, structured-output disabled).
   */
  finalize(): { content: string; projection: LegacyEnvelopeProjection | null } {
    if (!this.isStrict) {
      return { content: this.rawBuf, projection: null };
    }
    const projection = projectStrictEnvelopeToLegacy(this.rawBuf);
    if (!projection) {
      // Strict mode was active but the parse failed (truncation, provider
      // regression). Return the raw JSON so the user can at least see what
      // came back; legacy parsers will fail gracefully on it.
      return { content: this.rawBuf, projection: null };
    }
    return { content: projection.legacyContent, projection };
  }

  /** Total raw bytes received so far. Useful for telemetry. */
  rawLength(): number {
    return this.rawBuf.length;
  }

  private _consumeStrictBuffer(): string {
    // Find the narrative string opening if we haven't yet.
    if (this.state === 'before-narrative') {
      // Match `"narrative"` (any whitespace) `:` (any whitespace) `"`.
      const m = this.rawBuf.match(/"narrative"\s*:\s*"/);
      if (!m || m.index === undefined) return '';
      this.state = 'in-narrative';
      this.inStringBuf = this.rawBuf.slice(m.index + m[0].length);
    }

    if (this.state === 'in-narrative') {
      const { emitted, remainder, closed } = decodeJsonStringChunk(this.inStringBuf);
      this.inStringBuf = remainder;
      if (closed) {
        this.state = 'after-narrative';
        // Drop any further chars from the user-visible stream — those are
        // the envelope fields, which the SUMMARY card will render after
        // finalize().
      }
      return emitted;
    }

    // after-narrative: swallow silently. Envelope fields are emitted to
    // the SUMMARY card after the stream ends.
    return '';
  }
}

/**
 * Decode as much of a JSON-string body as possible from the start of `buf`,
 * returning the decoded text and the unconsumed remainder. Stops cleanly at
 * the first unescaped `"` (the string terminator) and reports `closed:true`.
 *
 * Handles standard JSON escapes: `\"`, `\\`, `\/`, `\b`, `\f`, `\n`, `\r`,
 * `\t`, `\uXXXX`. When a partial escape sequence is at the tail of `buf`
 * (e.g. final two chars are `\u`) the function leaves the partial sequence
 * in `remainder` so the next `feed()` call can complete it.
 */
function decodeJsonStringChunk(buf: string): { emitted: string; remainder: string; closed: boolean } {
  let out = '';
  let i = 0;
  const n = buf.length;
  while (i < n) {
    const ch = buf[i];
    if (ch === '"') {
      return { emitted: out, remainder: buf.slice(i + 1), closed: true };
    }
    if (ch === '\\') {
      // Need at least one more char to know the escape kind.
      if (i + 1 >= n) break;
      const next = buf[i + 1];
      if (next === '"') { out += '"'; i += 2; continue; }
      if (next === '\\') { out += '\\'; i += 2; continue; }
      if (next === '/') { out += '/'; i += 2; continue; }
      if (next === 'b') { out += '\b'; i += 2; continue; }
      if (next === 'f') { out += '\f'; i += 2; continue; }
      if (next === 'n') { out += '\n'; i += 2; continue; }
      if (next === 'r') { out += '\r'; i += 2; continue; }
      if (next === 't') { out += '\t'; i += 2; continue; }
      if (next === 'u') {
        if (i + 6 > n) break; // need 4 hex digits
        const hex = buf.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          // Malformed escape — treat literally, advance one to make progress.
          out += ch;
          i += 1;
          continue;
        }
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      // Unknown escape — emit literally and continue.
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i++;
  }
  return { emitted: out, remainder: buf.slice(i), closed: false };
}

// Re-export schema name so callers can keep a single import surface.
export { ARCHITECT_PASS_SCHEMA_NAME, isArchitectPassEnvelope };
