import type { ArchitectCorePorts } from "./ports.js";
import type { PassResult, ToolDefinition } from "./types.js";
import type { ChatPanelHost } from "./adapters/host.js";
export interface RunPassViaCoreInput {
    readonly host: ChatPanelHost;
    readonly text: string;
    readonly tools?: readonly ToolDefinition[];
    readonly onStreamChunk?: (chunk: string) => void;
    readonly abortSignal?: AbortSignal;
}
/**
 * Build the v1-bound port set for `host`. Pure construction — performs
 * no I/O. Exposed so callers can introspect or replace individual ports
 * during integration tests; production callers should use `runPassViaCore`.
 */
export declare function buildV1Ports(host: ChatPanelHost): ArchitectCorePorts;
/**
 * Drive one pass through `runPass()` with the v1-bound port set.
 *
 * The host is the source of truth for envelope, context, autonomy state,
 * and attachment decisions — those are computed once in `handleUserMessage`
 * and projected through `ChatPanelHost`. The runner only orchestrates.
 */
export declare function runPassViaCore(input: RunPassViaCoreInput): Promise<PassResult>;
//# sourceMappingURL=runner.d.ts.map