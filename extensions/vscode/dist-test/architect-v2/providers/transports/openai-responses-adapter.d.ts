import { type ChatRequest, type ChatResponse, type ProviderAdapter, type ProviderConfig, type StreamEvent } from "../adapter";
import type { ModelDescriptor } from "../profile";
export declare class OpenAIResponsesAdapter implements ProviderAdapter {
    readonly providerId: "openai";
    readonly model: ModelDescriptor;
    private readonly config;
    constructor(model: ModelDescriptor, config: ProviderConfig);
    callWithTools(request: ChatRequest): Promise<ChatResponse>;
    stream(request: ChatRequest): AsyncIterable<StreamEvent>;
    private buildRequestBody;
    private headers;
    private baseUrl;
}
//# sourceMappingURL=openai-responses-adapter.d.ts.map