/**
 * DreamGraph Architect LLM Provider — Layer 2 (Context Orchestration).
 *
 * Calls the Architect model (Anthropic, OpenAI, or Ollama) with
 * structured prompts assembled from the context orchestration layer.
 */
import * as vscode from "vscode";
export type ArchitectProvider = "anthropic" | "openai" | "ollama" | "lmstudio";
export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";
export interface ArchitectConfig {
    provider: ArchitectProvider;
    model: string;
    baseUrl: string;
    apiKey: string;
}
export type ArchitectContentBlock = {
    type: "text";
    text: string;
} | {
    type: "image";
    mimeType: string;
    dataBase64: string;
    fileName?: string;
};
export type ArchitectTextBlock = {
    type: "text";
    text: string;
};
export type ArchitectImageBlock = {
    type: "image";
    mimeType: string;
    dataBase64: string;
    fileName?: string;
};
export type ArchitectContent = ArchitectTextBlock | ArchitectImageBlock;
export interface ArchitectMessage {
    role: "system" | "user" | "assistant";
    content: string | ArchitectContent[];
}
export interface ArchitectModelCapabilities {
    textAttachments: boolean;
    imageAttachments: boolean;
}
export interface ArchitectResponse {
    content: string;
    promptTokens: number;
    completionTokens: number;
    durationMs: number;
}
export interface ToolUseRequest {
    id: string;
    name: string;
    input: Record<string, unknown>;
}
export interface ArchitectToolResponse extends ArchitectResponse {
    toolCalls: ToolUseRequest[];
    stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop" | string;
    /** Provider-specific verbatim assistant turn items.
     * For OpenAI Responses API (gpt-5.5/o-series) this is the full `output[]`
     * array including `reasoning` items. The chat panel persists these so the
     * next turn can replay them and preserve stateless reasoning context. */
    providerRawAssistant?: unknown[];
}
export interface ToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}
export interface ToolResultMessage {
    role: "user";
    content: Array<{
        type: "tool_result";
        tool_use_id: string;
        content: string;
        is_error?: boolean;
    }>;
}
export type StreamCallback = (chunk: string) => void;
export declare const ANTHROPIC_MODELS: string[];
export declare const OPENAI_MODELS: string[];
/**
 * Optional sink that receives structured budget summaries.
 * Set by extension activation via `setRequestBudgetSink(inspector.logRequestBudget.bind(inspector))`
 * so output appears in the "DreamGraph Context" output channel.
 * Falls back to console.log/warn if no sink is registered.
 */
type RequestBudgetSink = (summary: {
    callsite: string;
    model: string;
    inputChars: number;
    approxTokens: number;
    sections: Array<{
        name: string;
        chars: number;
        approxTokens: number;
    }>;
    warn?: boolean;
}) => void;
export declare function setRequestBudgetSink(sink: RequestBudgetSink | undefined): void;
export declare class ArchitectLlm implements vscode.Disposable {
    private _config;
    private _secretStorage;
    constructor(secretStorage: vscode.SecretStorage);
    get isConfigured(): boolean;
    get provider(): ArchitectProvider | null;
    get currentConfig(): ArchitectConfig | null;
    /** Apply a config directly in memory (skips settings round-trip). */
    applyConfig(config: ArchitectConfig): void;
    getModelCapabilities(provider?: ArchitectProvider | null, model?: string | null): ArchitectModelCapabilities;
    private _getAnthropicEffort;
    private _getAnthropicMaxTokens;
    private _getAnthropicThinking;
    private _buildAnthropicMessagesRequest;
    loadConfig(): Promise<void>;
    setApiKey(provider: ArchitectProvider, key: string): Promise<void>;
    getApiKey(provider: ArchitectProvider): Promise<string | undefined>;
    call(messages: ArchitectMessage[], signal?: AbortSignal): Promise<ArchitectResponse>;
    stream(messages: ArchitectMessage[], onChunk: StreamCallback, signal?: AbortSignal): Promise<ArchitectResponse>;
    callWithTools(messages: ArchitectMessage[], tools: ToolDefinition[], rawMessages?: unknown[], signal?: AbortSignal): Promise<ArchitectToolResponse>;
    private _messageTextContent;
    private _toAnthropicContent;
    private _toOpenAIContent;
    private _toOllamaContent;
    private _translateRawToOpenAI;
    private _callAnthropic;
    private _callAnthropicWithTools;
    private _usesOpenAIResponsesApi;
    private _getOpenAIReasoningEffort;
    private _getOpenAITextVerbosity;
    private _toOpenAIResponsesContent;
    private _translateRawToOpenAIResponses;
    private _buildOpenAIResponsesRequest;
    /**
     * Whether to attach the canonical architect-pass JSON schema to outbound
     * requests for the given provider. Today only OpenAI's first-party API
     * (Chat Completions + Responses) is supported \u2014 LM Studio's openai-compat
     * endpoint accepts `response_format` but its model-side enforcement varies
     * by loaded model, so we keep it opt-in via the same setting.
     *
     * Setting: `dreamgraph.architect.structuredOutput` (boolean, default true
     * for `openai`, false otherwise). User can disable to fall back to the
     * legacy fenced-JSON contract if a specific snapshot rejects schemas.
     */
    private _isStructuredOutputEnabled;
    /**
     * Build the `format` body field for the Ollama /api/chat request. Recent
     * Ollama (>=0.5) accepts a JSON Schema object here and grammar-constrains
     * the response server-side, mirroring OpenAI's strict json_schema mode.
     * Returns an empty object when structured output is disabled — callers
     * spread the result so the field simply doesn't appear on the wire for
     * older Ollama versions that wouldn't recognize it.
     */
    private _ollamaFormatField;
    /**
     * Build the `response_format` body field for OpenAI Chat Completions.
     * Strict json_schema mode is grammar-constrained server-side: the model
     * physically cannot emit text outside the schema. Returns an empty object
     * when structured output is disabled — callers spread the result into the
     * request body so the field simply doesn't appear.
     */
    private _openAIChatResponseFormat;
    /**
     * When structured-output mode is on, the wire content is a strict
     * `architect_pass_envelope` JSON object. Project it back to the legacy
     * "prose markdown + fenced ```json envelope" shape so every existing
     * downstream parser (autonomy, summary card, webview body renderer)
     * keeps working without needing to learn the new shape. When projection
     * fails or structured output is off, the original content is returned
     * unchanged.
     */
    private _maybeProjectStructuredContent;
    private _extractOpenAIResponsesText;
    private _extractOpenAIResponsesToolCalls;
    private _callOpenAIResponses;
    private _callOpenAIResponsesWithTools;
    private _callOpenAIWithTools;
    private _streamAnthropic;
    private _callOpenAI;
    private _streamOpenAI;
    private _callOllama;
    private _streamOllama;
    private _readSSEStream;
    private _splitSystem;
    private _defaultBaseUrl;
    private _defaultModel;
    private _ensureConfigured;
    dispose(): void;
}
export {};
//# sourceMappingURL=architect-llm.d.ts.map