"use strict";
// architect-v2/providers/transports/lmstudio-adapter.ts
// Milestone 2 (v10.0.0 cutover) — LM Studio adapter.
//
// STRICT ISOLATION (ADR-140): no import from v1.
//
// LM Studio exposes an OpenAI-compatible /v1 surface:
//   - POST {baseUrl}/chat/completions   (same wire as OpenAI Chat Completions)
//   - GET  {baseUrl}/models             (model discovery; no auth required)
// Default baseUrl is http://localhost:1234/v1.
//
// We reuse OpenAIChatAdapter as the wire implementation but rebrand the
// providerId to 'lmstudio' for typed errors and discovery telemetry.
Object.defineProperty(exports, "__esModule", { value: true });
exports.mapLmStudioHttpError = exports.LMStudioAdapter = exports.LMSTUDIO_DEFAULT_BASE_URL = void 0;
exports.discoverLmStudioModels = discoverLmStudioModels;
const adapter_1 = require("../adapter");
const _transport_1 = require("../_transport");
Object.defineProperty(exports, "mapLmStudioHttpError", { enumerable: true, get: function () { return _transport_1.mapHttpError; } });
const openai_chat_adapter_1 = require("./openai-chat-adapter");
exports.LMSTUDIO_DEFAULT_BASE_URL = "http://localhost:1234/v1";
class LMStudioAdapter {
    providerId = "lmstudio";
    model;
    inner;
    constructor(model, config) {
        this.model = model;
        // Inner adapter does the wire work but reports as 'openai'; we rewrap
        // its errors in stream/callWithTools so the providerId is 'lmstudio'.
        this.inner = new openai_chat_adapter_1.OpenAIChatAdapter(model, config, {
            defaultBaseUrl: exports.LMSTUDIO_DEFAULT_BASE_URL,
            authHeaderRequired: false,
        });
    }
    async callWithTools(request) {
        try {
            return await this.inner.callWithTools(request);
        }
        catch (err) {
            throw rebrandError(err, this.providerId, this.model.id);
        }
    }
    async *stream(request) {
        for await (const evt of this.inner.stream(request)) {
            if (evt.kind === "error") {
                yield {
                    kind: "error",
                    error: rebrandError(evt.error, this.providerId, this.model.id),
                };
                return;
            }
            yield evt;
        }
    }
}
exports.LMStudioAdapter = LMStudioAdapter;
/**
 * Calls LM Studio's `/models` endpoint and returns the discovered model ids
 * lifted into v2 ModelDescriptors. Unknown context windows fall back to
 * `defaultContextWindow`.
 *
 * On any failure (server down, parse error) returns the supplied
 * `fallbackModels` so the registry still resolves.
 */
async function discoverLmStudioModels(config, fallbackModels, defaults) {
    const baseUrl = (config.baseUrl ?? exports.LMSTUDIO_DEFAULT_BASE_URL).replace(/\/+$/, "");
    let res;
    try {
        res = await fetch(`${baseUrl}/models`, {
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
    const entries = json?.data;
    if (!Array.isArray(entries) || entries.length === 0)
        return fallbackModels.slice();
    const tpl = defaults.capabilitiesTemplate;
    return entries
        .filter((e) => typeof e.id === "string" && e.id.length > 0)
        .map((e) => ({
        id: e.id,
        displayName: e.id,
        contextWindow: typeof e.context_length === "number" && e.context_length > 0
            ? e.context_length
            : defaults.defaultContextWindow,
        capabilities: tpl.capabilities,
    }));
}
// ---------------------------------------------------------------------------
function rebrandError(err, providerId, modelId) {
    if (err instanceof adapter_1.ProviderError) {
        return new adapter_1.ProviderError({
            kind: err.kind,
            providerId,
            modelId,
            message: err.message,
            retryable: err.retryable,
            providerRaw: err.providerRaw,
        });
    }
    return (0, _transport_1.mapNetworkError)(err, providerId, modelId);
}
//# sourceMappingURL=lmstudio-adapter.js.map