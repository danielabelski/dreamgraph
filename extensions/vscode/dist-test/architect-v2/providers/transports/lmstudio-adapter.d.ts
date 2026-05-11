import { type ChatRequest, type ChatResponse, type ProviderAdapter, type ProviderConfig, type StreamEvent } from "../adapter";
import type { ModelDescriptor } from "../profile";
import { mapHttpError } from "../_transport";
export declare const LMSTUDIO_DEFAULT_BASE_URL = "http://localhost:1234/v1";
export declare class LMStudioAdapter implements ProviderAdapter {
    readonly providerId: "lmstudio";
    readonly model: ModelDescriptor;
    private readonly inner;
    constructor(model: ModelDescriptor, config: ProviderConfig);
    callWithTools(request: ChatRequest): Promise<ChatResponse>;
    stream(request: ChatRequest): AsyncIterable<StreamEvent>;
}
/**
 * Calls LM Studio's `/models` endpoint and returns the discovered model ids
 * lifted into v2 ModelDescriptors. Unknown context windows fall back to
 * `defaultContextWindow`.
 *
 * On any failure (server down, parse error) returns the supplied
 * `fallbackModels` so the registry still resolves.
 */
export declare function discoverLmStudioModels(config: ProviderConfig, fallbackModels: readonly ModelDescriptor[], defaults: {
    capabilitiesTemplate: ModelDescriptor;
    defaultContextWindow: number;
}): Promise<ModelDescriptor[]>;
export { mapHttpError as mapLmStudioHttpError };
//# sourceMappingURL=lmstudio-adapter.d.ts.map