"use strict";
// architect-v2/providers/registry.ts
// Slice 2 — Provider registry façade.
//
// STRICT ISOLATION (ADR-140): no import from v1.
//
// One source of truth for "what providers exist?" The orchestrator never
// hardcodes provider ids; it asks the registry. The registry is initialized
// once at extension activation and is otherwise read-only.
Object.defineProperty(exports, "__esModule", { value: true });
exports.UnknownModelError = void 0;
exports.listProviders = listProviders;
exports.getProvider = getProvider;
exports.hasProvider = hasProvider;
exports.resolveDefaultModel = resolveDefaultModel;
exports.resolveModel = resolveModel;
exports.listModelIds = listModelIds;
const anthropic_1 = require("./anthropic");
const lmstudio_1 = require("./lmstudio");
const ollama_1 = require("./ollama");
const openai_1 = require("./openai");
const REGISTRY = new Map([
    [openai_1.openaiProfile.id, openai_1.openaiProfile],
    [anthropic_1.anthropicProfile.id, anthropic_1.anthropicProfile],
    [lmstudio_1.lmstudioProfile.id, lmstudio_1.lmstudioProfile],
    [ollama_1.ollamaProfile.id, ollama_1.ollamaProfile],
]);
function listProviders() {
    return Array.from(REGISTRY.values());
}
function getProvider(id) {
    const profile = REGISTRY.get(id);
    if (!profile) {
        // Closed enum + frozen registry — this is unreachable at runtime, but
        // typed-narrow for callers.
        throw new Error(`Unknown provider id: ${id}`);
    }
    return profile;
}
function hasProvider(id) {
    return REGISTRY.has(id);
}
/**
 * Resolves a provider's default model descriptor by listing models and
 * picking the one whose id matches `defaultModelId`. Throws if not found
 * (which would indicate a registry bug, since defaults are locked by
 * ADR-145 and ADR-150).
 */
async function resolveDefaultModel(id) {
    const provider = getProvider(id);
    const models = await provider.listModels();
    const model = models.find((m) => m.id === provider.defaultModelId);
    if (!model) {
        throw new Error(`Provider '${id}' default model '${provider.defaultModelId}' not found in listModels() result. ` +
            `Check ADR-145 / ADR-150 against the provider profile.`);
    }
    return { provider, model };
}
/**
 * Typed error raised when the host is asked to resolve a model id
 * that the selected provider does not advertise. The chat panel
 * surfaces this as a structured error card rather than a raw stack.
 */
class UnknownModelError extends Error {
    providerId;
    modelId;
    availableModelIds;
    constructor(providerId, modelId, availableModelIds) {
        super(`Provider '${providerId}' does not advertise model '${modelId}'. ` +
            `Available: ${availableModelIds.join(", ") || "(none)"}.`);
        this.name = "UnknownModelError";
        this.providerId = providerId;
        this.modelId = modelId;
        this.availableModelIds = availableModelIds;
    }
}
exports.UnknownModelError = UnknownModelError;
/**
 * Resolves an explicit `(providerId, modelId)` pair. When `modelId` is
 * omitted or matches the provider default this delegates to
 * `resolveDefaultModel`. When the id is unknown a typed
 * `UnknownModelError` is thrown so callers can surface a structured
 * provider-config error card.
 */
async function resolveModel(id, modelId) {
    const provider = getProvider(id);
    if (!modelId || modelId === provider.defaultModelId) {
        return resolveDefaultModel(id);
    }
    const models = await provider.listModels();
    const model = models.find((m) => m.id === modelId);
    if (!model) {
        throw new UnknownModelError(id, modelId, models.map((m) => m.id));
    }
    return { provider, model };
}
/**
 * Lists model ids advertised by a provider. Convenience for hosts that
 * want to populate a model picker without resolving each descriptor.
 */
async function listModelIds(id) {
    const provider = getProvider(id);
    const models = await provider.listModels();
    return models.map((m) => m.id);
}
//# sourceMappingURL=registry.js.map