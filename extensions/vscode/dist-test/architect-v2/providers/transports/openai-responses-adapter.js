"use strict";
// architect-v2/providers/transports/openai-responses-adapter.ts
// Milestone 2 (v10.0.0 cutover) — Real OpenAI Responses API adapter.
//
// STRICT ISOLATION (ADR-140): no import from v1.
//
// Wire facts (OpenAI Responses API):
//   - POST {baseUrl}/responses
//   - Body fields: { model, input:[...], tools?:[...], reasoning?:{effort,summary},
//                    text?:{verbosity}, max_output_tokens?, store?:false, stream? }
//   - Each `input` item is one of:
//       { type:'message', role, content:[ { type:'input_text'|'input_image'|
//                                            'output_text', text? } ] }
//       { type:'function_call', call_id, name, arguments }
//       { type:'function_call_output', call_id, output }
//   - Non-stream response carries `output:[{type:'message', content:[
//       {type:'output_text', text}, ...]}, {type:'function_call', call_id,
//       name, arguments}, ...]`.
//   - SSE event types we care about (each `data:` is a JSON envelope with
//     `type` discriminator):
//       response.output_text.delta             { delta }
//       response.reasoning_summary_text.delta  { delta }
//       response.output_item.done              { item: { type, ... } }
//       response.completed                     { response:{ usage } }
//       response.failed                        { error }
//
// v2 calls Responses API in stateless mode (`store:false`) with the full
// message history every turn. We do NOT round-trip encrypted_content; the
// orchestrator's pass-by-pass design rebuilds context per pass.
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenAIResponsesAdapter = void 0;
const adapter_1 = require("../adapter");
const _transport_1 = require("../_transport");
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
class OpenAIResponsesAdapter {
    providerId = "openai";
    model;
    config;
    constructor(model, config) {
        this.model = model;
        this.config = config;
    }
    async callWithTools(request) {
        const body = this.buildRequestBody(request, /* stream */ false);
        const serialized = (0, _transport_1.serializeWithBudget)(this.providerId, this.model.id, body, this.config.requestSizeLimitBytes);
        let res;
        try {
            res = await fetch(`${this.baseUrl()}/responses`, {
                method: "POST",
                headers: this.headers(),
                body: serialized,
                signal: request.abortSignal,
            });
        }
        catch (err) {
            throw (0, _transport_1.mapNetworkError)(err, this.providerId, this.model.id);
        }
        if (!res.ok)
            throw await (0, _transport_1.mapHttpError)(res, this.providerId, this.model.id);
        const data = (await res.json());
        const text = extractOutputText(data);
        const toolCalls = extractToolCalls(data);
        const usage = {
            inputTokens: data.usage?.input_tokens,
            outputTokens: data.usage?.output_tokens,
        };
        let finishReason = "stop";
        if (toolCalls.length > 0)
            finishReason = "tool_calls";
        else if (data.incomplete_details?.reason === "max_output_tokens")
            finishReason = "length";
        return { text, toolCalls, usage, finishReason };
    }
    async *stream(request) {
        const body = this.buildRequestBody(request, /* stream */ true);
        const serialized = (0, _transport_1.serializeWithBudget)(this.providerId, this.model.id, body, this.config.requestSizeLimitBytes);
        let res;
        try {
            res = await fetch(`${this.baseUrl()}/responses`, {
                method: "POST",
                headers: { ...this.headers(), Accept: "text/event-stream" },
                body: serialized,
                signal: request.abortSignal,
            });
        }
        catch (err) {
            yield { kind: "error", error: (0, _transport_1.mapNetworkError)(err, this.providerId, this.model.id) };
            return;
        }
        if (!res.ok) {
            yield { kind: "error", error: await (0, _transport_1.mapHttpError)(res, this.providerId, this.model.id) };
            return;
        }
        let usage;
        let finishReason = "stop";
        let sawToolCall = false;
        try {
            for await (const frame of (0, _transport_1.readSseLines)(res)) {
                if (!frame.data)
                    continue;
                const evt = (0, _transport_1.safeJsonParse)(frame.data);
                if (!evt?.type)
                    continue;
                switch (evt.type) {
                    case "response.output_text.delta":
                        if (typeof evt.delta === "string")
                            yield { kind: "text", delta: evt.delta };
                        break;
                    case "response.reasoning_summary_text.delta":
                        if (typeof evt.delta === "string")
                            yield { kind: "reasoning", delta: evt.delta };
                        break;
                    case "response.output_item.done": {
                        const item = evt.item;
                        if (item && item.type === "function_call") {
                            const call = {
                                id: String(item.call_id ?? ""),
                                name: String(item.name ?? ""),
                                argumentsJson: String(item.arguments ?? "{}"),
                            };
                            if ((0, _transport_1.safeJsonParse)(call.argumentsJson) === undefined) {
                                yield {
                                    kind: "error",
                                    error: new adapter_1.ProviderError({
                                        kind: "tool_call_malformed",
                                        providerId: this.providerId,
                                        modelId: this.model.id,
                                        message: `Tool call ${call.name} (id=${call.id}) emitted invalid JSON arguments`,
                                        providerRaw: call.argumentsJson,
                                    }),
                                };
                                return;
                            }
                            sawToolCall = true;
                            yield { kind: "tool_call", call };
                        }
                        break;
                    }
                    case "response.completed": {
                        if (evt.response?.usage) {
                            usage = {
                                inputTokens: evt.response.usage.input_tokens,
                                outputTokens: evt.response.usage.output_tokens,
                            };
                            yield { kind: "usage", usage };
                        }
                        finishReason = sawToolCall ? "tool_calls" : "stop";
                        yield { kind: "done", finishReason };
                        return;
                    }
                    case "response.failed": {
                        yield {
                            kind: "error",
                            error: new adapter_1.ProviderError({
                                kind: "transport",
                                providerId: this.providerId,
                                modelId: this.model.id,
                                message: `OpenAI Responses API failure: ${evt.error?.message ?? "unknown"}`,
                                providerRaw: evt,
                            }),
                        };
                        return;
                    }
                    default:
                        break;
                }
            }
            yield { kind: "done", finishReason: sawToolCall ? "tool_calls" : finishReason };
        }
        catch (err) {
            yield { kind: "error", error: (0, _transport_1.mapNetworkError)(err, this.providerId, this.model.id) };
        }
    }
    // -------------------------------------------------------------------------
    buildRequestBody(request, stream) {
        const input = translateMessagesToResponsesInput(request.messages);
        const body = {
            model: this.model.id,
            input,
            store: false,
            max_output_tokens: Math.min(request.maxOutputTokens ?? this.model.capabilities.maxOutputTokens, this.model.capabilities.maxOutputTokens),
        };
        if (stream)
            body.stream = true;
        const reasoning = this.model.capabilities.reasoning;
        if (reasoning.supported) {
            const effort = clampEffort(request.reasoningEffort, reasoning.effortLevels, reasoning.defaultEffort);
            body.reasoning = { effort: openaiEffort(effort), summary: "auto" };
        }
        if (request.tools && request.tools.length > 0) {
            body.tools = request.tools.map((t) => translateToolToResponses(t));
            if (request.toolChoice)
                body.tool_choice = translateToolChoiceToResponses(request.toolChoice);
        }
        return body;
    }
    headers() {
        if (!this.config.apiKey || this.config.apiKey.length === 0) {
            throw new adapter_1.ProviderError({
                kind: "auth",
                providerId: this.providerId,
                modelId: this.model.id,
                message: "OpenAI API key not configured",
            });
        }
        return {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.apiKey}`,
        };
    }
    baseUrl() {
        return (this.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    }
}
exports.OpenAIResponsesAdapter = OpenAIResponsesAdapter;
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function translateMessagesToResponsesInput(messages) {
    const items = [];
    for (const m of messages) {
        if (m.role === "tool") {
            items.push({
                type: "function_call_output",
                call_id: m.toolCallId ?? "",
                output: m.content,
            });
            continue;
        }
        if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
            if (m.content && m.content.length > 0) {
                items.push({
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: m.content }],
                });
            }
            for (const tc of m.toolCalls) {
                items.push({
                    type: "function_call",
                    call_id: tc.id,
                    name: tc.name,
                    arguments: tc.argumentsJson || "{}",
                });
            }
            continue;
        }
        const partKind = m.role === "assistant" ? "output_text" : "input_text";
        items.push({
            type: "message",
            role: m.role,
            content: [{ type: partKind, text: m.content }],
        });
    }
    return items;
}
function translateToolToResponses(t) {
    return {
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
    };
}
function translateToolChoiceToResponses(choice) {
    if (choice === "auto" || choice === "none" || choice === "required")
        return choice;
    return { type: "function", name: choice.name };
}
function extractOutputText(data) {
    if (typeof data.output_text === "string" && data.output_text.length > 0)
        return data.output_text;
    const parts = [];
    for (const item of data.output ?? []) {
        if (item.type !== "message")
            continue;
        const content = item.content ?? [];
        for (const block of content) {
            if (block.type === "output_text" && typeof block.text === "string")
                parts.push(block.text);
        }
    }
    return parts.join("");
}
function extractToolCalls(data) {
    const calls = [];
    for (const item of data.output ?? []) {
        if (item.type !== "function_call")
            continue;
        const it = item;
        calls.push({
            id: String(it.call_id ?? ""),
            name: String(it.name ?? ""),
            argumentsJson: String(it.arguments ?? "{}"),
        });
    }
    return calls;
}
function clampEffort(requested, allowed, fallback) {
    if (requested && allowed.includes(requested))
        return requested;
    if (fallback && allowed.includes(fallback))
        return fallback;
    return allowed[allowed.length - 1] ?? "high";
}
function openaiEffort(level) {
    // OpenAI Responses API accepts: minimal | low | medium | high.
    // v2's xhigh / max collapse to 'high' on the wire (ADR-148 wire mapping).
    switch (level) {
        case "low":
            return "low";
        case "medium":
            return "medium";
        case "high":
        case "xhigh":
        case "max":
            return "high";
    }
}
//# sourceMappingURL=openai-responses-adapter.js.map