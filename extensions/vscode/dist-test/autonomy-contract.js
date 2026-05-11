"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getStructuredResponseContractBlock = getStructuredResponseContractBlock;
exports.extractJsonEnvelopeBlocks = extractJsonEnvelopeBlocks;
exports.extractPrimaryJsonEnvelope = extractPrimaryJsonEnvelope;
exports.hasStructuredEnvelope = hasStructuredEnvelope;
function getStructuredResponseContractBlock() {
    return [
        '## Structured Continuation Contract',
        '- After each pass, include exactly one fenced ```json block containing a single object that matches this shape exactly:',
        '```json',
        '{',
        '  "summary": "short summary of what changed or was learned",',
        '  "goal_status": "complete|partial|blocked",',
        '  "progress_status": "advancing|slowing|stalled",',
        '  "uncertainty": "low|medium|high",',
        '  "recommended_next_steps": [',
        '    {',
        '      "id": "short-stable-id",',
        '      "label": "human-readable next step",',
        '      "rationale": "why this is next",',
        '      "priority": 1,',
        '      "eligible": true,',
        '      "within_scope": true,',
        '      "mutually_exclusive_with": [],',
        '      "batch_group": "optional-group",',
        '      "tool": "exact_mcp_tool_name",',
        '      "tool_args": { "key": "value" }',
        '    }',
        '  ]',
        '}',
        '```',
        '- Also include normal human-readable explanation in chat.',
        '- Keep recommended_next_steps empty when there is no safe next step.',
        '- `summary` MUST be a plain string. Do not nest objects, arrays, or sub-fields (`discovered`, `changed`, `current_state`, `recommended_next_step`) inside `summary` — put narrative content in the human-readable chat body, and keep this JSON envelope flat exactly as shown above.',
        '- Use the plural key `recommended_next_steps` (an array). Do not emit `recommended_next_step` (singular).',
        '- Do not wrap the envelope in an outer object such as `{ "autonomy": ..., "summary": { ... } }`. Emit the envelope object as the top-level value of the json fenced block.',
        '- Set goal_status to complete when the original goal has sufficiently been reached.',
        '- Set progress_status to stalled when further pursuit is not making meaningful progress.',
        '- Keep ids stable and concise when possible.',
        '- When a step maps to a single tool call, set `tool` to the exact tool name (snake_case) and `tool_args` to its arguments. Omit both when the step is not a single-tool action.',
        '- Prefer the structured json values over prose when they differ.',
    ].join('\n');
}
// Lenient extraction is delegated to the shared envelope-utils module so the
// host parser stays in lockstep with the webview's renderer. Both ends accept
// fenced ```json blocks, fenced blocks without a language hint, and bare
// top-level JSON objects, and both apply the same string-aware repair pass
// for smart quotes, NBSP, trailing commas, and // line comments. Without that
// alignment the chat bubble could pretty-render an envelope while autonomy
// silently failed to parse it (or vice-versa) — the symptom users report as
// "summaries render as JSON and autonomy stops working".
const envelope_utils_js_1 = require("./envelope-utils.js");
function extractJsonEnvelopeBlocks(content) {
    return (0, envelope_utils_js_1.extractEnvelopes)(content);
}
function extractPrimaryJsonEnvelope(content) {
    return (0, envelope_utils_js_1.extractPrimaryEnvelope)(content);
}
function hasStructuredEnvelope(content) {
    return !!extractPrimaryJsonEnvelope(content);
}
//# sourceMappingURL=autonomy-contract.js.map