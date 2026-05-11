"use strict";
// architect-v2/providers/transports/openai-chat-adapter.ts
// Milestone 2 (v10.0.0 cutover) — Real OpenAI Chat Completions adapter.
//
// STRICT ISOLATION (ADR-140): no import from v1.
//
// Wire facts (OpenAI Chat Completions):
//   - POST  {baseUrl}/chat/completions
//   - Headers: Authorization: Bearer <key>, Content-Type: application/json
//   - SSE frames carry { choices:[ { delta:{ content?, tool_calls?:[...] },
//                                    finish_reason? } ], usage? }
//   - Frame `data: [DONE]` terminates the stream.
//   - Tool calls stream as partial JSON in `delta.tool_calls[i].function.arguments`
//     and MUST be reassembled per-index across frames.
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenAIChatAdapter = void 0;
const adapter_1 = require("../adapter");
const _transport_1 = require("../_transport");
class OpenAIChatAdapter {
    providerId = "openai";
    model;
    config;
    defaultBaseUrl;
    authHeaderRequired;
    constructor(model, config, options) {
        this.model = model;
        this.config = config;
        this.defaultBaseUrl = options?.defaultBaseUrl ?? "https://api.openai.com/v1";
        this.authHeaderRequired = options?.authHeaderRequired ?? true;
    }
    async callWithTools(request) {
        const body = this.buildRequestBody(request, /* stream */ false);
        const serialized = (0, _transport_1.serializeWithBudget)(this.providerId, this.model.id, body, this.config.requestSizeLimitBytes);
        let res;
        try {
            res = await fetch(`${this.baseUrl()}/chat/completions`, {
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
        const choice = data.choices?.[0];
        const text = choice?.message?.content ?? "";
        const toolCalls = (choice?.message?.tool_calls ?? []).map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            argumentsJson: tc.function.arguments ?? "{}",
        }));
        return {
            text,
            toolCalls,
            usage: {
                inputTokens: data.usage?.prompt_tokens,
                outputTokens: data.usage?.completion_tokens,
            },
            finishReason: mapFinishReason(choice?.finish_reason, toolCalls.length > 0),
        };
    }
    async *stream(request) {
        const body = this.buildRequestBody(request, /* stream */ true);
        const serialized = (0, _transport_1.serializeWithBudget)(this.providerId, this.model.id, body, this.config.requestSizeLimitBytes);
        let res;
        try {
            res = await fetch(`${this.baseUrl()}/chat/completions`, {
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
        const toolCallBuffers = new Map();
        let finishReason = "stop";
        let usage;
        try {
            for await (const frame of (0, _transport_1.readSseLines)(res)) {
                if (!frame.data || frame.data === "[DONE]") {
                    if (frame.data === "[DONE]")
                        break;
                    continue;
                }
                const evt = (0, _transport_1.safeJsonParse)(frame.data);
                if (!evt)
                    continue;
                const choice = evt.choices?.[0];
                if (choice?.delta?.content) {
                    yield { kind: "text", delta: choice.delta.content };
                }
                if (choice?.delta?.tool_calls) {
                    for (const part of choice.delta.tool_calls) {
                        const idx = part.index ?? 0;
                        let buf = toolCallBuffers.get(idx);
                        if (!buf) {
                            buf = { id: part.id ?? "", name: part.function?.name ?? "", argsBuf: "" };
                            toolCallBuffers.set(idx, buf);
                        }
                        if (part.id)
                            buf.id = part.id;
                        if (part.function?.name)
                            buf.name = part.function.name;
                        if (part.function?.arguments)
                            buf.argsBuf += part.function.arguments;
                    }
                }
                if (choice?.finish_reason) {
                    finishReason = mapFinishReason(choice.finish_reason, toolCallBuffers.size > 0);
                }
                if (evt.usage) {
                    usage = {
                        inputTokens: evt.usage.prompt_tokens,
                        outputTokens: evt.usage.completion_tokens,
                    };
                }
            }
            // Flush any reassembled tool calls.
            for (const [, buf] of toolCallBuffers) {
                const argumentsJson = buf.argsBuf.length > 0 ? buf.argsBuf : "{}";
                if ((0, _transport_1.safeJsonParse)(argumentsJson) === undefined) {
                    yield {
                        kind: "error",
                        error: new adapter_1.ProviderError({
                            kind: "tool_call_malformed",
                            providerId: this.providerId,
                            modelId: this.model.id,
                            message: `Tool call ${buf.name} (id=${buf.id}) emitted invalid JSON arguments`,
                            providerRaw: argumentsJson,
                        }),
                    };
                    return;
                }
                yield {
                    kind: "tool_call",
                    call: { id: buf.id, name: buf.name, argumentsJson },
                };
            }
            if (usage)
                yield { kind: "usage", usage };
            yield { kind: "done", finishReason };
        }
        catch (err) {
            yield { kind: "error", error: (0, _transport_1.mapNetworkError)(err, this.providerId, this.model.id) };
        }
    }
    // -------------------------------------------------------------------------
    buildRequestBody(request, stream) {
        const messages = request.messages.map((m) => translateMessageToOpenAI(m));
        const body = {
            model: this.model.id,
            messages,
            max_completion_tokens: Math.min(request.maxOutputTokens ?? this.model.capabilities.maxOutputTokens, this.model.capabilities.maxOutputTokens),
        };
        if (stream) {
            body.stream = true;
            body.stream_options = { include_usage: true };
        }
        if (request.tools && request.tools.length > 0) {
            body.tools = request.tools.map((t) => translateToolToOpenAI(t));
            if (request.toolChoice)
                body.tool_choice = translateToolChoiceToOpenAI(request.toolChoice);
        }
        return body;
    }
    headers() {
        const h = { "Content-Type": "application/json" };
        if (this.authHeaderRequired) {
            if (!this.config.apiKey || this.config.apiKey.length === 0) {
                throw new adapter_1.ProviderError({
                    kind: "auth",
                    providerId: this.providerId,
                    modelId: this.model.id,
                    message: `${this.providerId} API key not configured`,
                });
            }
            h.Authorization = `Bearer ${this.config.apiKey}`;
        }
        else if (this.config.apiKey && this.config.apiKey.length > 0) {
            // Local providers may still accept (and ignore) the header; pass it
            // through if the user supplied one, since some proxies enforce it.
            h.Authorization = `Bearer ${this.config.apiKey}`;
        }
        return h;
    }
    baseUrl() {
        return (this.config.baseUrl ?? this.defaultBaseUrl).replace(/\/+$/, "");
    }
}
exports.OpenAIChatAdapter = OpenAIChatAdapter;
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function translateMessageToOpenAI(m) {
    if (m.role === "tool") {
        return {
            role: "tool",
            tool_call_id: m.toolCallId ?? "",
            content: m.content,
        };
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        return {
            role: "assistant",
            content: m.content || null,
            tool_calls: m.toolCalls.map((tc) => ({
                id: tc.id,
                type: "function",
                function: { name: tc.name, arguments: tc.argumentsJson || "{}" },
            })),
        };
    }
    return { role: m.role, content: m.content };
}
function translateToolToOpenAI(t) {
    return {
        type: "function",
        function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
        },
    };
}
function translateToolChoiceToOpenAI(choice) {
    if (choice === "auto" || choice === "none" || choice === "required")
        return choice;
    return { type: "function", function: { name: choice.name } };
}
function mapFinishReason(raw, hasToolCalls) {
    switch (raw) {
        case "stop":
            return hasToolCalls ? "tool_calls" : "stop";
        case "length":
            return "length";
        case "tool_calls":
        case "function_call":
            return "tool_calls";
        case "content_filter":
            return "content_filter";
        case null:
        case undefined:
        case "":
            return hasToolCalls ? "tool_calls" : "stop";
        default:
            return "stop";
    }
}
//# sourceMappingURL=openai-chat-adapter.js.map