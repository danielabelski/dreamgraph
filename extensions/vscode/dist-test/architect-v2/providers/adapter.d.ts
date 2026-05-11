import type { ModelDescriptor, ProviderId, ReasoningEffort } from "./profile";
/**
 * Per-provider runtime config. The orchestrator owns this; adapters are
 * pure transport given a config + a model + a request.
 */
export interface ProviderConfig {
    /** Base URL override (LM Studio, Ollama, custom OpenAI proxies). */
    baseUrl?: string;
    /** API key, if the provider needs one. */
    apiKey?: string;
    /** Hard request-size brake in bytes. (Preserved concept from v1 ArchitectLlm 320KB cap.) */
    requestSizeLimitBytes?: number;
    /** Optional per-request timeout in milliseconds. */
    timeoutMs?: number;
}
/**
 * (Preserved concept from v1 `ArchitectMessage` — but minimized: no
 * provider-specific fields leak in. Adapters translate to/from provider wire
 * format. The `name` field carries tool-call ids when role === 'tool'.)
 */
export interface ChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    /** Tool-call id when role === 'tool', else undefined. */
    toolCallId?: string;
    /** Tool calls emitted by the assistant on this turn, if any. */
    toolCalls?: ToolCall[];
}
/**
 * (Preserved concept from v1 `ToolDefinition`. Wire-format-agnostic; adapters
 * translate to OpenAI / Anthropic shapes.)
 */
export interface ToolDefinition {
    name: string;
    description: string;
    /** JSON Schema object for the tool's input. */
    inputSchema: Record<string, unknown>;
}
/**
 * (Preserved concept from v1 `ToolUseRequest`. The orchestrator never sees a
 * provider's raw tool-call envelope; it sees this canonical shape.)
 */
export interface ToolCall {
    id: string;
    name: string;
    /** JSON-stringified arguments as emitted by the model. */
    argumentsJson: string;
}
export type ToolChoice = "auto" | "required" | "none" | {
    name: string;
};
export interface ChatRequest {
    /** Required: the descriptor of the model to call. */
    model: ModelDescriptor;
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    toolChoice?: ToolChoice;
    /** Reasoning effort. Adapter may down-clamp to model's `effortLevels`. */
    reasoningEffort?: ReasoningEffort;
    /** Cap on response output tokens. Adapter may down-clamp to model max. */
    maxOutputTokens?: number;
    /** Abort signal for cooperative cancellation. */
    abortSignal?: AbortSignal;
}
export interface UsageReport {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
}
export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "aborted" | "error";
export type StreamEvent = {
    kind: "text";
    delta: string;
} | {
    kind: "reasoning";
    delta: string;
} | {
    kind: "tool_call";
    call: ToolCall;
} | {
    kind: "usage";
    usage: UsageReport;
} | {
    kind: "done";
    finishReason: FinishReason;
} | {
    kind: "error";
    error: ProviderError;
};
export interface ChatResponse {
    text: string;
    reasoning?: string;
    toolCalls: ToolCall[];
    usage?: UsageReport;
    finishReason: FinishReason;
}
/**
 * Closed enumeration of provider error categories. Adapters MUST translate
 * provider-specific failures into one of these kinds. The orchestrator's
 * recovery / retry / continuation logic switches on `kind`, never on the
 * provider's raw error message.
 */
export type ProviderErrorKind = "auth" | "rate_limit" | "model_unavailable" | "context_overflow" | "tool_call_malformed" | "aborted" | "transport" | "not_implemented" | "unknown";
export declare class ProviderError extends Error {
    readonly kind: ProviderErrorKind;
    readonly providerId: ProviderId;
    readonly modelId?: string;
    readonly retryable: boolean;
    readonly providerRaw?: unknown;
    constructor(args: {
        kind: ProviderErrorKind;
        providerId: ProviderId;
        modelId?: string;
        message: string;
        retryable?: boolean;
        providerRaw?: unknown;
    });
}
/**
 * Thrown by every Slice 2 stub adapter. Slice 3+ replaces stub adapters with
 * real implementations, one provider at a time, behind the v2 feature flag.
 */
export declare class ProviderAdapterNotImplementedError extends ProviderError {
    constructor(providerId: ProviderId, modelId: string, slice: string);
}
/**
 * Every provider implements this. Adapters are stateless given their config:
 * one `createAdapter(model, config)` per turn is acceptable.
 *
 * (Preserved concept from v1 `ArchitectLlm.stream()` / `callWithTools()` —
 * but lifted out of a single class into a per-provider implementation, and
 * with canonical request/response shapes that hide all provider quirks.)
 */
export interface ProviderAdapter {
    readonly providerId: ProviderId;
    readonly model: ModelDescriptor;
    /** Streaming chat. Yields `StreamEvent`s; ends with a `done` or `error`. */
    stream(request: ChatRequest): AsyncIterable<StreamEvent>;
    /** Non-streaming call. Used for short utility calls. */
    callWithTools(request: ChatRequest): Promise<ChatResponse>;
}
/**
 * Builds a `ProviderAdapter` whose methods throw
 * `ProviderAdapterNotImplementedError`. Used by every Slice 2 provider.
 * Replaced with a real adapter in later slices.
 */
export declare function createStubAdapter(providerId: ProviderId, model: ModelDescriptor, slice: string): ProviderAdapter;
//# sourceMappingURL=adapter.d.ts.map