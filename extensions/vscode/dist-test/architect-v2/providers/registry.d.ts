import type { ProviderId, ProviderProfile } from "./profile";
export declare function listProviders(): readonly ProviderProfile[];
export declare function getProvider(id: ProviderId): ProviderProfile;
export declare function hasProvider(id: string): id is ProviderId;
/**
 * Resolves a provider's default model descriptor by listing models and
 * picking the one whose id matches `defaultModelId`. Throws if not found
 * (which would indicate a registry bug, since defaults are locked by
 * ADR-145 and ADR-150).
 */
export declare function resolveDefaultModel(id: ProviderId): Promise<{
    provider: ProviderProfile;
    model: import("./profile").ModelDescriptor;
}>;
/**
 * Typed error raised when the host is asked to resolve a model id
 * that the selected provider does not advertise. The chat panel
 * surfaces this as a structured error card rather than a raw stack.
 */
export declare class UnknownModelError extends Error {
    readonly providerId: ProviderId;
    readonly modelId: string;
    readonly availableModelIds: readonly string[];
    constructor(providerId: ProviderId, modelId: string, availableModelIds: readonly string[]);
}
/**
 * Resolves an explicit `(providerId, modelId)` pair. When `modelId` is
 * omitted or matches the provider default this delegates to
 * `resolveDefaultModel`. When the id is unknown a typed
 * `UnknownModelError` is thrown so callers can surface a structured
 * provider-config error card.
 */
export declare function resolveModel(id: ProviderId, modelId?: string): Promise<{
    provider: ProviderProfile;
    model: import("./profile").ModelDescriptor;
}>;
/**
 * Lists model ids advertised by a provider. Convenience for hosts that
 * want to populate a model picker without resolving each descriptor.
 */
export declare function listModelIds(id: ProviderId): Promise<readonly string[]>;
//# sourceMappingURL=registry.d.ts.map