// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — pure NDJSON event-stream parser.
//
// Copilot CLI invoked with `--output-format json` writes one JSON
// object per line to stdout. Each object is a typed event:
//
//   • `tool.execution_start`     — a tool (CLI-native OR MCP-served)
//                                  has been invoked. Carries
//                                  `toolCallId`, `toolName`, raw
//                                  `arguments`, and for MCP calls an
//                                  explicit `mcpServerName` +
//                                  `mcpToolName` pair.
//   • `tool.execution_complete`  — the same `toolCallId` finished.
//                                  Carries `success` and a free-form
//                                  `result` payload.
//   • `assistant.message_delta`  — incremental assistant text. Each
//                                  event holds a `deltaContent`
//                                  fragment. Concatenated in arrival
//                                  order they reproduce the message.
//   • `assistant.reasoning_delta`— same shape as message_delta but
//                                  for the model's internal reasoning
//                                  channel.
//   • `assistant.message`        — authoritative final assistant
//                                  text for a turn. When present it
//                                  supersedes the accumulated deltas.
//   • `result`                   — session-level summary emitted once
//                                  at run end (sessionId, exitCode,
//                                  usage).
//
// Unknown event types are surfaced as a generic `other` variant so the
// caller can record them in audit without losing data.
//
// Pure: no I/O, no time, no randomness. The parser is line-buffered
// with a carry slot so partial chunks are stitched together correctly
// across multiple `feed()` calls. Malformed lines (invalid JSON, or
// missing the required `type` field) are skipped silently — the CLI
// occasionally emits an empty line at the end of the stream and this
// must not break the run.

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

export type CliJsonEvent =
  | CliJsonToolStartEvent
  | CliJsonToolCompleteEvent
  | CliJsonAssistantDeltaEvent
  | CliJsonAssistantMessageEvent
  | CliJsonResultEvent
  | CliJsonOtherEvent;

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

const ASSISTANT_DELTA_TYPES = new Set<string>([
  "assistant.message_delta",
  "assistant.reasoning_delta",
]);

function parseLineToEvent(line: string): CliJsonEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const type = obj.type;
  if (typeof type !== "string" || type.length === 0) return null;

  const timestamp = typeof obj.timestamp === "string" ? obj.timestamp : "";
  const id = typeof obj.id === "string" ? obj.id : undefined;
  const data = (obj.data && typeof obj.data === "object" ? obj.data : {}) as Record<string, unknown>;

  if (type === "tool.execution_start") {
    const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : "";
    const toolName = typeof data.toolName === "string" ? data.toolName : "";
    if (toolCallId.length === 0 || toolName.length === 0) return null;
    const mcpServerName = typeof data.mcpServerName === "string" ? data.mcpServerName : undefined;
    const mcpToolName = typeof data.mcpToolName === "string" ? data.mcpToolName : undefined;
    const turnId = typeof data.turnId === "string" ? data.turnId : undefined;
    const ev: CliJsonToolStartEvent = {
      type: "tool.execution_start",
      toolCallId,
      toolName,
      arguments: data.arguments,
      ...(mcpServerName !== undefined ? { mcpServerName } : {}),
      ...(mcpToolName !== undefined ? { mcpToolName } : {}),
      timestamp,
      ...(turnId !== undefined ? { turnId } : {}),
      ...(id !== undefined ? { id } : {}),
    };
    return ev;
  }

  if (type === "tool.execution_complete") {
    const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : "";
    const toolName = typeof data.toolName === "string" ? data.toolName : "";
    if (toolCallId.length === 0) return null;
    const success = typeof data.success === "boolean" ? data.success : true;
    const ev: CliJsonToolCompleteEvent = {
      type: "tool.execution_complete",
      toolCallId,
      toolName,
      success,
      result: data.result,
      timestamp,
      ...(id !== undefined ? { id } : {}),
    };
    return ev;
  }

  if (ASSISTANT_DELTA_TYPES.has(type)) {
    const deltaContent = typeof data.deltaContent === "string" ? data.deltaContent : "";
    if (deltaContent.length === 0) return null;
    const messageId = typeof data.messageId === "string" ? data.messageId : undefined;
    const ev: CliJsonAssistantDeltaEvent = {
      type: type as CliJsonAssistantDeltaEvent["type"],
      deltaContent,
      ...(messageId !== undefined ? { messageId } : {}),
      timestamp,
      ...(id !== undefined ? { id } : {}),
    };
    return ev;
  }

  if (type === "assistant.message") {
    const content = typeof data.content === "string" ? data.content : "";
    if (content.length === 0) return null;
    const messageId = typeof data.messageId === "string" ? data.messageId : undefined;
    const ev: CliJsonAssistantMessageEvent = {
      type: "assistant.message",
      content,
      ...(messageId !== undefined ? { messageId } : {}),
      timestamp,
      ...(id !== undefined ? { id } : {}),
    };
    return ev;
  }

  if (type === "result") {
    const sessionId = typeof data.sessionId === "string" ? data.sessionId : undefined;
    const exitCode = typeof data.exitCode === "number" ? data.exitCode : undefined;
    const usage = data.usage;
    const ev: CliJsonResultEvent = {
      type: "result",
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(usage !== undefined ? { usage } : {}),
      timestamp,
      ...(id !== undefined ? { id } : {}),
    };
    return ev;
  }

  const other: CliJsonOtherEvent = {
    type: "_other",
    rawType: type,
    ...(obj.data !== undefined ? { data: obj.data } : {}),
    ...(timestamp.length > 0 ? { timestamp } : {}),
    ...(id !== undefined ? { id } : {}),
  };
  return other;
}

export function createCopilotCliEventStream(): CopilotCliEventStream {
  let carry = "";
  // Accumulated assistant text from message_delta events, in arrival
  // order. Replaced wholesale when an `assistant.message` event arrives.
  const deltaBuffer: string[] = [];
  let authoritativeMessage: string | null = null;
  // Track the active `messageId` so we can insert paragraph breaks
  // between distinct assistant messages within a single turn. Some
  // CLI/model pairs emit per-step "thoughts" as separate messages
  // (each with its own `messageId`) and the deltas within each
  // message contain prose but no trailing newline. Without an
  // explicit boundary, joined deltas read as run-on text.
  let lastDeltaMessageId: string | null = null;

  function ingest(line: string, out: CliJsonEvent[]): void {
    const ev = parseLineToEvent(line);
    if (!ev) return;
    if (ev.type === "assistant.message_delta") {
      const mid = ev.messageId ?? null;
      if (
        lastDeltaMessageId !== null &&
        mid !== null &&
        mid !== lastDeltaMessageId &&
        deltaBuffer.length > 0
      ) {
        const tail = deltaBuffer[deltaBuffer.length - 1] ?? "";
        if (!tail.endsWith("\n\n")) {
          deltaBuffer.push(tail.endsWith("\n") ? "\n" : "\n\n");
        }
      }
      lastDeltaMessageId = mid;
      deltaBuffer.push(ev.deltaContent);
    } else if (ev.type === "assistant.message") {
      authoritativeMessage = ev.content;
    }
    out.push(ev);
  }

  return Object.freeze({
    feed(chunk: string): readonly CliJsonEvent[] {
      const out: CliJsonEvent[] = [];
      if (chunk.length === 0) return out;
      const combined = carry + chunk;
      // Walk by line — handle both `\n` and `\r\n` cleanly. We use a
      // manual scan rather than split() so the carry slot is exact.
      let start = 0;
      let i = 0;
      while (i < combined.length) {
        const ch = combined.charCodeAt(i);
        if (ch === 10 /* \n */) {
          let end = i;
          if (end > start && combined.charCodeAt(end - 1) === 13 /* \r */) end -= 1;
          ingest(combined.slice(start, end), out);
          i += 1;
          start = i;
        } else {
          i += 1;
        }
      }
      carry = combined.slice(start);
      return out;
    },
    flush(): readonly CliJsonEvent[] {
      const out: CliJsonEvent[] = [];
      if (carry.length > 0) {
        ingest(carry, out);
        carry = "";
      }
      return out;
    },
    snapshotAssistantText(): string {
      if (authoritativeMessage !== null) return authoritativeMessage;
      if (deltaBuffer.length === 0) return "";
      return deltaBuffer.join("");
    },
  });
}
