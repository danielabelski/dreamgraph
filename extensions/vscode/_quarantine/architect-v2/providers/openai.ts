// architect-v2/providers/openai.ts
// Slice 2 — OpenAI provider profile (static model list).
//
// STRICT ISOLATION (ADR-140): no import from v1.
//
// Per ADR-148: ONE `openai` provider entry. Each model declares its own
// `capabilities.api` so the orchestrator routes to the correct wire format
// (Chat Completions vs Responses API) based on the chosen model, not on a
// separate provider id.
//
// Defaults (ADR-150):
//   - Flagship       : gpt-5.5 via Responses API.
//   - Equal-class #2 : gpt-5.4 via Chat Completions (previous API).

import type { ProviderAdapter, ProviderConfig } from "./adapter";
import type {
  ModelDescriptor,
  ProviderProfile,
} from "./profile";
import { OpenAIChatAdapter } from "./transports/openai-chat-adapter";
import { OpenAIResponsesAdapter } from "./transports/openai-responses-adapter";

const OPENAI_MODELS: readonly ModelDescriptor[] = [
  {
    id: "gpt-5.5",
    displayName: "GPT-5.5 (Responses API)",
    contextWindow: 400_000,
    capabilities: {
      api: "openai-responses",
      streaming: true,
      toolCallShape: "openai",
      attachments: { text: true, image: true, pdf: true },
      reasoning: {
        supported: true,
        effortLevels: ["low", "medium", "high", "xhigh", "max"],
        defaultEffort: "high",
      },
      maxOutputTokens: 32_768,
      notes:
        "Responses API: stores reasoning state server-side; encrypted_content " +
        "round-trip required across turns. ADR-148 routing.",
    },
  },
  {
    id: "gpt-5.4",
    displayName: "GPT-5.4 (Chat Completions)",
    contextWindow: 256_000,
    capabilities: {
      api: "openai-chat-completions",
      streaming: true,
      toolCallShape: "openai",
      attachments: { text: true, image: true, pdf: false },
      reasoning: {
        supported: false,
        effortLevels: [],
      },
      maxOutputTokens: 16_384,
      notes:
        "Equal-class #2 default per ADR-150. Standard Chat Completions tool " +
        "envelope; no reasoning round-trip.",
    },
  },
] as const;

export const openaiProfile: ProviderProfile = {
  id: "openai",
  displayName: "OpenAI",
  modelSource: "static",
  defaultModelId: "gpt-5.5", // ADR-150 flagship
  async listModels(): Promise<ModelDescriptor[]> {
    return OPENAI_MODELS.slice();
  },
  createAdapter(model: ModelDescriptor, config: ProviderConfig): ProviderAdapter {
    // ADR-148: route on per-model `capabilities.api`, not on provider id.
    if (model.capabilities.api === "openai-responses") {
      return new OpenAIResponsesAdapter(model, config);
    }
    return new OpenAIChatAdapter(model, config);
  },
};
