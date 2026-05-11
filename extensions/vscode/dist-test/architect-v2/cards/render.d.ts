import type { Card } from "./types.js";
export declare function renderCards(cards: readonly Card[]): string;
/**
 * Render a free-form trailing notion the model emitted alongside its
 * structured tool calls (the classic "By the way, I noticed X" closing
 * remark). The card taxonomy is closed (ADR-160) and cannot host
 * arbitrary commentary, so the chat panel surfaces this verbatim
 * after the rendered cards via this helper. Pure and deterministic.
 *
 * Returns an empty string when the input is empty/whitespace so that
 * callers can unconditionally concatenate the result without producing
 * stray separators.
 */
export declare function renderTrailingNote(note: string | undefined): string;
/**
 * Provider-neutral sanitizer for any model-emitted free text that
 * crosses the host → webview seam (trailing notes, completion
 * summaries, blocker reasons, etc.).
 *
 * Models occasionally echo their own tool-envelope JSON back inside
 * their prose (`[{"type":"tool_use",...}]`, ```json {"type":"text",...} ```
 * fences, literal `\n` escapes inside the JSON, and so on). That payload
 * has already been consumed by the orchestrator as structured tool
 * calls; the chat surface must never display it as raw text. The card
 * taxonomy (ADR-160) is the user-visible contract.
 *
 * This sanitizer:
 *   1. Strips fenced code blocks whose contents parse as a
 *      tool-envelope shape (object or array of objects with a
 *      recognised `type` discriminator).
 *   2. Strips bare lines that look like a tool-envelope JSON literal.
 *   3. Collapses runs of resulting blank lines.
 *
 * Pure and deterministic; safe to call on every provider's output.
 */
export declare function sanitizeFreeText(input: string): string;
/**
 * Render a complete pass result: the ordered card stream followed by an
 * optional trailing notion. Use this from the chat panel rather than
 * calling `renderCards` and `renderTrailingNote` separately to ensure
 * the separator policy is consistent.
 */
export declare function renderPass(input: {
    readonly cards: readonly Card[];
    readonly trailingNote?: string;
}): string;
export declare function renderCard(card: Card): string;
//# sourceMappingURL=render.d.ts.map