// architect-v2/providers/_transport.ts
// Milestone 2 (v10.0.0 cutover) — Shared transport primitives for v2
// provider adapters. Lives next to the provider profiles, NOT under v1.
//
// STRICT ISOLATION (ADR-140): no import from v1. No reuse of v1 types.
//
// Responsibilities (kept narrow on purpose):
//   - readSseLines(res):  parses an HTTP/1.1 `text/event-stream` body into
//                         { event, data } records, respecting multi-line
//                         `data:` continuations and blank-line frame breaks.
//   - readNdjsonLines:    splits an HTTP body that emits one JSON object
//                         per `\n` (Ollama).
//   - enforceRequestSize: hard brake mirroring v1's 320KB default. Returns
//                         the serialized JSON body OR throws ProviderError
//                         with `kind: 'context_overflow'`.
//   - mapHttpError:       turns an HTTP non-2xx into a typed ProviderError
//                         on the closed enumeration; reads body text once.
//   - safeJsonParse:      returns undefined on malformed JSON instead of
//                         throwing — the caller decides whether absent
//                         data warrants a `tool_call_malformed` error.

import { ProviderError } from "./adapter";
import type { ProviderId } from "./profile";

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

export interface SseFrame {
  /** Empty string when no `event:` line was present in the frame. */
  readonly event: string;
  /** Concatenated `data:` lines (LF-joined per the spec). */
  readonly data: string;
}

/**
 * Async iterable of SSE frames. Consumers MUST handle `data === '[DONE]'`
 * themselves — this helper does not interpret payloads.
 *
 * Hard rules:
 *   - One frame is yielded per blank line in the stream.
 *   - Lines beginning with `:` are comments; ignored.
 *   - Multiple `data:` lines in one frame are joined with `\n`.
 *   - When the body ends mid-frame, any pending data IS flushed (some
 *     providers omit a trailing blank line on errors).
 */
export async function* readSseLines(res: Response): AsyncIterable<SseFrame> {
  const reader = res.body?.getReader();
  if (!reader) {
    throw new ProviderError({
      kind: "transport",
      providerId: "openai", // overwritten by caller via mapHttpError; safe default
      message: "Response body is not readable for SSE stream",
    });
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  const dataLines: string[] = [];

  const flushFrame = (): SseFrame | undefined => {
    if (dataLines.length === 0 && event === "") return undefined;
    const frame: SseFrame = { event, data: dataLines.join("\n") };
    event = "";
    dataLines.length = 0;
    return frame;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let lineBreak = buffer.indexOf("\n");
    while (lineBreak !== -1) {
      let line = buffer.slice(0, lineBreak);
      buffer = buffer.slice(lineBreak + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        const frame = flushFrame();
        if (frame) yield frame;
      } else if (line.startsWith(":")) {
        // comment; ignore
      } else if (line.startsWith("event:")) {
        event = line.slice(6).trimStart();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
      // Any other field (`id:`, `retry:`) is ignored on purpose.
      lineBreak = buffer.indexOf("\n");
    }
  }

  // Flush any final partial line + any pending frame.
  if (buffer.length > 0) {
    let line = buffer;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    else if (line.startsWith("event:")) event = line.slice(6).trimStart();
  }
  const trailing = flushFrame();
  if (trailing) yield trailing;
}

// ---------------------------------------------------------------------------
// NDJSON (Ollama)
// ---------------------------------------------------------------------------

export async function* readNdjsonLines(res: Response): AsyncIterable<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    throw new ProviderError({
      kind: "transport",
      providerId: "ollama",
      message: "Response body is not readable for NDJSON stream",
    });
  }
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.length > 0) yield line;
      nl = buffer.indexOf("\n");
    }
  }
  const tail = buffer.trim();
  if (tail.length > 0) yield tail;
}

// ---------------------------------------------------------------------------
// Request-size brake
// ---------------------------------------------------------------------------

/**
 * Default hard cap on serialized request body size. Mirrors v1's 320KB
 * brake. Adapters MAY override via `ProviderConfig.requestSizeLimitBytes`.
 */
export const DEFAULT_REQUEST_SIZE_LIMIT_BYTES = 320 * 1024;

export function serializeWithBudget(
  providerId: ProviderId,
  modelId: string,
  body: unknown,
  limitBytes?: number,
): string {
  const serialized = JSON.stringify(body);
  const limit = limitBytes ?? DEFAULT_REQUEST_SIZE_LIMIT_BYTES;
  // JSON.stringify over JS strings produces UTF-16 code units; convert to
  // bytes via Buffer so the cap matches the wire weight.
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength > limit) {
    throw new ProviderError({
      kind: "context_overflow",
      providerId,
      modelId,
      message:
        `Request body ${byteLength} bytes exceeds ${limit}-byte limit. ` +
        `Reduce context (drop sections, lower windowTokens, or split task).`,
    });
  }
  return serialized;
}

// ---------------------------------------------------------------------------
// HTTP error → typed ProviderError
// ---------------------------------------------------------------------------

export async function mapHttpError(
  res: Response,
  providerId: ProviderId,
  modelId: string,
): Promise<ProviderError> {
  let bodyText = "";
  try {
    bodyText = await res.text();
  } catch {
    // Body unreadable; surface status only.
  }
  const lower = bodyText.toLowerCase();
  let kind: ProviderError["kind"] = "transport";
  if (res.status === 401 || res.status === 403) kind = "auth";
  else if (res.status === 429) kind = "rate_limit";
  else if (res.status === 404) kind = "model_unavailable";
  else if (res.status === 400 && (lower.includes("context") || lower.includes("token"))) {
    kind = "context_overflow";
  } else if (res.status >= 500) kind = "transport";
  else if (res.status === 400) kind = "tool_call_malformed";

  const head = bodyText.length > 800 ? bodyText.slice(0, 800) + "…" : bodyText;
  return new ProviderError({
    kind,
    providerId,
    modelId,
    message: `${providerId} HTTP ${res.status} ${res.statusText}${head ? `: ${head}` : ""}`,
    providerRaw: { status: res.status, body: bodyText },
  });
}

// ---------------------------------------------------------------------------
// Network error → typed ProviderError
// ---------------------------------------------------------------------------

export function mapNetworkError(
  err: unknown,
  providerId: ProviderId,
  modelId: string,
): ProviderError {
  if (err instanceof ProviderError) return err;
  const isAbort =
    (err as { name?: string } | null)?.name === "AbortError" ||
    (typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "ABORT_ERR");
  if (isAbort) {
    return new ProviderError({
      kind: "aborted",
      providerId,
      modelId,
      message: "Request aborted by caller",
      retryable: false,
    });
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new ProviderError({
    kind: "transport",
    providerId,
    modelId,
    message: `Network error talking to ${providerId}: ${msg}`,
    providerRaw: err,
  });
}

// ---------------------------------------------------------------------------
// Safe JSON
// ---------------------------------------------------------------------------

export function safeJsonParse<T = unknown>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
