"use strict";
// Architect-v2 — pipeline-integrity invariants.
//
// These tests are the contract that v2 was rebuilt for. They are NOT
// allowed to regress.
//
//   I1. GRAPH FIRST
//       Every card in a pass MUST advertise the graph state derived
//       from a real ProjectGraphReader probe. A pass that runs against
//       a non-empty graph MUST surface graph:yes / graph:partial on its
//       cards (never the default 'no').
//
//   I2. EVERY OUTPUT HAS A RENDERER
//       Raw provider tool-envelope JSON (`tool_use`, `tool_result`,
//       `text`, etc.) MUST NOT survive into a user-visible card body.
//       The deterministic renderer's sanitizer is the last line of
//       defence; it must strip envelopes whether they appear as bare
//       lines, fenced code, or multi-line pretty-printed JSON.
//
//   I3. EXHAUSTIVE COVERAGE
//       Every Card kind in the closed taxonomy must have a renderer
//       (renderCard must not throw on any kind from the union).
//
//   I4. TOOL EXPOSURE
//       The provider tool-list builder must expose every live MCP tool
//       descriptor. The historical bug — gating by an empty inventory
//       built from `Object.keys(arrayMatrix)` — must stay fixed.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const render_js_1 = require("../architect-v2/cards/render.js");
const types_js_1 = require("../architect-v2/cards/types.js");
const matrix_js_1 = require("../architect-v2/capabilities/matrix.js");
const outcome_js_1 = require("../architect-v2/execution/outcome.js");
const loop_js_1 = require("../architect-v2/orchestrator/loop.js");
const loop_js_2 = require("../architect-v2/orchestrator/loop.js");
const executor_adapter_js_1 = require("../architect-v2/execution/executor-adapter.js");
// ---------------------------------------------------------------------------
// I1 — graph-first mapping (locks the orchestrator's richness→pill seam)
// ---------------------------------------------------------------------------
(0, node_test_1.default)('I1: rich graph richness maps to graph:yes', () => {
    strict_1.default.equal((0, loop_js_1.richnessToGraphBound)('rich'), 'yes');
});
(0, node_test_1.default)('I1: partial / sparse richness map to graph:partial', () => {
    strict_1.default.equal((0, loop_js_1.richnessToGraphBound)('partial'), 'partial');
    strict_1.default.equal((0, loop_js_1.richnessToGraphBound)('sparse'), 'partial');
});
(0, node_test_1.default)('I1: absent or missing richness maps to graph:no (only fallback)', () => {
    strict_1.default.equal((0, loop_js_1.richnessToGraphBound)('absent'), 'no');
    strict_1.default.equal((0, loop_js_1.richnessToGraphBound)(undefined), 'no');
});
// ---------------------------------------------------------------------------
// I2 — sanitizer
// ---------------------------------------------------------------------------
(0, node_test_1.default)('I2: sanitizer strips bare-line tool_use JSON array', () => {
    const input = [
        'Starting with the highest-value read — `package.json`:',
        '[ { "type": "tool_use", "id": "a1", "name": "read_file", "input": { "path": "package.json" } } ]',
        '**Note** Once I have these reads back, I will compose the report.',
    ].join('\n');
    const out = (0, render_js_1.sanitizeFreeText)(input);
    strict_1.default.ok(!/tool_use/.test(out), `tool_use leaked: ${out}`);
    strict_1.default.ok(out.includes('Starting with the highest-value read'));
    strict_1.default.ok(out.includes('Once I have these reads back'));
});
(0, node_test_1.default)('I2: sanitizer strips multi-line pretty-printed tool_use JSON', () => {
    const input = [
        'Plan:',
        '[',
        '  { "type": "tool_use", "id": "a1", "name": "read_file", "input": { "path": "package.json" } },',
        '  { "type": "tool_use", "id": "a2", "name": "list_directory", "input": { "path": "src" } }',
        ']',
        'Then I will synthesize the report.',
    ].join('\n');
    const out = (0, render_js_1.sanitizeFreeText)(input);
    strict_1.default.ok(!/tool_use/.test(out), `tool_use leaked: ${out}`);
    strict_1.default.ok(!/list_directory/.test(out), `tool name leaked: ${out}`);
    strict_1.default.ok(out.includes('Plan:'));
    strict_1.default.ok(out.includes('Then I will synthesize the report.'));
});
(0, node_test_1.default)('I2: sanitizer strips fenced tool_result JSON', () => {
    const input = [
        'Result:',
        '```json',
        '{ "type": "tool_result", "tool_use_id": "a1", "content": "..." }',
        '```',
        'OK.',
    ].join('\n');
    const out = (0, render_js_1.sanitizeFreeText)(input);
    strict_1.default.ok(!/tool_result/.test(out), `tool_result leaked: ${out}`);
});
(0, node_test_1.default)('I2: sanitizer preserves prose containing only the word tool_use', () => {
    // The sanitizer must NOT eat ordinary prose that mentions the type
    // names. Only JSON-shaped envelope literals are stripped.
    const input = 'I will avoid emitting tool_use blocks as prose.';
    const out = (0, render_js_1.sanitizeFreeText)(input);
    strict_1.default.equal(out, input);
});
(0, node_test_1.default)('I2: sanitizer leaves benign JSON objects alone', () => {
    const input = 'The package config: { "name": "demo", "version": "1.0.0" }';
    const out = (0, render_js_1.sanitizeFreeText)(input);
    // The benign object has no `type: <envelope>` discriminator so it
    // must survive intact.
    strict_1.default.ok(out.includes('"name": "demo"'));
});
(0, node_test_1.default)('I2: renderPass routes free text through sanitizer', () => {
    const md = (0, render_js_1.renderPass)({
        cards: [],
        trailingNote: '[ { "type": "tool_use", "id": "x", "name": "noop", "input": {} } ]\nDone.',
    });
    strict_1.default.ok(!/tool_use/.test(md), `pass markdown leaked tool_use: ${md}`);
    strict_1.default.ok(md.includes('Done.'));
});
// ---------------------------------------------------------------------------
// I3 — exhaustive renderer coverage
// ---------------------------------------------------------------------------
const PILLS = Object.freeze({
    certainty: 'medium',
    mode: 'cautious',
    provider: 'anthropic',
    graphBound: 'yes',
    autonomyState: 'running',
    tier: null,
    fallbackReason: null,
    verificationStatus: null,
});
// Note: the wider 11-kind catalogue is exercised by
// architect-v2-cards-render.test.ts. Here we lock the contract that
// renderCard does not throw on a representative subset and always
// emits an H3 header, plus that the OUTCOME path (the most common
// runtime card) renders without leaking executor internals.
const baseHeader = (id) => ({
    id,
    schemaVersion: types_js_1.CARD_SCHEMA_VERSION,
    taskId: 'task-1',
    createdAtEpochMs: 1,
    pills: PILLS,
});
const REPRESENTATIVE_CARDS = [
    {
        ...baseHeader('c-goal'),
        kind: 'goal',
        body: { statement: 'do x', acceptance: ['ok'] },
    },
    {
        ...baseHeader('c-plan'),
        kind: 'plan',
        body: { steps: [{ id: 's1', description: 'one' }] },
    },
    {
        ...baseHeader('c-ctx'),
        kind: 'context',
        body: { summary: 'sum', sources: [] },
    },
    {
        ...baseHeader('c-dec'),
        kind: 'decision',
        body: { question: 'q', chosen: 'a', alternatives: [], rationale: 'r' },
    },
    {
        ...baseHeader('c-edit'),
        kind: 'edit',
        body: { diffSummary: '+1 -0', artifacts: [] },
    },
    {
        ...baseHeader('c-ver'),
        kind: 'verification',
        body: { evidence: { kind: 'build', passed: true, summary: 'ok' } },
    },
    {
        ...baseHeader('c-blk'),
        kind: 'blocker',
        body: { reason: 'r', blockedBy: [] },
    },
    {
        ...baseHeader('c-cmp'),
        kind: 'completion',
        body: { summary: 's', artifacts: [] },
    },
    {
        ...baseHeader('c-out'),
        kind: 'outcome',
        body: {
            outcome: (0, outcome_js_1.success)({
                tool: 'shell.run',
                tier: 5,
                intent: 'shell.run',
                executedAtEpochMs: 1,
                durationMs: 1,
                artifacts: [],
            }),
        },
    },
];
(0, node_test_1.default)('I3: representative Card kinds render with an H3 header', () => {
    for (const c of REPRESENTATIVE_CARDS) {
        const md = (0, render_js_1.renderCard)(c);
        strict_1.default.ok(md.length > 0, `empty render for ${c.kind}`);
        strict_1.default.ok(/^### /.test(md), `missing H3 header for ${c.kind}: ${md.slice(0, 80)}`);
    }
});
(0, node_test_1.default)('I4: CAPABILITY_MATRIX exposes string ids (regression: Object.keys array bug)', () => {
    // The historical bug used `Object.keys(CAPABILITY_MATRIX)` which on a
    // frozen Array returns numeric index strings ("0", "1", ...). The
    // inventory built from those keys never matched any descriptor intent
    // and the provider received zero tools. Lock the correct enumeration.
    const ids = matrix_js_1.CAPABILITY_MATRIX.map((r) => r.id);
    strict_1.default.ok(ids.length > 30, `expected real capability count, got ${ids.length}`);
    for (const id of ids) {
        strict_1.default.ok(/[a-z]/.test(id), `id should be a string id, got ${id}`);
        strict_1.default.ok(!/^\d+$/.test(id), `id must not be a numeric index: ${id}`);
    }
});
// ---------------------------------------------------------------------------
// I5 — provider-agnostic tool-name sanitization
// ---------------------------------------------------------------------------
// Anthropic enforces ^[a-zA-Z0-9_-]{1,128}$ on tool names. OpenAI is
// equivalent. Our catalog uses dotted intent ids (shell.run, mcp.read,
// architect.reply) which would HTTP-400 the call. The sanitizer is
// applied for ALL providers — every adapter receives the same
// already-safe ProviderToolDefinition shape; never branch on provider.
(0, node_test_1.default)('I5: sanitizer rewrites characters outside the provider charset', () => {
    strict_1.default.equal((0, executor_adapter_js_1.sanitizeProviderToolName)('shell.run'), 'shell_run');
    strict_1.default.equal((0, executor_adapter_js_1.sanitizeProviderToolName)('mcp.read.file'), 'mcp_read_file');
    strict_1.default.equal((0, executor_adapter_js_1.sanitizeProviderToolName)('architect.reply'), 'architect_reply');
});
(0, node_test_1.default)('I5: sanitizer preserves already-safe names', () => {
    strict_1.default.equal((0, executor_adapter_js_1.sanitizeProviderToolName)('read_file'), 'read_file');
    strict_1.default.equal((0, executor_adapter_js_1.sanitizeProviderToolName)('list-tools'), 'list-tools');
    strict_1.default.equal((0, executor_adapter_js_1.sanitizeProviderToolName)('mcp_dreamgraph_query_resource'), 'mcp_dreamgraph_query_resource');
});
(0, node_test_1.default)('I5: sanitizer output matches the strict provider regex', () => {
    const re = /^[a-zA-Z0-9_-]{1,128}$/;
    const samples = [
        'shell.run',
        'a.b.c.d',
        'tool with spaces',
        'unicode\u00e9name',
        '@scoped/pkg',
        ':colon:',
    ];
    for (const s of samples) {
        const out = (0, executor_adapter_js_1.sanitizeProviderToolName)(s);
        strict_1.default.ok(re.test(out), `sanitized name '${out}' fails provider regex`);
    }
});
// ---------------------------------------------------------------------------
// I6 — every cataloged MCP tool resolves to a CapabilityId
// ---------------------------------------------------------------------------
// Regression test for the recurring blocker:
//   "No CapabilityId resolves from action ... (tool=mcp_dreamgraph_*)"
// The resolver MUST work from static module data alone (NATIVE_TOOL_CATALOG
// + CAPABILITY_MATRIX) — no port plumbing, no live-roster dependency.
// Every entry the model can possibly call MUST map to a real capability
// so the orchestrator never emits a blocker for a known tool.
(0, node_test_1.default)('I6: every native tool descriptor resolves to a CapabilityId', async () => {
    const { NATIVE_TOOL_CATALOG } = await import('../architect-v2/execution/catalog.js');
    const unresolved = [];
    for (const desc of NATIVE_TOOL_CATALOG) {
        const cap = (0, loop_js_2.resolveCapabilityFromAction)({
            id: 'tooluse_test',
            label: desc.tool,
            rationale: '',
            tool: desc.tool,
            requiresCapabilities: [],
            confidence: 1,
        });
        if (!cap)
            unresolved.push(`${desc.tool} (intent=${desc.intent})`);
    }
    strict_1.default.equal(unresolved.length, 0, `unresolved tool->capability mappings:\n  ${unresolved.join('\n  ')}`);
});
(0, node_test_1.default)('I6: mcp_dreamgraph_cognitive_status resolves (specific blocker repro)', () => {
    const cap = (0, loop_js_2.resolveCapabilityFromAction)({
        id: 'tooluse_repro',
        label: 'cognitive_status',
        rationale: '',
        tool: 'mcp_dreamgraph_cognitive_status',
        requiresCapabilities: [],
        confidence: 0.9,
    });
    strict_1.default.ok(cap, 'mcp_dreamgraph_cognitive_status must resolve to a CapabilityId; ' +
        'this is the exact tool that triggered the recurring blocker.');
});
// ─────────────────────────────────────────────────────────────────────────────
//   I8. PROVIDER-AGNOSTIC TOOL SCHEMA
//       Every emitted ProviderToolDefinition.inputSchema MUST be valid for
//       all four transports (Anthropic, OpenAI Chat, OpenAI Responses,
//       Ollama). The Responses API rejects `additionalProperties:true` and
//       `type:"object"` without a `properties` field. The architect was
//       explicitly designed to be provider-AND-model agnostic — a schema
//       that breaks any one provider violates the foundational contract.
// ─────────────────────────────────────────────────────────────────────────────
(0, node_test_1.default)('I8: provider tool schemas are valid across all transports', async () => {
    const { providerToolsForInventory } = await import('../architect-v2/execution/executor-adapter.js');
    const { NATIVE_TOOL_CATALOG } = await import('../architect-v2/execution/catalog.js');
    // Build a synthetic ResolvedCatalog containing every native tool — the
    // worst case for schema emission: a fully populated provider tool list.
    const resolved = {
        available: NATIVE_TOOL_CATALOG,
        unavailable: [],
        unknownRosterTools: [],
    };
    const inventory = { capabilities: new Set() };
    const bundle = providerToolsForInventory(resolved, inventory);
    strict_1.default.ok(bundle.tools.length > 0, 'expected at least one tool emitted');
    for (const t of bundle.tools) {
        const s = t.inputSchema;
        strict_1.default.equal(s.type, 'object', `tool ${t.name} schema.type must be "object"`);
        strict_1.default.ok(s.properties && typeof s.properties === 'object', `tool ${t.name} schema.properties must be an object (OpenAI Responses requires this)`);
        strict_1.default.notEqual(s.additionalProperties, true, `tool ${t.name} schema.additionalProperties must not be true (OpenAI strict mode rejects it)`);
    }
});
//# sourceMappingURL=architect-v2-pipeline-invariants.test.js.map