export interface CliJsonToolStartEvent {
    readonly type: "tool.execution_start";
    readonly toolCallId: string;
    readonly toolName: string;
    readonly arguments: unknown;
    /** Present iff the call is served by an MCP server. */
    readonly mcpServerName?: string;
    /** Present iff the call is served by an MCP server. */
    readonly mcpToolName?: string;
    /** ISO-8601 timestamp from the CLI. */
    readonly timestamp: string;
    readonly turnId?: string;
    /** Raw event id from the CLI (opaque). */
    readonly id?: string;
}
export interface CliJsonToolCompleteEvent {
    readonly type: "tool.execution_complete";
    readonly toolCallId: string;
    readonly toolName: string;
    readonly success: boolean;
    /** Free-form result payload from the tool (CLI-native or MCP). */
    readonly result: unknown;
    readonly timestamp: string;
    readonly id?: string;
}
export interface CliJsonAssistantDeltaEvent {
    readonly type: "assistant.message_delta" | "assistant.reasoning_delta";
    readonly deltaContent: string;
    readonly messageId?: string;
    readonly timestamp: string;
    readonly id?: string;
}
export interface CliJsonAssistantMessageEvent {
    readonly type: "assistant.message";
    readonly content: string;
    readonly messageId?: string;
    readonly timestamp: string;
    readonly id?: string;
}
export interface CliJsonResultEvent {
    readonly type: "result";
    readonly sessionId?: string;
    readonly exitCode?: number;
    readonly usage?: unknown;
    readonly timestamp: string;
    readonly id?: string;
}
export interface CliJsonOtherEvent {
    /**
     * Discriminator. All other event variants use the CLI's `type`
     * string as their literal discriminator; this variant uses `type:
     * "_other"` so TypeScript can narrow the union cleanly. The
     * original CLI `type` string is preserved on `rawType`.
     */
    readonly type: "_other";
    readonly rawType: string;
    readonly data?: unknown;
    readonly timestamp?: string;
    readonly id?: string;
}
export type CliJsonEvent = CliJsonToolStartEvent | CliJsonToolCompleteEvent | CliJsonAssistantDeltaEvent | CliJsonAssistantMessageEvent | CliJsonResultEvent | CliJsonOtherEvent;
export interface CopilotCliEventStream {
    /**
     * Feed a stdout chunk into the parser. Returns every complete event
     * that became available. Partial trailing lines are buffered and
     * stitched onto the next chunk.
     */
    feed(chunk: string): readonly CliJsonEvent[];
    /**
     * Drain any remaining carry. Should be called once after the spawn
     * exits. Returns an empty array when no buffered partial line
     * exists or when the buffered text is not a valid event.
     */
    flush(): readonly CliJsonEvent[];
    /**
     * Snapshot the accumulated assistant message text. Builds from
     * `assistant.message_delta` events in arrival order; if a
     * `assistant.message` event has been seen, its `content` replaces
     * the accumulator (authoritative). Reasoning deltas are NOT
     * included — they belong on a separate channel.
     */
    snapshotAssistantText(): string;
}
export declare function createCopilotCliEventStream(): CopilotCliEventStream;
//# sourceMappingURL=event-stream.d.ts.map