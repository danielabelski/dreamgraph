"use strict";
// architect-v2/providers/transports/ollama-adapter.ts
// Milestone 2 (v10.0.0 cutover) — Ollama adapter.
//
// STRICT ISOLATION (ADR-140): no import from v1.
//
// Wire facts (Ollama):
//   - POST {baseUrl}/api/chat
//     Body: { model, messages:[{role,content,tool_calls?}], stream?:bool,
//             tools?:[ { type:'function', function:{ name, description, parameters } } ],
//             options?:{ num_predict?, num_ctx? } }
//     Streaming response: NDJSON; each line is
//       { model, created_at, message:{role,content,tool_calls?},
//         done:bool, done_reason?, prompt_eval_count?, eval_count? }
//   - GET  {baseUrl}/api/tags  → { models:[{name, size?, details?{...}}] }
// Default baseUrl is http://localhost:11434.
Object.defineProperty(exports, "__esModule", { value: true });
exports.OllamaAdapter = exports.OLLAMA_DEFAULT_BASE_URL = void 0;
exports.discoverOllamaModels = discoverOllamaModels;
const adapter_1 = require("../adapter");
const _transport_1 = require("../_transport");
exports.OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434";
class OllamaAdapter {
    providerId = "ollama";
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
            res = await fetch(`${this.baseUrl()}/api/chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
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
        const text = data.message?.content ?? "";
        const toolCalls = mapOllamaToolCalls(data.message?.tool_calls);
        return {
            text,
            toolCalls,
            usage: {
                inputTokens: data.prompt_eval_count,
                outputTokens: data.eval_count,
            },
            finishReason: mapDoneReason(data.done_reason, toolCalls.length > 0),
        };
    }
    async *stream(request) {
        const body = this.buildRequestBody(request, /* stream */ true);
        const serialized = (0, _transport_1.serializeWithBudget)(this.providerId, this.model.id, body, this.config.requestSizeLimitBytes);
        let res;
        try {
            res = await fetch(`${this.baseUrl()}/api/chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
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
        try {
            for await (const line of (0, _transport_1.readNdjsonLines)(res)) {
                const evt = (0, _transport_1.safeJsonParse)(line);
                if (!evt)
                    continue;
                if (typeof evt.message?.content === "string" && evt.message.content.length > 0) {
                    yield { kind: "text", delta: evt.message.content };
                }
                const toolCalls = mapOllamaToolCalls(evt.message?.tool_calls);
                for (const call of toolCalls) {
                    if ((0, _transport_1.safeJsonParse)(call.argumentsJson) === undefined) {
                        yield {
                            kind: "error",
                            error: new adapter_1.ProviderError({
                                kind: "tool_call_malformed",
                                providerId: this.providerId,
                                modelId: this.model.id,
                                message: `Tool call ${call.name} emitted invalid JSON arguments`,
                                providerRaw: call.argumentsJson,
                            }),
                        };
                        return;
                    }
                    yield { kind: "tool_call", call };
                }
                if (evt.done) {
                    if (typeof evt.prompt_eval_count === "number" || typeof evt.eval_count === "number") {
                        usage = {
                            inputTokens: evt.prompt_eval_count,
                            outputTokens: evt.eval_count,
                        };
                        yield { kind: "usage", usage };
                    }
                    finishReason = mapDoneReason(evt.done_reason, toolCalls.length > 0);
                    yield { kind: "done", finishReason };
                    return;
                }
            }
            yield { kind: "done", finishReason };
        }
        catch (err) {
            yield { kind: "error", error: (0, _transport_1.mapNetworkError)(err, this.providerId, this.model.id) };
        }
    }
    // -------------------------------------------------------------------------
    buildRequestBody(request, stream) {
        const messages = request.messages.map((m) => translateMessageToOllama(m));
        const body = {
            model: this.model.id,
            messages,
            stream,
            options: {
                num_predict: Math.min(request.maxOutputTokens ?? this.model.capabilities.maxOutputTokens, this.model.capabilities.maxOutputTokens),
            },
        };
        if (request.tools && request.tools.length > 0) {
            body.tools = request.tools.map((t) => translateToolToOllama(t));
        }
        return body;
    }
    baseUrl() {
        return (this.config.baseUrl ?? exports.OLLAMA_DEFAULT_BASE_URL).replace(/\/+$/, "");
    }
}
exports.OllamaAdapter = OllamaAdapter;
async function discoverOllamaModels(config, fallbackModels, defaults) {
    const baseUrl = (config.baseUrl ?? exports.OLLAMA_DEFAULT_BASE_URL).replace(/\/+$/, "");
    let res;
    try {
        res = await fetch(`${baseUrl}/api/tags`, {
            method: "GET",
            headers: { Accept: "application/json" },
        });
    }
    catch {
        return fallbackModels.slice();
    }
    if (!res.ok)
        return fallbackModels.slice();
    const json = (await res.json().catch(() => undefined));
    const tags = json?.models;
    if (!Array.isArray(tags) || tags.length === 0)
        return fallbackModels.slice();
    return tags
        .filter((t) => typeof t.name === "string" && t.name.length > 0)
        .map((t) => ({
        id: t.name,
        displayName: t.name,
        contextWindow: defaults.defaultContextWindow,
        capabilities: defaults.capabilitiesTemplate.capabilities,
    }));
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function translateMessageToOllama(m) {
    if (m.role === "tool") {
        return {
            role: "tool",
            content: m.content,
        };
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        return {
            role: "assistant",
            content: m.content || "",
            tool_calls: m.toolCalls.map((tc) => ({
                function: {
                    name: tc.name,
                    arguments: (0, _transport_1.safeJsonParse)(tc.argumentsJson) ?? {},
                },
            })),
        };
    }
    return { role: m.role, content: m.content };
}
function translateToolToOllama(t) {
    return {
        type: "function",
        function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
        },
    };
}
function mapOllamaToolCalls(raw) {
    if (!raw || raw.length === 0)
        return [];
    return raw
        .map((r, i) => {
        const name = r.function?.name ?? "";
        const args = r.function?.arguments;
        const argsJson = typeof args === "string" ? args : JSON.stringify(args ?? {});
        // Ollama doesn't return ids; synthesize a stable per-turn one so
        // downstream tool_result messages can correlate.
        return { id: `ollama-${i}`, name, argumentsJson: argsJson };
    })
        .filter((c) => c.name.length > 0);
}
function mapDoneReason(raw, hasToolCalls) {
    switch (raw) {
        case "stop":
            return hasToolCalls ? "tool_calls" : "stop";
        case "length":
            return "length";
        default:
            return hasToolCalls ? "tool_calls" : "stop";
    }
}
//# sourceMappingURL=ollama-adapter.js.map