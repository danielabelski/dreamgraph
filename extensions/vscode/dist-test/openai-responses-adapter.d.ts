import type { ArchitectMessage, ToolDefinition, ToolUseRequest } from "./architect-llm";
export type OpenAIResponsesReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type OpenAIResponsesTextVerbosity = "low" | "medium" | "high";
export interface OpenAIResponsesOptions {
    model: string;
    reasoningEffort: OpenAIResponsesReasoningEffort;
    textVerbosity: OpenAIResponsesTextVerbosity;
    rawMessages?: unknown[];
    tools?: ToolDefinition[];
}
export interface OpenAIResponsesData {
    output_text?: string;
    output?: Array<Record<string, unknown>>;
}
type ArchitectMessageContent = ArchitectMessage["content"];
export declare function usesOpenAIResponsesApi(model: string): boolean;
export declare function buildOpenAIResponsesRequest(messages: ArchitectMessage[], options: OpenAIResponsesOptions): Record<string, unknown>;
export declare function toOpenAIResponsesContent(content: ArchitectMessageContent): unknown;
/** Marker key used by chat-panel to store the verbatim Responses output[]
 * items for an assistant turn (including `reasoning` items). When present,
 * `translateRawToOpenAIResponses` emits these items 1:1 instead of trying to
 * synthesize them from Anthropic-shaped blocks — preserving the encrypted
 * reasoning blob across the next turn. */
export declare const RESPONSES_RAW_ITEMS_KEY: "__responsesItems";
export declare function extractOpenAIResponsesRawItems(data: OpenAIResponsesData): unknown[];
export declare function translateRawToOpenAIResponses(raw: unknown[]): unknown[];
export declare function extractOpenAIResponsesText(data: OpenAIResponsesData): string;
export declare function extractOpenAIResponsesToolCalls(data: OpenAIResponsesData): ToolUseRequest[];
export {};
//# sourceMappingURL=openai-responses-adapter.d.ts.map