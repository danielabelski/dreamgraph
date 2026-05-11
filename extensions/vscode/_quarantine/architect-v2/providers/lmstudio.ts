// architect-v2/providers/lmstudio.ts
// Slice 2 — LM Studio provider profile (runtime discovery).
//
// STRICT ISOLATION (ADR-140): no import from v1.
//
// Per ADR-149 the model list is discovered at runtime from the LM Studio
// OpenAI-compatible `/v1/models` endpoint. Slice 2 ships the discovery seam
// only; Slice 3+ supplies the real fetch + caching. The Slice 2 listModels()
// returns a single-entry list containing the locked default so the registry
// is wireable without network.
//
// Default model (ADR-145): gpt-oss-120b high-context.

import type { ProviderAdapter, ProviderConfig } from "./adapter";
import type {
  ModelDescriptor,
  ProviderProfile,
} from "./profile";
import {
  LMStudioAdapter,
  LMSTUDIO_DEFAULT_BASE_URL,
  discoverLmStudioModels,
} from "./transports/lmstudio-adapter";

const LMSTUDIO_DEFAULT_MODEL: ModelDescriptor = {
  id: "gpt-oss-120b",
  displayName: "gpt-oss-120b (LM Studio, high context)",
  contextWindow: 128_000,
  capabilities: {
    api: "lmstudio-openai-compat",
    streaming: true,
    toolCallShape: "openai",
    attachments: { text: true, image: false, pdf: false },
    reasoning: {
      supported: false,
      effortLevels: [],
    },
    maxOutputTokens: 8_192,
    notes:
      "ADR-145 flagship default. Slice 2 placeholder; Slice 3+ replaces this " +
      "single-entry list with real /v1/models discovery.",
  },
};

export const lmstudioProfile: ProviderProfile = {
  id: "lmstudio",
  displayName: "LM Studio",
  modelSource: "discovery",
  defaultModelId: LMSTUDIO_DEFAULT_MODEL.id, // ADR-145 lock
  async listModels(): Promise<ModelDescriptor[]> {
    // Real /v1/models discovery against the configured base URL. Falls back
    // to the locked default if the server is unreachable so the registry
    // always resolves.
    return discoverLmStudioModels(
      { baseUrl: LMSTUDIO_DEFAULT_BASE_URL },
      [LMSTUDIO_DEFAULT_MODEL],
      {
        capabilitiesTemplate: LMSTUDIO_DEFAULT_MODEL,
        defaultContextWindow: LMSTUDIO_DEFAULT_MODEL.contextWindow,
      },
    );
  },
  createAdapter(model: ModelDescriptor, config: ProviderConfig): ProviderAdapter {
    return new LMStudioAdapter(model, config);
  },
};
