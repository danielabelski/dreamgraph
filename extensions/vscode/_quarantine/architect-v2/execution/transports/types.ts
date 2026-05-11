// architect-v2/execution/transports/types.ts
//
// Shared types for v2 production transports. These are the thin,
// provider-agnostic shapes the ExecutorAdapter consumes; each
// concrete transport (anthropic.ts, openai-chat.ts, openai-responses.ts,
// ollama.ts) is responsible for producing a TransportResponse from
// the provider's wire format.
//
// STRICT ISOLATION (ADR-140 + ADR-171): no v1 imports; no
// mcp_dreamgraph_* tokens (transports never speak MCP, only HTTP).

export interface TransportConfig {
  readonly provider: "anthropic" | "openai" | "lmstudio" | "ollama";
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Optional reasoning effort (OpenAI Responses API). */
  readonly reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  /** Optional output verbosity (OpenAI Responses API). */
  readonly textVerbosity?: "low" | "medium" | "high";
}

export interface TransportContentBlock {
  readonly type: "text" | "image";
  readonly text?: string;
  readonly mimeType?: string;
  readonly dataBase64?: string;
}

export interface TransportMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string | readonly TransportContentBlock[];
}

export interface TransportToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface TransportRequest {
  readonly messages: readonly TransportMessage[];
  /** Tool definitions exposed to the model; empty array = no tools. */
  readonly tools: readonly TransportToolDefinition[];
  /**
   * Verbatim raw assistant items from a prior pass (OpenAI Responses
   * API only). When present, the transport replays these instead of
   * re-translating the messages array.
   */
  readonly rawAssistantReplay?: readonly unknown[];
  /** Cancel signal forwarded into fetch(). */
  readonly signal?: AbortSignal;
}

export interface NormalizedToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface NormalizedUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

export type NormalizedStopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop"
  | "incomplete"
  | "error"
  | "unknown";

/**
 * The canonical response shape every transport emits. Downstream
 * consumers (ExecutorAdapter) NEVER see provider-specific shapes.
 */
export interface TransportResponse {
  /** Pure model text content (concatenated text blocks if multi-block). */
  readonly text: string;
  /** Tool calls extracted from the response, normalized. */
  readonly toolCalls: readonly NormalizedToolCall[];
  readonly stopReason: NormalizedStopReason;
  readonly usage: NormalizedUsage;
  readonly durationMs: number;
  /**
   * Verbatim provider items needed for stateless replay. OpenAI
   * Responses API uses this to preserve reasoning context across
   * turns. Other transports leave this undefined.
   */
  readonly rawAssistantItems?: readonly unknown[];
  /**
   * When the response could not be parsed (malformed JSON, unexpected
   * shape), the transport sets this with a human-readable note. The
   * ExecutorAdapter turns it into a typed failure card; the renderer
   * NEVER receives raw provider output.
   */
  readonly normalizationError?: string;
}

/**
 * Thrown by transports for transport-level failures (network, HTTP
 * non-2xx, request budget exceeded). Contains structured fields so
 * the ExecutorAdapter can produce typed failure cards without parsing
 * a freeform message.
 */
export class TransportError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | "network"
      | "http"
      | "auth"
      | "timeout"
      | "aborted"
      | "unknown",
    public readonly httpStatus?: number,
    public readonly provider?: string,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

/**
 * Functional shape every transport implements. Pure: same inputs +
 * same network response = same TransportResponse.
 */
export type Transport = (
  config: TransportConfig,
  request: TransportRequest,
) => Promise<TransportResponse>;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Map an HTTP status to a normalized TransportError kind. */
export function httpErrorKind(status: number): TransportError["kind"] {
  if (status === 401 || status === 403) return "auth";
  if (status === 408 || status === 504) return "timeout";
  if (status >= 400) return "http";
  return "unknown";
}

/** Wrap a thrown error from fetch() into a structured TransportError. */
export function wrapFetchError(
  err: unknown,
  provider: string,
): TransportError {
  if (err instanceof TransportError) return err;
  const e = err as { name?: string; message?: string };
  if (e?.name === "AbortError") {
    return new TransportError("request aborted", "aborted", undefined, provider);
  }
  return new TransportError(
    e?.message ?? "network error",
    "network",
    undefined,
    provider,
  );
}
