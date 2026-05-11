"use strict";
// architect-v2/providers/transports/anthropic-adapter.ts
// Milestone 2 (v10.0.0 cutover) — Real Anthropic Messages API adapter.
//
// STRICT ISOLATION (ADR-140): no import from v1.
//
// Wire facts (Anthropic Messages API):
//   - POST  {baseUrl}/messages
//   - Headers: x-api-key, anthropic-version: 2023-06-01, content-type: application/json
//   - Body  : { model, max_tokens, system?, messages, tools?, thinking?, stream? }
//   - SSE events when stream === true:
//       message_start         { message:{ usage:{ input_tokens,... } } }
//       content_block_start   { index, content_block:{ type, id?, name? } }
//       content_block_delta   { index, delta:{ type:'text_delta',text }
//                                       | { type:'input_json_delta', partial_json }
//                                       | { type:'thinking_delta', thinking } }
//       content_block_stop    { index }
//       message_delta         { delta:{ stop_reason }, usage:{ output_tokens } }
//       message_stop
//
// Reasoning: when the model declares `reasoning.supported`, we attach
// `thinking: { type: 'adaptive', display: 'summarized' }` and also a
// `betas` payload via the `anthropic-beta` header for adaptive thinking.
Object.defineProperty(exports, "__esModule", { value: true });
exports.AnthropicAdapter = void 0;
const adapter_1 = require("../adapter");
const _transport_1 = require("../_transport");
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
class AnthropicAdapter {
    providerId = "anthropic";
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
            res = await fetch(`${this.baseUrl()}/messages`, {
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
        const blocks = (data.content ?? []);
        const text = blocks
            .filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join("");
        const toolCalls = blocks
            .filter((b) => b.type === "tool_use")
            .map((b) => ({
            id: b.id,
            name: b.name,
            argumentsJson: JSON.stringify(b.input ?? {}),
        }));
        const usage = {
            inputTokens: data.usage?.input_tokens,
            outputTokens: data.usage?.output_tokens,
        };
        return {
            text,
            toolCalls,
            usage,
            finishReason: mapStopReason(data.stop_reason, toolCalls.length > 0),
        };
    }
    async *stream(request) {
        const body = this.buildRequestBody(request, /* stream */ true);
        const serialized = (0, _transport_1.serializeWithBudget)(this.providerId, this.model.id, body, this.config.requestSizeLimitBytes);
        let res;
        try {
            res = await fetch(`${this.baseUrl()}/messages`, {
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
        // Per-block accumulators keyed by SSE `index`. Anthropic emits one
        // content block at a time, but multiple tool_use blocks can interleave
        // within a single message — index is the only safe key.
        const toolUseBlocks = new Map();
        let usage = {};
        let finishReason = "stop";
        try {
            for await (const frame of (0, _transport_1.readSseLines)(res)) {
                if (!frame.data)
                    continue;
                const evt = (0, _transport_1.safeJsonParse)(frame.data);
                if (!evt)
                    continue;
                switch (evt.type) {
                    case "message_start": {
                        const inputTokens = evt.message?.usage?.input_tokens;
                        if (typeof inputTokens === "number") {
                            usage = { ...usage, inputTokens };
                            yield { kind: "usage", usage };
                        }
                        break;
                    }
                    case "content_block_start": {
                        if (typeof evt.index === "number" && evt.content_block?.type === "tool_use") {
                            toolUseBlocks.set(evt.index, {
                                id: evt.content_block.id ?? "",
                                name: evt.content_block.name ?? "",
                                jsonBuf: "",
                            });
                        }
                        break;
                    }
                    case "content_block_delta": {
                        const dt = evt.delta?.type;
                        if (dt === "text_delta" && typeof evt.delta?.text === "string") {
                            yield { kind: "text", delta: evt.delta.text };
                        }
                        else if (dt === "thinking_delta" && typeof evt.delta?.thinking === "string") {
                            yield { kind: "reasoning", delta: evt.delta.thinking };
                        }
                        else if (dt === "input_json_delta" &&
                            typeof evt.index === "number" &&
                            typeof evt.delta?.partial_json === "string") {
                            const buf = toolUseBlocks.get(evt.index);
                            if (buf)
                                buf.jsonBuf += evt.delta.partial_json;
                        }
                        break;
                    }
                    case "content_block_stop": {
                        if (typeof evt.index === "number") {
                            const buf = toolUseBlocks.get(evt.index);
                            if (buf) {
                                // Empty arguments → '{}' (model emitted no input deltas).
                                const argumentsJson = buf.jsonBuf.length > 0 ? buf.jsonBuf : "{}";
                                // Sanity: ensure it parses; if not, surface a typed error
                                // so downstream cards don't try to JSON.parse garbage.
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
                                    toolUseBlocks.delete(evt.index);
                                    break;
                                }
                                yield {
                                    kind: "tool_call",
                                    call: { id: buf.id, name: buf.name, argumentsJson },
                                };
                                toolUseBlocks.delete(evt.index);
                            }
                        }
                        break;
                    }
                    case "message_delta": {
                        if (typeof evt.usage?.output_tokens === "number") {
                            usage = { ...usage, outputTokens: evt.usage.output_tokens };
                            yield { kind: "usage", usage };
                        }
                        if (typeof evt.delta?.stop_reason === "string") {
                            finishReason = mapStopReason(evt.delta.stop_reason, toolUseBlocks.size > 0);
                        }
                        break;
                    }
                    case "message_stop": {
                        yield { kind: "done", finishReason };
                        return;
                    }
                    // `ping`, `error` events handled below.
                    case "error": {
                        yield {
                            kind: "error",
                            error: new adapter_1.ProviderError({
                                kind: "transport",
                                providerId: this.providerId,
                                modelId: this.model.id,
                                message: `Anthropic SSE error frame: ${frame.data}`,
                                providerRaw: evt,
                            }),
                        };
                        return;
                    }
                    default:
                        // Ignore unknown event types (forward-compatible).
                        break;
                }
            }
            // Stream ended without a `message_stop` event — surface a done so the
            // executor can finalize, but mark it a 'length' truncation guess.
            yield { kind: "done", finishReason: finishReason === "stop" ? "length" : finishReason };
        }
        catch (err) {
            yield { kind: "error", error: (0, _transport_1.mapNetworkError)(err, this.providerId, this.model.id) };
        }
    }
    // -------------------------------------------------------------------------
    // Request shaping
    // -------------------------------------------------------------------------
    buildRequestBody(request, stream) {
        const { system, messages } = splitSystem(request.messages);
        const apiMessages = messages.map((m) => translateMessageToAnthropic(m));
        const maxTokens = Math.min(request.maxOutputTokens ?? this.model.capabilities.maxOutputTokens, this.model.capabilities.maxOutputTokens);
        const body = {
            model: this.model.id,
            max_tokens: maxTokens,
            messages: apiMessages,
        };
        if (system && system.length > 0)
            body.system = system;
        if (stream)
            body.stream = true;
        if (request.tools && request.tools.length > 0) {
            body.tools = request.tools.map((t) => translateToolToAnthropic(t));
            if (request.toolChoice)
                body.tool_choice = translateToolChoiceToAnthropic(request.toolChoice);
        }
        const reasoning = this.model.capabilities.reasoning;
        if (reasoning.supported) {
            body.thinking = { type: "adaptive", display: "summarized" };
        }
        return body;
    }
    headers() {
        if (!this.config.apiKey || this.config.apiKey.length === 0) {
            throw new adapter_1.ProviderError({
                kind: "auth",
                providerId: this.providerId,
                modelId: this.model.id,
                message: "Anthropic API key not configured",
            });
        }
        return {
            "Content-Type": "application/json",
            "x-api-key": this.config.apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
        };
    }
    baseUrl() {
        return (this.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    }
}
exports.AnthropicAdapter = AnthropicAdapter;
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function splitSystem(messages) {
    const sys = [];
    const rest = [];
    for (const m of messages) {
        if (m.role === "system")
            sys.push(m.content);
        else
            rest.push(m);
    }
    return { system: sys.join("\n\n"), messages: rest };
}
function translateMessageToAnthropic(m) {
    if (m.role === "tool") {
        return {
            role: "user",
            content: [
                {
                    type: "tool_result",
                    tool_use_id: m.toolCallId ?? "",
                    content: m.content,
                },
            ],
        };
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        const blocks = [];
        if (m.content && m.content.length > 0) {
            blocks.push({ type: "text", text: m.content });
        }
        for (const tc of m.toolCalls) {
            let input = {};
            try {
                input = JSON.parse(tc.argumentsJson || "{}");
            }
            catch {
                input = {};
            }
            blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input });
        }
        return { role: "assistant", content: blocks };
    }
    return { role: m.role === "assistant" ? "assistant" : "user", content: m.content };
}
function translateToolToAnthropic(t) {
    return {
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
    };
}
function translateToolChoiceToAnthropic(choice) {
    if (choice === "auto")
        return { type: "auto" };
    if (choice === "required")
        return { type: "any" };
    if (choice === "none")
        return { type: "auto" }; // Anthropic has no direct 'none'; closest is 'auto'.
    return { type: "tool", name: choice.name };
}
function mapStopReason(raw, hasToolCalls) {
    switch (raw) {
        case "end_turn":
        case "stop_sequence":
            return hasToolCalls ? "tool_calls" : "stop";
        case "tool_use":
            return "tool_calls";
        case "max_tokens":
            return "length";
        case undefined:
            return hasToolCalls ? "tool_calls" : "stop";
        default:
            return "stop";
    }
}
//# sourceMappingURL=anthropic-adapter.js.map