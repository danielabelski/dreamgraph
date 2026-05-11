// architect-v2/providers/registry.ts
// Slice 2 — Provider registry façade.
//
// STRICT ISOLATION (ADR-140): no import from v1.
//
// One source of truth for "what providers exist?" The orchestrator never
// hardcodes provider ids; it asks the registry. The registry is initialized
// once at extension activation and is otherwise read-only.

import { anthropicProfile } from "./anthropic";
import { lmstudioProfile } from "./lmstudio";
import { ollamaProfile } from "./ollama";
import { openaiProfile } from "./openai";
import type { ProviderId, ProviderProfile } from "./profile";

const REGISTRY: Map<ProviderId, ProviderProfile> = new Map([
  [openaiProfile.id, openaiProfile],
  [anthropicProfile.id, anthropicProfile],
  [lmstudioProfile.id, lmstudioProfile],
  [ollamaProfile.id, ollamaProfile],
]);

export function listProviders(): readonly ProviderProfile[] {
  return Array.from(REGISTRY.values());
}

export function getProvider(id: ProviderId): ProviderProfile {
  const profile = REGISTRY.get(id);
  if (!profile) {
    // Closed enum + frozen registry — this is unreachable at runtime, but
    // typed-narrow for callers.
    throw new Error(`Unknown provider id: ${id}`);
  }
  return profile;
}

export function hasProvider(id: string): id is ProviderId {
  return REGISTRY.has(id as ProviderId);
}

/**
 * Resolves a provider's default model descriptor by listing models and
 * picking the one whose id matches `defaultModelId`. Throws if not found
 * (which would indicate a registry bug, since defaults are locked by
 * ADR-145 and ADR-150).
 */
export async function resolveDefaultModel(
  id: ProviderId,
): Promise<{ provider: ProviderProfile; model: import("./profile").ModelDescriptor }> {
  const provider = getProvider(id);
  const models = await provider.listModels();
  const model = models.find((m) => m.id === provider.defaultModelId);
  if (!model) {
    throw new Error(
      `Provider '${id}' default model '${provider.defaultModelId}' not found in listModels() result. ` +
        `Check ADR-145 / ADR-150 against the provider profile.`,
    );
  }
  return { provider, model };
}

/**
 * Typed error raised when the host is asked to resolve a model id
 * that the selected provider does not advertise. The chat panel
 * surfaces this as a structured error card rather than a raw stack.
 */
export class UnknownModelError extends Error {
  public readonly providerId: ProviderId;
  public readonly modelId: string;
  public readonly availableModelIds: readonly string[];

  constructor(
    providerId: ProviderId,
    modelId: string,
    availableModelIds: readonly string[],
  ) {
    super(
      `Provider '${providerId}' does not advertise model '${modelId}'. ` +
        `Available: ${availableModelIds.join(", ") || "(none)"}.`,
    );
    this.name = "UnknownModelError";
    this.providerId = providerId;
    this.modelId = modelId;
    this.availableModelIds = availableModelIds;
  }
}

/**
 * Resolves an explicit `(providerId, modelId)` pair. When `modelId` is
 * omitted or matches the provider default this delegates to
 * `resolveDefaultModel`. When the id is unknown a typed
 * `UnknownModelError` is thrown so callers can surface a structured
 * provider-config error card.
 */
export async function resolveModel(
  id: ProviderId,
  modelId?: string,
): Promise<{ provider: ProviderProfile; model: import("./profile").ModelDescriptor }> {
  const provider = getProvider(id);
  if (!modelId || modelId === provider.defaultModelId) {
    return resolveDefaultModel(id);
  }
  const models = await provider.listModels();
  const model = models.find((m) => m.id === modelId);
  if (!model) {
    throw new UnknownModelError(
      id,
      modelId,
      models.map((m) => m.id),
    );
  }
  return { provider, model };
}

/**
 * Lists model ids advertised by a provider. Convenience for hosts that
 * want to populate a model picker without resolving each descriptor.
 */
export async function listModelIds(id: ProviderId): Promise<readonly string[]> {
  const provider = getProvider(id);
  const models = await provider.listModels();
  return models.map((m) => m.id);
}
