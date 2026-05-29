export interface CodexJsonExtraction {
    readonly events: readonly unknown[];
    readonly diagnostics: readonly string[];
}
export interface CodexCliEventStream {
    feed(chunk: string): readonly unknown[];
    flush(): readonly unknown[];
}
export declare function createCodexCliEventStream(): CodexCliEventStream;
export declare function extractCodexJsonEvents(text: string): CodexJsonExtraction;
export declare function codexEventType(event: unknown): string | undefined;
export declare function codexEventData(event: unknown): Record<string, unknown> | undefined;
export declare function codexAssistantDelta(event: unknown): string | null;
export declare function codexAssistantCompletedText(event: unknown): string | null;
export declare function summarizeCodexDiagnosticLine(raw: string): string | null;
export declare function isCodexPluginSyncNoise(text: string): boolean;
export declare function asRecord(value: unknown): Record<string, unknown> | undefined;
export declare function recordString(record: Record<string, unknown> | undefined, key: string): string | undefined;
export declare function recordNumber(record: Record<string, unknown> | undefined, key: string): number | undefined;
//# sourceMappingURL=event-stream.d.ts.map