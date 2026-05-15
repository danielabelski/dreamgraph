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
import { type CopilotCliProviderPortOptions } from "./adapters/copilot-cli/index.js";
export interface CopilotCliPortBundleOptions {
    readonly host: ChatPanelHost;
    readonly providerOptions: CopilotCliProviderPortOptions;
}
/**
 * Build a port set where the provider port is the Copilot CLI wrapper.
 * Every other port is reused from the v1 wiring. Pure construction —
 * performs no I/O.
 */
export declare function buildCopilotCliPorts(options: CopilotCliPortBundleOptions): ArchitectCorePorts;
export interface RunPassViaCopilotCliInput extends RunPassViaCoreInput {
    readonly providerOptions: CopilotCliProviderPortOptions;
}
/**
 * Drive one pass through `runPass()` with the Copilot CLI provider
 * port wired in. Returns the typed `PassResult` to the caller exactly
 * like `runPassViaCore`.
 */
export declare function runPassViaCopilotCli(input: RunPassViaCopilotCliInput): Promise<PassResult>;
//# sourceMappingURL=runner.d.ts.map