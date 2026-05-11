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

import type { ProviderAdapter, ProviderConfig } from "./adapter";
import type {
  ModelDescriptor,
  ProviderProfile,
} from "./profile";
import {
  OllamaAdapter,
  OLLAMA_DEFAULT_BASE_URL,
  discoverOllamaModels,
} from "./transports/ollama-adapter";

const OLLAMA_DEFAULT_MODEL: ModelDescriptor = {
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
    notes:
      "ADR-145 flagship default. Slice 2 placeholder; Slice 3+ replaces this " +
      "single-entry list with real /api/tags discovery.",
  },
};

export const ollamaProfile: ProviderProfile = {
  id: "ollama",
  displayName: "Ollama",
  modelSource: "discovery",
  defaultModelId: OLLAMA_DEFAULT_MODEL.id, // ADR-145 lock
  async listModels(): Promise<ModelDescriptor[]> {
    // Real /api/tags discovery against the configured base URL. Falls back
    // to the locked default if the server is unreachable so the registry
    // always resolves.
    return discoverOllamaModels(
      { baseUrl: OLLAMA_DEFAULT_BASE_URL },
      [OLLAMA_DEFAULT_MODEL],
      {
        capabilitiesTemplate: OLLAMA_DEFAULT_MODEL,
        defaultContextWindow: OLLAMA_DEFAULT_MODEL.contextWindow,
      },
    );
  },
  createAdapter(model: ModelDescriptor, config: ProviderConfig): ProviderAdapter {
    return new OllamaAdapter(model, config);
  },
};
