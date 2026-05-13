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
export interface ArchitectPassEnvelope {
    narrative: string;
    summary: string;
    goal_status: 'complete' | 'partial' | 'blocked';
    progress_status: 'advancing' | 'slowing' | 'stalled';
    uncertainty: 'low' | 'medium' | 'high';
    recommended_next_steps: ArchitectPassNextStep[];
}
export interface ArchitectPassNextStep {
    id: string;
    label: string;
    rationale: string;
    tool: string;
    tool_args_json: string;
}
/**
 * Schema name registered with the provider. Becomes part of the response
 * format identifier (`json_schema.name`) on Chat Completions and the
 * `text.format.name` field on Responses.
 */
export declare const ARCHITECT_PASS_SCHEMA_NAME = "architect_pass_envelope";
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
export declare const ARCHITECT_PASS_JSON_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["narrative", "summary", "goal_status", "progress_status", "uncertainty", "recommended_next_steps"];
    readonly properties: {
        readonly narrative: {
            readonly type: "string";
            readonly description: "Human-readable markdown body shown in the assistant chat bubble. May contain headings, lists, fenced code blocks, and inline code. Do NOT embed JSON envelopes here — the envelope fields are emitted separately.";
        };
        readonly summary: {
            readonly type: "string";
            readonly description: "One-line plain-text summary of what was completed in this pass. Shown on the SUMMARY card. Max ~200 chars.";
        };
        readonly goal_status: {
            readonly type: "string";
            readonly enum: readonly ["complete", "partial", "blocked"];
            readonly description: "complete = original goal sufficiently reached; partial = real progress but more to do; blocked = cannot proceed without input/tool/permission.";
        };
        readonly progress_status: {
            readonly type: "string";
            readonly enum: readonly ["advancing", "slowing", "stalled"];
            readonly description: "advancing = meaningful forward motion this pass; slowing = diminishing returns; stalled = no useful progress and unlikely to resume without a change.";
        };
        readonly uncertainty: {
            readonly type: "string";
            readonly enum: readonly ["low", "medium", "high"];
            readonly description: "Confidence in the conclusions stated above. high = significant unknowns or unverified assumptions remain.";
        };
        readonly recommended_next_steps: {
            readonly type: "array";
            readonly description: "Ordered list of concrete next actions. Empty when there is no safe next step (e.g. goal_status=complete or blocked awaiting user). Each entry becomes a clickable chip.";
            readonly items: {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["id", "label", "rationale", "tool", "tool_args_json"];
                readonly properties: {
                    readonly id: {
                        readonly type: "string";
                        readonly description: "Short stable kebab-case identifier (max 64 chars).";
                    };
                    readonly label: {
                        readonly type: "string";
                        readonly description: "Human-readable chip label. Must NOT be a placeholder like \"Step 1\".";
                    };
                    readonly rationale: {
                        readonly type: "string";
                        readonly description: "One sentence explaining why this is the next step. May be empty string if obvious from label.";
                    };
                    readonly tool: {
                        readonly type: "string";
                        readonly description: "Exact MCP/local tool name (snake_case) when the step maps to a single tool call. Empty string when the step is not a single-tool action.";
                    };
                    readonly tool_args_json: {
                        readonly type: "string";
                        readonly description: "JSON-encoded string of arguments for `tool`. Empty string when `tool` is empty. Must parse with JSON.parse when non-empty.";
                    };
                };
            };
        };
    };
};
/**
 * System-prompt addendum delivered to the model in addition to the
 * server-enforced schema. Schema enforcement guarantees the SHAPE; this
 * block guides the SEMANTICS (what content belongs in each field).
 *
 * Kept tiny on purpose — every byte counts in the system prompt.
 */
export declare function getArchitectPassSchemaInstructions(): string;
/**
 * Type guard — returns true when the parsed object satisfies the schema's
 * structural requirements. Used as a defence-in-depth check after parsing
 * model output (strict mode should make this always-true on supported
 * models, but providers occasionally regress).
 */
export declare function isArchitectPassEnvelope(value: unknown): value is ArchitectPassEnvelope;
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
export declare function tryParseArchitectPassEnvelope(content: string): ArchitectPassEnvelope | null;
//# sourceMappingURL=architect-pass-schema.d.ts.map