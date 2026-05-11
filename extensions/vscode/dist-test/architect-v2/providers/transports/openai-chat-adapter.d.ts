import { type ChatRequest, type ChatResponse, type ProviderAdapter, type ProviderConfig, type StreamEvent } from "../adapter";
import type { ModelDescriptor } from "../profile";
export declare class OpenAIChatAdapter implements ProviderAdapter {
    readonly providerId: "openai";
    readonly model: ModelDescriptor;
    protected readonly config: ProviderConfig;
    protected readonly defaultBaseUrl: string;
    protected readonly authHeaderRequired: boolean;
    constructor(model: ModelDescriptor, config: ProviderConfig, options?: {
        defaultBaseUrl?: string;
        authHeaderRequired?: boolean;
    });
    callWithTools(request: ChatRequest): Promise<ChatResponse>;
    stream(request: ChatRequest): AsyncIterable<StreamEvent>;
    protected buildRequestBody(request: ChatRequest, stream: boolean): Record<string, unknown>;
    protected headers(): Record<string, string>;
    protected baseUrl(): string;
}
//# sourceMappingURL=openai-chat-adapter.d.ts.map