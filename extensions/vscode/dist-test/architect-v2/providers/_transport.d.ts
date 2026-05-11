import { ProviderError } from "./adapter";
import type { ProviderId } from "./profile";
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
export declare function readSseLines(res: Response): AsyncIterable<SseFrame>;
export declare function readNdjsonLines(res: Response): AsyncIterable<string>;
/**
 * Default hard cap on serialized request body size. Mirrors v1's 320KB
 * brake. Adapters MAY override via `ProviderConfig.requestSizeLimitBytes`.
 */
export declare const DEFAULT_REQUEST_SIZE_LIMIT_BYTES: number;
export declare function serializeWithBudget(providerId: ProviderId, modelId: string, body: unknown, limitBytes?: number): string;
export declare function mapHttpError(res: Response, providerId: ProviderId, modelId: string): Promise<ProviderError>;
export declare function mapNetworkError(err: unknown, providerId: ProviderId, modelId: string): ProviderError;
export declare function safeJsonParse<T = unknown>(text: string): T | undefined;
//# sourceMappingURL=_transport.d.ts.map