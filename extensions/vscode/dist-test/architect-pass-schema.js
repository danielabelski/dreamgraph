"use strict";
/**
 * Canonical Architect-pass output schema.
 *
 * Single source of truth for the structured output contract. Used by every
 * provider adapter that supports server-enforced JSON schemas (OpenAI
 * `response_format: json_schema` strict mode for both Chat Completions and
 * Responses APIs; Anthropic forced tool-use; Ollama `format: json` hint).
 *
 * The shape is intentionally narrow and FLAT:
 *   - `narrative`  — markdown body shown in the assistant bubble.
 *   - `summary`    — one-line completion summary shown on the SUMMARY card.
 *   - `goal_status`/`progress_status`/`uncertainty` — pill values.
 *   - `recommended_next_steps[]` — chip set + autonomy planner input.
 *
 * Strict-mode constraints (OpenAI):
 *   - Every property listed in `properties` MUST appear in `required`.
 *   - `additionalProperties: false` is REQUIRED at every object level.
 *   - All string-enum unions must use `enum`.
 *   - Nested objects must follow the same rules recursively.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ARCHITECT_PASS_JSON_SCHEMA = exports.ARCHITECT_PASS_SCHEMA_NAME = void 0;
exports.getArchitectPassSchemaInstructions = getArchitectPassSchemaInstructions;
exports.isArchitectPassEnvelope = isArchitectPassEnvelope;
exports.tryParseArchitectPassEnvelope = tryParseArchitectPassEnvelope;
/**
 * Schema name registered with the provider. Becomes part of the response
 * format identifier (`json_schema.name`) on Chat Completions and the
 * `text.format.name` field on Responses.
 */
exports.ARCHITECT_PASS_SCHEMA_NAME = 'architect_pass_envelope';
/**
 * JSON Schema definition. Hand-written rather than generated so the strict-
 * mode requirements (every property required, additionalProperties:false,
 * no `oneOf`/`anyOf`/`not`) are visible at a glance.
 *
 * NOTE on `recommended_next_steps[].tool` and `tool_args_json`:
 *   Strict mode forbids omitting fields, so we make them required strings
 *   with empty-string sentinels meaning "no tool binding". Host code
 *   treats `tool === ''` as absent. `tool_args_json` is a JSON-encoded
 *   string rather than a free-form object because strict mode also
 *   forbids unconstrained `additionalProperties` on objects, and we
 *   cannot enumerate every tool's argument shape.
 */
exports.ARCHITECT_PASS_JSON_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: [
        'narrative',
        'summary',
        'goal_status',
        'progress_status',
        'uncertainty',
        'recommended_next_steps',
    ],
    properties: {
        narrative: {
            type: 'string',
            description: 'Human-readable markdown body shown in the assistant chat bubble. May contain headings, lists, fenced code blocks, and inline code. Do NOT embed JSON envelopes here — the envelope fields are emitted separately.',
        },
        summary: {
            type: 'string',
            description: 'One-line plain-text summary of what was completed in this pass. Shown on the SUMMARY card. Max ~200 chars.',
        },
        goal_status: {
            type: 'string',
            enum: ['complete', 'partial', 'blocked'],
            description: 'complete = original goal sufficiently reached; partial = real progress but more to do; blocked = cannot proceed without input/tool/permission.',
        },
        progress_status: {
            type: 'string',
            enum: ['advancing', 'slowing', 'stalled'],
            description: 'advancing = meaningful forward motion this pass; slowing = diminishing returns; stalled = no useful progress and unlikely to resume without a change.',
        },
        uncertainty: {
            type: 'string',
            enum: ['low', 'medium', 'high'],
            description: 'Confidence in the conclusions stated above. high = significant unknowns or unverified assumptions remain.',
        },
        recommended_next_steps: {
            type: 'array',
            description: 'Ordered list of concrete next actions. Empty when there is no safe next step (e.g. goal_status=complete or blocked awaiting user). Each entry becomes a clickable chip.',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'label', 'rationale', 'tool', 'tool_args_json'],
                properties: {
                    id: {
                        type: 'string',
                        description: 'Short stable kebab-case identifier (max 64 chars).',
                    },
                    label: {
                        type: 'string',
                        description: 'Human-readable chip label. Must NOT be a placeholder like "Step 1".',
                    },
                    rationale: {
                        type: 'string',
                        description: 'One sentence explaining why this is the next step. May be empty string if obvious from label.',
                    },
                    tool: {
                        type: 'string',
                        description: 'Exact MCP/local tool name (snake_case) when the step maps to a single tool call. Empty string when the step is not a single-tool action.',
                    },
                    tool_args_json: {
                        type: 'string',
                        description: 'JSON-encoded string of arguments for `tool`. Empty string when `tool` is empty. Must parse with JSON.parse when non-empty.',
                    },
                },
            },
        },
    },
};
/**
 * System-prompt addendum delivered to the model in addition to the
 * server-enforced schema. Schema enforcement guarantees the SHAPE; this
 * block guides the SEMANTICS (what content belongs in each field).
 *
 * Kept tiny on purpose — every byte counts in the system prompt.
 */
function getArchitectPassSchemaInstructions() {
    return [
        '## Output contract',
        'Your response is server-validated against the `architect_pass_envelope` JSON schema. Fields:',
        '- `narrative`: the markdown body the user reads. Headings, lists, code blocks allowed. Do not embed JSON envelopes here.',
        '- `summary`: one-line plain-text summary (≤200 chars) shown on the SUMMARY card.',
        '- `goal_status` / `progress_status` / `uncertainty`: pill values.',
        '- `recommended_next_steps`: chip list. Use `tool=""` and `tool_args_json=""` when a step is not a single-tool action.',
        'All fields are required. Empty array / empty string are the only valid "absent" values.',
    ].join('\n');
}
/**
 * Type guard — returns true when the parsed object satisfies the schema's
 * structural requirements. Used as a defence-in-depth check after parsing
 * model output (strict mode should make this always-true on supported
 * models, but providers occasionally regress).
 */
function isArchitectPassEnvelope(value) {
    if (!value || typeof value !== 'object')
        return false;
    const v = value;
    if (typeof v.narrative !== 'string')
        return false;
    if (typeof v.summary !== 'string')
        return false;
    if (v.goal_status !== 'complete' && v.goal_status !== 'partial' && v.goal_status !== 'blocked')
        return false;
    if (v.progress_status !== 'advancing' && v.progress_status !== 'slowing' && v.progress_status !== 'stalled')
        return false;
    if (v.uncertainty !== 'low' && v.uncertainty !== 'medium' && v.uncertainty !== 'high')
        return false;
    if (!Array.isArray(v.recommended_next_steps))
        return false;
    for (const step of v.recommended_next_steps) {
        if (!step || typeof step !== 'object')
            return false;
        const s = step;
        if (typeof s.id !== 'string')
            return false;
        if (typeof s.label !== 'string')
            return false;
        if (typeof s.rationale !== 'string')
            return false;
        if (typeof s.tool !== 'string')
            return false;
        if (typeof s.tool_args_json !== 'string')
            return false;
    }
    return true;
}
/**
 * Parse model output as a strict architect-pass envelope. Returns null when
 * the content is not a JSON object matching the schema (e.g. provider
 * doesn't support strict mode, or the schema gate was bypassed for a
 * tool-bearing turn). Callers fall back to the legacy lenient extractor.
 *
 * Tries strict JSON.parse first, then a single repair pass via the same
 * `repairJsonish` lenient parser the legacy extractor uses — defence in
 * depth for partial truncations or rare provider drift.
 */
function tryParseArchitectPassEnvelope(content) {
    const trimmed = String(content ?? '').trim();
    if (!trimmed)
        return null;
    if (trimmed[0] !== '{')
        return null;
    try {
        const parsed = JSON.parse(trimmed);
        if (isArchitectPassEnvelope(parsed))
            return parsed;
    }
    catch {
        // fall through
    }
    return null;
}
//# sourceMappingURL=architect-pass-schema.js.map