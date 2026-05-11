import { type FallbackSignalProvider } from "../context/index.js";
import { type KeyValueStore } from "../memory/index.js";
import { type ClockPort, type ExecutorPort, type McpClient, type OrchestratorPorts, type PassResult } from "../orchestrator/index.js";
import { type ProviderConfig, type ProviderId, type ProviderProfile } from "../providers/index.js";
import type { TaskState } from "../autonomy/index.js";
import type { UserIntent } from "../orchestrator/types.js";
import { type EditorBridge, type ShellBridge } from "../execution/executor-adapter.js";
import { type DensityProbe } from "../capabilities/index.js";
/**
 * Everything the host has to provide to stand up the orchestrator.
 * Designed so the VS Code extension can wire it in one place:
 *
 *   const host = await createArchitectHost({
 *     providerId: 'anthropic',
 *     workspaceState: context.workspaceState,        // KeyValueStore-shaped
 *     mcpClient: realMcpClient,                       // optional
 *     fallback: new VSCodeFallbackSignalProvider(),   // optional, 8A.5+
 *     executor: realExecutor,                         // wired by Slice 4
 *   });
 *
 * Every dependency except `providerId` and `executor` is optional; the
 * factory falls back to Null implementations so the host can stand up
 * progressively (sparse-mode + no persistence + no MCP) and still run.
 */
export interface ArchitectHostOptions {
    /** ADR-145 / ADR-150 locked provider id selected by the user. */
    readonly providerId: ProviderId;
    /**
     * Optional explicit model id within the provider. When omitted the
     * factory uses the provider's locked default model. When supplied,
     * `resolveModel` looks it up in the provider's `listModels()` result
     * and throws `UnknownModelError` if the id is not advertised.
     */
    readonly modelIdOverride?: string;
    /**
     * Executor port. When omitted, the factory constructs an
     * `ExecutorAdapter` against the resolved provider + supplied
     * `mcpClient` + (optional) editor / shell bridges. Pass an explicit
     * executor only for tests or for non-default executor wiring.
     */
    readonly executor?: ExecutorPort;
    /**
     * Provider config (api key, base URL, etc.). Required when the
     * factory builds the default ExecutorAdapter; ignored when an
     * explicit `executor` is supplied.
     */
    readonly providerConfig?: ProviderConfig;
    /** Optional editor bridge for Tier-4 dispatch. */
    readonly editorBridge?: EditorBridge;
    /** Optional shell bridge for Tier-5 dispatch. */
    readonly shellBridge?: ShellBridge;
    /**
     * Optional density probe snapshot. Defaults to `EMPTY_DENSITY_PROBE`
     * (drives sparse-mode everywhere). The chat panel may pass a richer
     * probe derived from the last graph snapshot.
     */
    readonly densityProbe?: DensityProbe;
    /**
     * KV transport for MemoryPort. Pass `context.workspaceState` from the
     * extension activate function; it satisfies the structural contract.
     * When omitted, the factory uses an in-process map (useful for tests
     * and one-shot CLI invocations).
     */
    readonly workspaceState?: KeyValueStore;
    /**
     * MCP transport for the DreamGraph adapter pair. When omitted, both
     * the reader and recorder degrade to Null implementations and the
     * orchestrator runs in sparse-mode (still produces complete passes).
     */
    readonly mcpClient?: McpClient;
    /**
     * Non-graph signal provider (filesystem, diagnostics, environment).
     * The 8A.5 host typically wires a VSCodeFallbackSignalProvider
     * adapter; tests pass NullFallbackSignalProvider and assertions
     * exercise sparse-mode behavior.
     */
    readonly fallback?: FallbackSignalProvider;
    /**
     * Optional clock injection for deterministic tests. Defaults to
     * SYSTEM_CLOCK.
     */
    readonly clock?: ClockPort;
    /**
     * Optional explicit window override. When omitted the factory
     * resolves the window from the provider's default model
     * (resolveDefaultModel().model.contextWindow). Set this only when
     * intentionally degrading (e.g. small-context dry runs).
     */
    readonly windowTokensOverride?: number;
    /**
     * When true, persist memory under a non-default key prefix (so the
     * host can isolate test runs from real workspace state). The
     * adapter's default behavior is fine for production; tests opt in.
     */
    readonly memoryNamespace?: string;
    /**
     * When true, log MCP transport errors via console.warn. Off by
     * default for production noise.
     */
    readonly logMcpErrors?: boolean;
    /**
     * Optional listener invoked on every executor capability call so the
     * host can surface live activity to the chat panel (pulsating tool
     * ticker etc.). Pure-best-effort: callback exceptions are swallowed
     * so they cannot affect orchestrator semantics.
     */
    readonly onExecutorEvent?: ExecutorEventListener;
}
/**
 * Lifecycle event for one `executeCapability` invocation. Fires `start`
 * before the underlying executor is awaited and `end` after the result
 * (or error) is observed. The `succeeded` flag is `undefined` for
 * `start` events.
 */
export interface ExecutorEvent {
    readonly phase: "start" | "end";
    readonly capabilityId: string;
    readonly toolName?: string;
    readonly invocationReasonKind: "user_action" | "verification" | "enrichment";
    readonly verificationKind?: string;
    readonly succeeded?: boolean;
    readonly atEpochMs: number;
}
export type ExecutorEventListener = (event: ExecutorEvent) => void;
export interface ArchitectHost {
    readonly providerProfile: ProviderProfile;
    readonly windowTokens: number;
    readonly ports: OrchestratorPorts;
    /**
     * Run one orchestrator pass. Threads the resolved windowTokens into
     * the builder. Returns the canonical PassResult so the chat panel can
     * render cards + push the new task state on subsequent calls.
     */
    runPass(input: HostRunPassInput): Promise<PassResult>;
}
export interface HostRunPassInput {
    readonly taskState: TaskState;
    readonly userIntent: UserIntent;
}
export declare function createArchitectHost(options: ArchitectHostOptions): Promise<ArchitectHost>;
export { UnboundMcpClient, type McpClient, type ClockPort, type ExecutorPort, type MemoryPort, type OrchestratorPorts, type PassResult, type ProjectGraphReader, type ProjectGraphRecorder, } from "../orchestrator/index.js";
export { type FallbackSignalProvider, type ContextDiscoveryRecorder, } from "../context/index.js";
export { type KeyValueStore, InMemoryKeyValueStore, } from "../memory/index.js";
export { VSCodeFallbackSignalProvider } from "./vscode-fallback-signal-provider.js";
export { VSCodeMementoStore } from "./vscode-memento-store.js";
export { V1McpClientBridge, type V1McpClientLike } from "./mcp-client-bridge.js";
export { ArchitectV2Panel, type ArchitectV2PanelOptions, } from "./chat-panel/index.js";
export { ExecutorAdapter, resolveLiveCatalog, type EditorBridge, type ShellBridge, } from "../execution/executor-adapter.js";
//# sourceMappingURL=index.d.ts.map