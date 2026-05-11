import type { ProviderAdapter, ProviderConfig } from "./adapter";
/**
 * Closed enumeration of providers v2 supports.
 *
 * (Preserved concept from v1 `ArchitectProvider` — but collapsed: v1's two
 * parallel OpenAI paths are unified into a single `'openai'` entry per ADR-148;
 * the per-model `capabilities.api` discriminator routes to Chat Completions
 * vs Responses API at request time.)
 */
export type ProviderId = "openai" | "anthropic" | "lmstudio" | "ollama";
/**
 * Reasoning effort scale exposed by reasoning-capable models.
 *
 * (Preserved concept from v1 `AnthropicEffort` — generalized so OpenAI
 * Responses API reasoning levels can map onto the same scale. Not all models
 * support all levels; `ModelCapabilities.reasoning.effortLevels` declares
 * which apply.)
 */
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
/**
 * The wire format an adapter uses to talk to a model.
 *
 * Per ADR-148 the orchestrator MUST NOT branch on provider id when picking a
 * wire format — it branches on this discriminator on the chosen model. That is
 * how `gpt-5.5` (responses) and `gpt-5.4` (chat) coexist under one `openai`
 * provider entry.
 */
export type ModelApi = "openai-chat-completions" | "openai-responses" | "anthropic-messages" | "ollama-chat" | "lmstudio-openai-compat";
/**
 * The JSON envelope shape a model emits when it wants to call a tool.
 * Adapters translate to/from this on the wire; the orchestrator only sees
 * the canonical v2 `ToolCall` shape.
 *
 * (Preserved concept from v1 — but in v1 the translation was scattered across
 * `architect-llm.ts` and `openai-responses-adapter.ts`. Here it is declarative.)
 */
export type ToolCallShape = "openai" | "anthropic" | "none";
/**
 * Per-modality attachment support flags.
 * (Preserved concept from v1 `getModelCapabilities().textAttachments` — but
 * widened from a single boolean to per-modality so image/PDF support is
 * declarative, not hardcoded.)
 */
export interface AttachmentSupport {
    text: boolean;
    image: boolean;
    pdf: boolean;
}
export interface ReasoningSupport {
    supported: boolean;
    /** Subset of `ReasoningEffort` this model accepts. Empty if not supported. */
    effortLevels: ReasoningEffort[];
    /** Default effort applied when the request omits one. */
    defaultEffort?: ReasoningEffort;
}
/**
 * Everything the orchestrator needs to know about a model without asking
 * its provider. Capability flags drive routing, request shaping, and budget
 * calculations. No capability is inferred from the model id string at runtime.
 */
export interface ModelCapabilities {
    api: ModelApi;
    streaming: boolean;
    toolCallShape: ToolCallShape;
    attachments: AttachmentSupport;
    reasoning: ReasoningSupport;
    /** Maximum output tokens the model accepts. */
    maxOutputTokens: number;
    /** Free-form notes for humans. Never parsed by code. */
    notes?: string;
}
/**
 * One entry in a provider's model list.
 *
 * (Preserved concept from v1 `ANTHROPIC_MODELS` / `OPENAI_MODELS` const arrays —
 * but lifted out of the LLM client into a typed registry record so the model
 * list can come from either a static const table (cloud) or runtime discovery
 * (local), per ADR-149.)
 */
export interface ModelDescriptor {
    id: string;
    displayName: string;
    /** Total context window in tokens. */
    contextWindow: number;
    capabilities: ModelCapabilities;
}
/**
 * Where a provider's model list comes from.
 *
 * Per ADR-149:
 *   - 'static'     — TS const table shipped with the extension (Anthropic, OpenAI).
 *   - 'discovery'  — runtime call to the provider's discovery endpoint
 *                    (LM Studio `/v1/models`, Ollama `/api/tags`).
 */
export type ModelSource = "static" | "discovery";
/**
 * The full provider profile. Registered once per provider in
 * `providers/registry.ts`.
 *
 * (Preserved concept from v1 — provider abstraction lived as switch statements
 * inside `ArchitectLlm`. Here it is one record per provider with a uniform
 * shape, so adding a fifth provider is a registry call, not a switch-case
 * surgery in the LLM client.)
 */
export interface ProviderProfile {
    id: ProviderId;
    displayName: string;
    modelSource: ModelSource;
    /** Required: every provider must declare a default model id (ADR-145, ADR-150). */
    defaultModelId: string;
    /**
     * Returns the current model list. For `modelSource === 'static'` this is
     * synchronous-equivalent (resolves instantly). For `'discovery'` this calls
     * the provider's discovery endpoint and may reject.
     */
    listModels(): Promise<ModelDescriptor[]>;
    /**
     * Creates an adapter bound to a specific model + config.
     * In Slice 2, every implementation returns a stub adapter whose methods
     * throw `ProviderAdapterNotImplementedError`.
     */
    createAdapter(model: ModelDescriptor, config: ProviderConfig): ProviderAdapter;
}
//# sourceMappingURL=profile.d.ts.map