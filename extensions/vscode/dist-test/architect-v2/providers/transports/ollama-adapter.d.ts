import { type ChatRequest, type ChatResponse, type ProviderAdapter, type ProviderConfig, type StreamEvent } from "../adapter";
import type { ModelDescriptor } from "../profile";
export declare const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434";
export declare class OllamaAdapter implements ProviderAdapter {
    readonly providerId: "ollama";
    readonly model: ModelDescriptor;
    private readonly config;
    constructor(model: ModelDescriptor, config: ProviderConfig);
    callWithTools(request: ChatRequest): Promise<ChatResponse>;
    stream(request: ChatRequest): AsyncIterable<StreamEvent>;
    private buildRequestBody;
    private baseUrl;
}
export declare function discoverOllamaModels(config: ProviderConfig, fallbackModels: readonly ModelDescriptor[], defaults: {
    capabilitiesTemplate: ModelDescriptor;
    defaultContextWindow: number;
}): Promise<ModelDescriptor[]>;
//# sourceMappingURL=ollama-adapter.d.ts.map