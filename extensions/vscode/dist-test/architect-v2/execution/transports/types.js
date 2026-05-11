"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.TransportError = void 0;
exports.httpErrorKind = httpErrorKind;
exports.wrapFetchError = wrapFetchError;
/**
 * Thrown by transports for transport-level failures (network, HTTP
 * non-2xx, request budget exceeded). Contains structured fields so
 * the ExecutorAdapter can produce typed failure cards without parsing
 * a freeform message.
 */
class TransportError extends Error {
    kind;
    httpStatus;
    provider;
    constructor(message, kind, httpStatus, provider) {
        super(message);
        this.kind = kind;
        this.httpStatus = httpStatus;
        this.provider = provider;
        this.name = "TransportError";
    }
}
exports.TransportError = TransportError;
// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
/** Map an HTTP status to a normalized TransportError kind. */
function httpErrorKind(status) {
    if (status === 401 || status === 403)
        return "auth";
    if (status === 408 || status === 504)
        return "timeout";
    if (status >= 400)
        return "http";
    return "unknown";
}
/** Wrap a thrown error from fetch() into a structured TransportError. */
function wrapFetchError(err, provider) {
    if (err instanceof TransportError)
        return err;
    const e = err;
    if (e?.name === "AbortError") {
        return new TransportError("request aborted", "aborted", undefined, provider);
    }
    return new TransportError(e?.message ?? "network error", "network", undefined, provider);
}
//# sourceMappingURL=types.js.map