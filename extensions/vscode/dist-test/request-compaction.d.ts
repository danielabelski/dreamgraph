import type { ArchitectMessage, ToolDefinition } from "./architect-llm";
export type CompactionProvider = "anthropic" | "openai" | "ollama" | "lmstudio" | "copilot-cli" | "codex-cli";
export interface CompactionBudgetDecision {
    level: 0 | 1 | 2 | 3;
    targetTokens: number;
    estimatedTokens: number;
    overflowAccepted: boolean;
    reason: string;
}
export interface SharedCompactionInput {
    system?: string;
    messages: ArchitectMessage[];
    rawMessages?: unknown[];
    tools?: ToolDefinition[];
    provider: CompactionProvider;
}
export interface SharedCompactionResult {
    system?: string;
    messages: ArchitectMessage[];
    rawMessages?: unknown[];
    tools?: ToolDefinition[];
    budget: CompactionBudgetDecision;
}
export declare function minifyToolDefinitions(tools: ToolDefinition[]): ToolDefinition[];
export declare function applySharedRequestCompaction(input: SharedCompactionInput): SharedCompactionResult;
export declare function compactMessagesForProvider(messages: ArchitectMessage[], _provider: CompactionProvider, level?: 0 | 1 | 2 | 3): ArchitectMessage[];
export declare function compactRawMessagesForProvider(raw: unknown[], _provider: CompactionProvider, level?: 0 | 1 | 2 | 3): unknown[];
export declare function compactSystemPrompt(system: string, level?: 0 | 1 | 2 | 3): string;
export declare function compactAssistantText(text: string, level?: 0 | 1 | 2 | 3): string;
export declare function compactToolResultContent(content: unknown, _level?: 0 | 1 | 2 | 3): string;
//# sourceMappingURL=request-compaction.d.ts.map