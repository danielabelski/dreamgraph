"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const openai_responses_adapter_1 = require("../openai-responses-adapter");
(0, node_test_1.default)('routes only GPT-5.5 model slugs to the Responses API', () => {
    strict_1.default.equal((0, openai_responses_adapter_1.usesOpenAIResponsesApi)('gpt-5.5'), true);
    strict_1.default.equal((0, openai_responses_adapter_1.usesOpenAIResponsesApi)(' GPT-5.5-2026-04-27 '), true);
    strict_1.default.equal((0, openai_responses_adapter_1.usesOpenAIResponsesApi)('gpt-5.4'), false);
    strict_1.default.equal((0, openai_responses_adapter_1.usesOpenAIResponsesApi)('gpt-5'), false);
});
(0, node_test_1.default)('builds a GPT-5.5 Responses request with reasoning, verbosity, and function tools', () => {
    const body = (0, openai_responses_adapter_1.buildOpenAIResponsesRequest)([{ role: 'user', content: 'Inspect the graph' }], {
        model: 'gpt-5.5',
        reasoningEffort: 'medium',
        textVerbosity: 'low',
        tools: [
            {
                name: 'query_resource',
                description: 'Query graph resources',
                inputSchema: {
                    type: 'object',
                    properties: { uri: { type: 'string' } },
                    required: ['uri'],
                },
            },
        ],
    });
    strict_1.default.equal(body.model, 'gpt-5.5');
    strict_1.default.equal(body.max_output_tokens, 16384);
    strict_1.default.deepEqual(body.reasoning, { effort: 'medium' });
    strict_1.default.deepEqual(body.text, { verbosity: 'low' });
    strict_1.default.deepEqual(body.input, [{ role: 'user', content: 'Inspect the graph' }]);
    strict_1.default.deepEqual(body.tools, [
        {
            type: 'function',
            name: 'query_resource',
            description: 'Query graph resources',
            parameters: {
                type: 'object',
                properties: { uri: { type: 'string' } },
                required: ['uri'],
            },
        },
    ]);
});
(0, node_test_1.default)('translates Architect tool history into Responses function-call items', () => {
    const translated = (0, openai_responses_adapter_1.translateRawToOpenAIResponses)([
        {
            role: 'assistant',
            content: [
                { type: 'text', text: 'I will query the graph.' },
                { type: 'tool_use', id: 'call_1', name: 'query_resource', input: { uri: 'dream://adrs' } },
            ],
        },
        {
            role: 'user',
            content: [
                { type: 'tool_result', tool_use_id: 'call_1', content: [{ id: 'ADR-086' }] },
            ],
        },
    ]);
    strict_1.default.deepEqual(translated, [
        { role: 'assistant', content: 'I will query the graph.' },
        {
            type: 'function_call',
            call_id: 'call_1',
            name: 'query_resource',
            arguments: JSON.stringify({ uri: 'dream://adrs' }),
        },
        {
            type: 'function_call_output',
            call_id: 'call_1',
            output: JSON.stringify([{ id: 'ADR-086' }]),
        },
    ]);
});
(0, node_test_1.default)('skips malformed raw replay items instead of emitting invalid Responses items', () => {
    const translated = (0, openai_responses_adapter_1.translateRawToOpenAIResponses)([
        null,
        'not a message',
        { role: 'assistant', content: [{ type: 'tool_use', id: '', name: 'query_resource', input: {} }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_missing_name', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', content: 'missing tool id' }] },
        { role: 'user', content: [{ type: 'unknown', text: 'ignored' }] },
        { role: 'system', content: 'Keep responses concise.' },
    ]);
    strict_1.default.deepEqual(translated, [
        { role: 'system', content: 'Keep responses concise.' },
    ]);
});
(0, node_test_1.default)('extracts text while safely ignoring unknown Responses output items', () => {
    const text = (0, openai_responses_adapter_1.extractOpenAIResponsesText)({
        output: [
            { type: 'reasoning', summary: [] },
            { type: 'web_search_call', id: 'search_1', status: 'completed' },
            {
                type: 'message',
                content: [
                    { type: 'output_text', text: 'Known text. ' },
                    { type: 'unknown_block', text: 'ignored' },
                ],
            },
            { type: 'text', text: 'Fallback text.' },
        ],
    });
    strict_1.default.equal(text, 'Known text. Fallback text.');
});
(0, node_test_1.default)('inserts a paragraph break between adjacent verbose-mode message items lacking surrounding whitespace', () => {
    // Reproduces the GPT-5.5 verbose-mode bug where consecutive top-level
    // messages were concatenated tightly, producing
    // "...stale references.Autonomy counters: steps=54..." in the chat.
    const text = (0, openai_responses_adapter_1.extractOpenAIResponsesText)({
        output: [
            {
                type: 'message',
                content: [
                    { type: 'output_text', text: 'Resuming by patching final stale version references.' },
                ],
            },
            {
                type: 'message',
                content: [
                    { type: 'output_text', text: 'Autonomy counters: steps=54, writes=19, stalls=1.' },
                ],
            },
        ],
    });
    strict_1.default.equal(text, 'Resuming by patching final stale version references.\n\nAutonomy counters: steps=54, writes=19, stalls=1.');
});
(0, node_test_1.default)('keeps streamed sub-blocks within a single message tightly joined', () => {
    const text = (0, openai_responses_adapter_1.extractOpenAIResponsesText)({
        output: [
            {
                type: 'message',
                content: [
                    { type: 'output_text', text: 'Step 1: ' },
                    { type: 'output_text', text: 'reading file.' },
                ],
            },
        ],
    });
    strict_1.default.equal(text, 'Step 1: reading file.');
});
(0, node_test_1.default)('extracts function calls and hardens malformed or unknown items', () => {
    const calls = (0, openai_responses_adapter_1.extractOpenAIResponsesToolCalls)({
        output: [
            { type: 'reasoning', id: 'rs_1' },
            { type: 'function_call', call_id: 'call_valid', name: 'read_source_code', arguments: '{"filePath":"src/a.ts"}' },
            { type: 'function_call', call_id: 'call_malformed', name: 'query_resource', arguments: '{bad json' },
            { type: 'function_call', call_id: 'call_missing_name', arguments: '{}' },
            { type: 'function_call', name: 'missing_id', arguments: '{}' },
            { type: 'custom_tool_call', name: 'unsupported', input: '{}' },
        ],
    });
    strict_1.default.deepEqual(calls, [
        { id: 'call_valid', name: 'read_source_code', input: { filePath: 'src/a.ts' } },
        { id: 'call_malformed', name: 'query_resource', input: { arguments: '{bad json' } },
    ]);
});
//# sourceMappingURL=openai-responses-adapter.test.js.map