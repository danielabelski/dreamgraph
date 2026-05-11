"use strict";
// architect-v2/cards/render.ts
// Milestone 6 (v10.0.0 cutover) — Deterministic markdown renderer.
//
// STRICT ISOLATION (ADR-140 + ADR-171): no v1 imports; no MCP tool
// names. Pure function over the closed Card taxonomy.
//
// Determinism contract:
//   - Same Card → same markdown, byte for byte.
//   - No Date.now(), no random, no locale formatting.
//   - Iteration order over arrays is the order in the card body.
//   - Numbers are formatted with toString() (no locale separators).
//
// Two entry points:
//   - renderCard(card)        : single card → markdown string
//   - renderCards(cards)      : ordered list → markdown string with
//                               "---" separators between cards
//
// Used by the chat panel webview to display PassResult.cards. Tests
// assert byte-identity for the same input.
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderCards = renderCards;
exports.renderTrailingNote = renderTrailingNote;
exports.sanitizeFreeText = sanitizeFreeText;
exports.renderPass = renderPass;
exports.renderCard = renderCard;
const types_js_1 = require("./types.js");
function renderCards(cards) {
    return cards.map(renderCard).join("\n\n---\n\n");
}
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
function renderTrailingNote(note) {
    if (note === undefined)
        return "";
    const sanitized = sanitizeFreeText(note);
    if (sanitized.length === 0)
        return "";
    // Render as a blockquote with a leading italic label so it is
    // visually distinct from the card stream above.
    const quoted = sanitized
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    return `_Note from model:_\n\n${quoted}`;
}
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
function sanitizeFreeText(input) {
    if (input.length === 0)
        return "";
    // 1. Strip fenced code blocks whose payload is a tool-envelope.
    const fencedStripped = input.replace(/```[a-zA-Z0-9_+-]*\s*([\s\S]*?)```/g, (whole, body) => (looksLikeToolEnvelope(body.trim()) ? "" : whole));
    // 2. Strip multi-line tool-envelope JSON blobs (bare or pretty-printed).
    // Models frequently emit `[ { "type": "tool_use", ... } ]` directly in
    // prose. Walk the string, find every balanced JSON literal that
    // starts with `[` or `{`, and elide the slice if it parses as a
    // tool envelope. Pure, deterministic, and bounded by input length.
    const blobStripped = stripBalancedToolEnvelopes(fencedStripped);
    // 3. Strip bare lines that look like a tool-envelope JSON literal
    // (single-line case for back-compat with earlier behaviour).
    const lines = blobStripped.split(/\r?\n/);
    const kept = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
            kept.push("");
            continue;
        }
        if (looksLikeToolEnvelope(trimmed))
            continue;
        kept.push(line);
    }
    // 4. Collapse runs of blank lines, trim ends.
    const collapsed = kept
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    return collapsed;
}
/**
 * Find every balanced top-level JSON object/array in `input` and elide
 * any whose parsed value is a tool envelope. Skips characters inside
 * string literals so braces in prose like `"the {} placeholder"` don't
 * confuse the bracket counter.
 */
function stripBalancedToolEnvelopes(input) {
    let out = "";
    let i = 0;
    const n = input.length;
    while (i < n) {
        const ch = input[i];
        if (ch !== "{" && ch !== "[") {
            out += ch;
            i += 1;
            continue;
        }
        const end = scanBalancedJson(input, i);
        if (end < 0) {
            out += ch;
            i += 1;
            continue;
        }
        const slice = input.slice(i, end);
        if (looksLikeToolEnvelope(slice)) {
            // Drop the slice entirely.
            i = end;
        }
        else {
            out += slice;
            i = end;
        }
    }
    return out;
}
/**
 * Return the index immediately after the balanced `[]` / `{}` literal
 * starting at `start`, or -1 if the literal is unbalanced or not a
 * recognisable JSON-shaped run. Tracks string literals so braces inside
 * `"..."` (with `\"` escapes) do not affect the depth counter.
 */
function scanBalancedJson(s, start) {
    const open = s[start];
    const close = open === "{" ? "}" : open === "[" ? "]" : "";
    if (!close)
        return -1;
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let i = start; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
            if (escape) {
                escape = false;
            }
            else if (c === "\\") {
                escape = true;
            }
            else if (c === '"') {
                inStr = false;
            }
            continue;
        }
        if (c === '"') {
            inStr = true;
            continue;
        }
        if (c === "{" || c === "[")
            depth += 1;
        else if (c === "}" || c === "]") {
            depth -= 1;
            if (depth === 0)
                return i + 1;
            if (depth < 0)
                return -1;
        }
    }
    return -1;
}
function looksLikeToolEnvelope(payload) {
    if (payload.length === 0)
        return false;
    if (!(payload.startsWith("{") || payload.startsWith("[")))
        return false;
    let parsed;
    try {
        parsed = JSON.parse(payload);
    }
    catch {
        return false;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    if (items.length === 0)
        return false;
    const ENVELOPE_TYPES = new Set([
        "tool_use",
        "tool_result",
        "text",
        "thinking",
        "input_json_delta",
        "function",
        "function_call",
        "message",
    ]);
    for (const item of items) {
        if (typeof item !== "object" || item === null)
            return false;
        const type = item.type;
        if (typeof type !== "string" || !ENVELOPE_TYPES.has(type))
            return false;
    }
    return true;
}
/**
 * Render a complete pass result: the ordered card stream followed by an
 * optional trailing notion. Use this from the chat panel rather than
 * calling `renderCards` and `renderTrailingNote` separately to ensure
 * the separator policy is consistent.
 */
function renderPass(input) {
    const cardsMd = renderCards(input.cards);
    const noteMd = renderTrailingNote(input.trailingNote);
    if (cardsMd.length === 0)
        return noteMd;
    if (noteMd.length === 0)
        return cardsMd;
    return `${cardsMd}\n\n---\n\n${noteMd}`;
}
function renderCard(card) {
    switch (card.kind) {
        case "goal":
            return renderGoal(card);
        case "plan":
            return renderPlan(card);
        case "context":
            return renderContext(card);
        case "decision":
            return renderDecision(card);
        case "edit":
            return renderEdit(card);
        case "verification":
            return renderVerification(card);
        case "blocker":
            return renderBlocker(card);
        case "next-step":
            return renderNextStep(card);
        case "completion":
            return renderCompletion(card);
        case "fallback":
            return renderFallback(card);
        case "outcome":
            return renderOutcome(card);
        default:
            return (0, types_js_1.assertNeverCard)(card);
    }
}
// ---------------------------------------------------------------------------
// Per-kind renderers
// ---------------------------------------------------------------------------
function renderGoal(c) {
    const lines = [];
    lines.push(headerLine(c, "Goal"));
    lines.push(pillsLine(c));
    lines.push("");
    lines.push(c.body.statement.trim());
    if (c.body.acceptance.length > 0) {
        lines.push("");
        lines.push("**Acceptance:**");
        for (const a of c.body.acceptance)
            lines.push(`- ${a}`);
    }
    return lines.join("\n");
}
function renderPlan(c) {
    const lines = [];
    lines.push(headerLine(c, "Plan"));
    lines.push(pillsLine(c));
    lines.push("");
    if (c.body.steps.length === 0) {
        lines.push("_(no steps)_");
    }
    else {
        let i = 1;
        for (const step of c.body.steps) {
            const intent = step.intent ? ` _(${step.intent})_` : "";
            lines.push(`${i}. **${step.id}** — ${step.description}${intent}`);
            i += 1;
        }
    }
    return lines.join("\n");
}
function renderContext(c) {
    const lines = [];
    lines.push(headerLine(c, "Context"));
    lines.push(pillsLine(c));
    lines.push("");
    lines.push(c.body.summary.trim());
    if (c.body.sources.length > 0) {
        lines.push("");
        lines.push("**Sources:**");
        for (const a of c.body.sources)
            lines.push(`- ${formatArtifact(a)}`);
    }
    return lines.join("\n");
}
function renderDecision(c) {
    const lines = [];
    lines.push(headerLine(c, "Decision"));
    lines.push(pillsLine(c));
    lines.push("");
    lines.push(`**Question:** ${c.body.question}`);
    lines.push(`**Chosen:** ${c.body.chosen}`);
    if (c.body.alternatives.length > 0) {
        lines.push(`**Alternatives:** ${c.body.alternatives.join(", ")}`);
    }
    lines.push("");
    lines.push(c.body.rationale.trim());
    if (c.body.adrRef) {
        lines.push("");
        lines.push(`_ADR: ${c.body.adrRef}_`);
    }
    return lines.join("\n");
}
function renderEdit(c) {
    const lines = [];
    lines.push(headerLine(c, "Edit"));
    lines.push(pillsLine(c));
    lines.push("");
    lines.push(c.body.diffSummary.trim());
    if (c.body.artifacts.length > 0) {
        lines.push("");
        lines.push("**Artifacts:**");
        for (const a of c.body.artifacts)
            lines.push(`- ${formatArtifact(a)}`);
    }
    return lines.join("\n");
}
function renderVerification(c) {
    const lines = [];
    lines.push(headerLine(c, "Verification"));
    lines.push(pillsLine(c));
    lines.push("");
    const e = c.body.evidence;
    lines.push(`**${e.kind}** — ${e.passed ? "PASSED" : "FAILED"}`);
    lines.push("");
    lines.push(e.summary.trim());
    if (e.failures && e.failures.length > 0) {
        lines.push("");
        lines.push("**Failures:**");
        for (const f of e.failures) {
            const ref = f.artifactRef ? ` _(${f.artifactRef})_` : "";
            lines.push(`- ${f.description}${ref}`);
        }
    }
    return lines.join("\n");
}
function renderBlocker(c) {
    const lines = [];
    lines.push(headerLine(c, "Blocker"));
    lines.push(pillsLine(c));
    lines.push("");
    lines.push(`**Reason:** ${c.body.reason}`);
    if (c.body.blockedBy.length > 0) {
        lines.push("");
        lines.push("**Blocked by:**");
        for (const b of c.body.blockedBy)
            lines.push(`- ${b}`);
    }
    if (c.body.suggestedRecovery) {
        lines.push("");
        lines.push(`_Suggested recovery: ${c.body.suggestedRecovery}_`);
    }
    return lines.join("\n");
}
function renderNextStep(c) {
    const lines = [];
    lines.push(headerLine(c, "Next step"));
    lines.push(pillsLine(c));
    lines.push("");
    const cont = c.body.continuation;
    lines.push(`**Tool:** \`${cont.selectedAction.tool}\``);
    lines.push(`**Action:** ${cont.selectedAction.label}`);
    lines.push("");
    lines.push(cont.reasoningTrace.trim());
    if (cont.alternativesConsidered.length > 0) {
        lines.push("");
        lines.push("**Alternatives considered:**");
        for (const a of cont.alternativesConsidered) {
            lines.push(`- \`${a.tool}\` — ${a.label}`);
        }
    }
    return lines.join("\n");
}
function renderCompletion(c) {
    const lines = [];
    lines.push(headerLine(c, "Completion"));
    lines.push(pillsLine(c));
    lines.push("");
    lines.push(sanitizeFreeText(c.body.summary));
    if (c.body.artifacts.length > 0) {
        lines.push("");
        lines.push("**Artifacts:**");
        for (const a of c.body.artifacts)
            lines.push(`- ${formatArtifact(a)}`);
    }
    return lines.join("\n");
}
function renderFallback(c) {
    const lines = [];
    lines.push(headerLine(c, "Fallback"));
    lines.push(pillsLine(c));
    lines.push("");
    lines.push(`**Tool:** \`${c.body.plan.chosen.tool}\` (Tier ${c.body.plan.chosen.tier})`);
    lines.push(`**Reason:** ${c.body.justification.reason}`);
    lines.push("");
    lines.push(c.body.justification.note.trim());
    return lines.join("\n");
}
function renderOutcome(c) {
    const lines = [];
    lines.push(headerLine(c, "Outcome"));
    lines.push(pillsLine(c));
    lines.push("");
    const o = c.body.outcome;
    lines.push(`**${o.kind.toUpperCase()}** \`${o.tool}\` (Tier ${o.tier}, ${o.intent})`);
    lines.push(`Duration: ${o.durationMs}ms`);
    if (o.kind === "success" || o.kind === "partial") {
        if (o.artifacts.length > 0) {
            lines.push("");
            lines.push("**Artifacts:**");
            for (const a of o.artifacts)
                lines.push(`- ${formatArtifact(a)}`);
        }
        if (o.kind === "partial") {
            lines.push("");
            lines.push(`_Blocked by: ${o.blockedBy}_`);
        }
        // Surface the actual response body for read tools (query_resource,
        // cognitive_status, list_directory, etc.). Without this users see
        // only "success" with no visibility into what the tool returned.
        const payloadMd = formatPayload(o.payload);
        if (payloadMd) {
            lines.push("");
            lines.push("**Result:**");
            lines.push(payloadMd);
        }
    }
    else {
        lines.push("");
        lines.push(`**Reason:** ${o.failureReason}`);
        lines.push(`_Recoverable: ${o.recoverable ? "yes" : "no"}${o.suggestedFallbackTier !== undefined
            ? ` · Suggested tier: ${o.suggestedFallbackTier}`
            : ""}_`);
    }
    return lines.join("\n");
}
function formatPayload(payload) {
    if (payload === undefined || payload === null)
        return "";
    if (typeof payload === "string") {
        if (payload.trim().length === 0)
            return "";
        return "```\n" + payload + "\n```";
    }
    let serialized;
    try {
        serialized = JSON.stringify(payload, null, 2);
    }
    catch {
        serialized = String(payload);
    }
    if (serialized.length === 0 || serialized === "{}" || serialized === "[]") {
        return "";
    }
    return "```json\n" + serialized + "\n```";
}
// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
function headerLine(c, title) {
    return `### ${title} \`${c.id}\``;
}
function pillsLine(c) {
    const p = c.pills;
    const parts = [];
    // The first five pills are mandatory and always present on a
    // well-formed PillSet. We still guard against `undefined` here so a
    // malformed card never renders the literal string "undefined" to
    // the user — a defense-in-depth complement to PillSet's typing.
    if (p.certainty !== undefined)
        parts.push(`certainty:${p.certainty}`);
    if (p.mode !== undefined)
        parts.push(`mode:${p.mode}`);
    if (p.provider !== undefined)
        parts.push(`provider:${p.provider}`);
    if (p.graphBound !== undefined)
        parts.push(`graph:${p.graphBound}`);
    if (p.autonomyState !== undefined)
        parts.push(`status:${p.autonomyState}`);
    if (p.tier !== null && p.tier !== undefined)
        parts.push(`tier:T${p.tier}`);
    if (p.fallbackReason !== null && p.fallbackReason !== undefined) {
        parts.push(`fallback:${p.fallbackReason}`);
    }
    if (p.verificationStatus !== null && p.verificationStatus !== undefined) {
        parts.push(`verify:${p.verificationStatus}`);
    }
    return parts.map((x) => `\`${x}\``).join(" ");
}
function formatArtifact(a) {
    return `[${a.kind}] \`${a.id}\``;
}
//# sourceMappingURL=render.js.map