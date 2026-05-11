import { type ChatRequest, type ChatResponse, type ProviderAdapter, type ProviderConfig, type StreamEvent } from "../adapter";
import type { ModelDescriptor } from "../profile";
export declare class AnthropicAdapter implements ProviderAdapter {
    readonly providerId: "anthropic";
    readonly model: ModelDescriptor;
    private readonly config;
    constructor(model: ModelDescriptor, config: ProviderConfig);
    callWithTools(request: ChatRequest): Promise<ChatResponse>;
    stream(request: ChatRequest): AsyncIterable<StreamEvent>;
    private buildRequestBody;
    private headers;
    private baseUrl;
}
//# sourceMappingURL=anthropic-adapter.d.ts.map