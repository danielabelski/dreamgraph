"use strict";
// architect-v2/providers/adapter.ts
// Slice 2 — ProviderAdapter contract + canonical chat/stream/error shapes.
//
// STRICT ISOLATION (ADR-140): no import from v1.
//
// This file defines the seam every provider adapter implements. Slice 2 ships
// only stub adapters that throw `ProviderAdapterNotImplementedError`. Real
// adapters land in later slices.
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProviderAdapterNotImplementedError = exports.ProviderError = void 0;
exports.createStubAdapter = createStubAdapter;
class ProviderError extends Error {
    kind;
    providerId;
    modelId;
    retryable;
    providerRaw;
    constructor(args) {
        super(args.message);
        this.name = "ProviderError";
        this.kind = args.kind;
        this.providerId = args.providerId;
        this.modelId = args.modelId;
        this.retryable = args.retryable ?? defaultRetryable(args.kind);
        this.providerRaw = args.providerRaw;
    }
}
exports.ProviderError = ProviderError;
function defaultRetryable(kind) {
    switch (kind) {
        case "rate_limit":
        case "transport":
            return true;
        case "auth":
        case "model_unavailable":
        case "context_overflow":
        case "tool_call_malformed":
        case "aborted":
        case "not_implemented":
        case "unknown":
            return false;
    }
}
/**
 * Thrown by every Slice 2 stub adapter. Slice 3+ replaces stub adapters with
 * real implementations, one provider at a time, behind the v2 feature flag.
 */
class ProviderAdapterNotImplementedError extends ProviderError {
    constructor(providerId, modelId, slice) {
        super({
            kind: "not_implemented",
            providerId,
            modelId,
            message: `Provider adapter for ${providerId}/${modelId} is a Slice 2 stub. Real implementation arrives in a later slice (current: ${slice}).`,
            retryable: false,
        });
        this.name = "ProviderAdapterNotImplementedError";
    }
}
exports.ProviderAdapterNotImplementedError = ProviderAdapterNotImplementedError;
// ---------------------------------------------------------------------------
// Stub adapter helper (used by every provider in Slice 2)
// ---------------------------------------------------------------------------
/**
 * Builds a `ProviderAdapter` whose methods throw
 * `ProviderAdapterNotImplementedError`. Used by every Slice 2 provider.
 * Replaced with a real adapter in later slices.
 */
function createStubAdapter(providerId, model, slice) {
    return {
        providerId,
        model,
        async *stream() {
            throw new ProviderAdapterNotImplementedError(providerId, model.id, slice);
        },
        async callWithTools() {
            throw new ProviderAdapterNotImplementedError(providerId, model.id, slice);
        },
    };
}
//# sourceMappingURL=adapter.js.map