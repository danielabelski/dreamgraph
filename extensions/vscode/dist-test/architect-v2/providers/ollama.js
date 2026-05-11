"use strict";
// architect-v2/providers/ollama.ts
// Slice 2 — Ollama provider profile (runtime discovery).
//
// STRICT ISOLATION (ADR-140): no import from v1.
//
// Per ADR-149 the model list is discovered at runtime from the Ollama
// `/api/tags` endpoint. Slice 2 ships the discovery seam only; Slice 3+
// supplies the real fetch + caching. The Slice 2 listModels() returns a
// single-entry list containing the locked default so the registry is
// wireable without network.
//
// Default model (ADR-145): qwen2.5-coder:32b.
Object.defineProperty(exports, "__esModule", { value: true });
exports.ollamaProfile = void 0;
const ollama_adapter_1 = require("./transports/ollama-adapter");
const OLLAMA_DEFAULT_MODEL = {
    id: "qwen2.5-coder:32b",
    displayName: "Qwen 2.5 Coder 32B (Ollama)",
    contextWindow: 32_768,
    capabilities: {
        api: "ollama-chat",
        streaming: true,
        toolCallShape: "openai",
        attachments: { text: true, image: false, pdf: false },
        reasoning: {
            supported: false,
            effortLevels: [],
        },
        maxOutputTokens: 4_096,
        notes: "ADR-145 flagship default. Slice 2 placeholder; Slice 3+ replaces this " +
            "single-entry list with real /api/tags discovery.",
    },
};
exports.ollamaProfile = {
    id: "ollama",
    displayName: "Ollama",
    modelSource: "discovery",
    defaultModelId: OLLAMA_DEFAULT_MODEL.id, // ADR-145 lock
    async listModels() {
        // Real /api/tags discovery against the configured base URL. Falls back
        // to the locked default if the server is unreachable so the registry
        // always resolves.
        return (0, ollama_adapter_1.discoverOllamaModels)({ baseUrl: ollama_adapter_1.OLLAMA_DEFAULT_BASE_URL }, [OLLAMA_DEFAULT_MODEL], {
            capabilitiesTemplate: OLLAMA_DEFAULT_MODEL,
            defaultContextWindow: OLLAMA_DEFAULT_MODEL.contextWindow,
        });
    },
    createAdapter(model, config) {
        return new ollama_adapter_1.OllamaAdapter(model, config);
    },
};
//# sourceMappingURL=ollama.js.map