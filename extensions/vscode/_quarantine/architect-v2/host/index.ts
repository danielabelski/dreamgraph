// STRICT ISOLATION (ADR-140 + ADR-171): no v1 imports; no
// mcp_dreamgraph_* imports outside the dreamgraph adapter package
// (which itself is allowed under the ADR-171 carve-out).
//
// Slice 8A.5 — Architect-v2 host wiring.
//
// This module is the single place the VS Code extension activates the
// v2 orchestrator. It assembles every port (real or null), resolves the
// provider window once, and returns a `runArchitectPass` function the
// extension's chat panel can call without knowing port internals.
//
// The cutover (v10.0.0 atomic commit) replaces extension.ts's call to
// the v1 entry point with a call to `createArchitectHost(...)` returned
// here. Until then this module has no callers; build verifies it
// compiles in isolation.

import { DefaultContextBuilder } from "../context/index.js";
import {
  NullContextDiscoveryRecorder,
  NullFallbackSignalProvider,
  type ContextDiscoveryRecorder,
  type FallbackSignalProvider,
} from "../context/index.js";
import {
  DefaultMemoryAdapter,
  InMemoryKeyValueStore,
  NullMemoryPort,
  type KeyValueStore,
} from "../memory/index.js";
import {
  DreamGraphReaderAdapter,
  DreamGraphRecorderAdapter,
  NullProjectGraphReader,
  NullProjectGraphRecorder,
  runPass,
  SYSTEM_CLOCK,
  UnboundMcpClient,
  type ClockPort,
  type ExecutorPort,
  type McpClient,
  type MemoryPort,
  type OrchestratorPorts,
  type PassResult,
  type ProjectGraphReader,
  type ProjectGraphRecorder,
  type RunPassInput,
} from "../orchestrator/index.js";
import { DefaultPromptComposer } from "../prompts/index.js";
import {
  resolveModel,
  type ProviderConfig,
  type ProviderId,
  type ProviderProfile,
} from "../providers/index.js";
import type { TaskState } from "../autonomy/index.js";
import type { UserIntent } from "../orchestrator/types.js";
import {
  ExecutorAdapter,
  resolveLiveCatalog,
  type EditorBridge,
  type ShellBridge,
} from "../execution/executor-adapter.js";
import { EMPTY_DENSITY_PROBE, type DensityProbe } from "../capabilities/index.js";

// ---------------------------------------------------------------------------
// Wiring options
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Public host surface
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createArchitectHost(
  options: ArchitectHostOptions,
): Promise<ArchitectHost> {
  const { provider, model } = await resolveModel(
    options.providerId,
    options.modelIdOverride,
  );
  const windowTokens = options.windowTokensOverride ?? model.contextWindow;

  const clock = options.clock ?? SYSTEM_CLOCK;

  // Memory wiring.
  const memory: MemoryPort = options.workspaceState
    ? new DefaultMemoryAdapter({ store: options.workspaceState })
    : options.workspaceState === undefined && options.memoryNamespace === undefined
    ? NullMemoryPort
    : new DefaultMemoryAdapter({ store: new InMemoryKeyValueStore() });

  // DreamGraph adapter pair (or Null pair when no MCP client wired).
  const projectGraphReader: ProjectGraphReader = options.mcpClient
    ? new DreamGraphReaderAdapter({ client: options.mcpClient })
    : NullProjectGraphReader;

  const dreamGraphRecorder = options.mcpClient
    ? new DreamGraphRecorderAdapter({
        client: options.mcpClient,
        logErrors: options.logMcpErrors ?? false,
      })
    : undefined;

  const projectGraphRecorder: ProjectGraphRecorder =
    dreamGraphRecorder ?? NullProjectGraphRecorder;

  const discoveryRecorder: ContextDiscoveryRecorder =
    dreamGraphRecorder ?? NullContextDiscoveryRecorder;

  const fallback: FallbackSignalProvider =
    options.fallback ?? new NullFallbackSignalProvider();

  // Composer + builder.
  const promptComposer = new DefaultPromptComposer();
  const contextBuilder = new DefaultContextBuilder({
    graphReader: projectGraphReader,
    fallback,
    discoveryRecorder,
  });

  // Executor wiring: caller-supplied or built from the resolved provider.
  let executor: ExecutorPort;
  if (options.executor) {
    executor = options.executor;
  } else {
    if (!options.providerConfig) {
      throw new Error(
        "createArchitectHost: providerConfig is required when no explicit executor is supplied.",
      );
    }
    const mcpForExecutor = options.mcpClient ?? new UnboundMcpClient();
    const resolvedCatalog = await resolveLiveCatalog({
      mcpClient: mcpForExecutor,
    });
    executor = new ExecutorAdapter({
      providerProfile: provider,
      model,
      providerConfig: options.providerConfig,
      mcpClient: mcpForExecutor,
      resolvedCatalog,
      densityProbe: options.densityProbe ?? EMPTY_DENSITY_PROBE,
      editorBridge: options.editorBridge,
      shellBridge: options.shellBridge,
      clock,
    });
  }

  // Wrap executor with an activity tap when a listener is supplied.
  // The wrapper calls the listener best-effort; errors are swallowed.
  if (options.onExecutorEvent) {
    executor = wrapExecutorWithActivity(executor, options.onExecutorEvent, clock);
  }

  const ports: OrchestratorPorts = Object.freeze({
    contextBuilder,
    promptComposer,
    executor,
    memory,
    clock,
    projectGraphReader,
    projectGraphRecorder,
  });

  return Object.freeze({
    providerProfile: provider,
    windowTokens,
    ports,
    async runPass(input: HostRunPassInput): Promise<PassResult> {
      const passInput: RunPassInput = {
        taskState: input.taskState,
        userIntent: input.userIntent,
        providerProfile: provider,
        ports,
        windowTokens,
      };
      return runPass(passInput);
    },
  });
}

/**
 * Wraps an ExecutorPort so each `executeCapability` call emits start /
 * end activity events to the supplied listener. The wrapper is a thin
 * pass-through; listener errors are swallowed so they cannot affect
 * orchestrator semantics.
 */
function wrapExecutorWithActivity(
  inner: ExecutorPort,
  listener: ExecutorEventListener,
  clock: ClockPort,
): ExecutorPort {
  const safeEmit = (event: ExecutorEvent): void => {
    try {
      listener(event);
    } catch {
      // Best-effort UI tap; never let it break a pass.
    }
  };
  return {
    callProvider: inner.callProvider.bind(inner),
    async executeCapability(input) {
      const reasonKind = input.invocationReason.kind;
      const verificationKind =
        input.invocationReason.kind === "verification"
          ? input.invocationReason.verificationKind
          : undefined;
      safeEmit({
        phase: "start",
        capabilityId: String(input.capabilityId),
        toolName: input.toolName,
        invocationReasonKind: reasonKind,
        verificationKind,
        atEpochMs: clock.nowEpochMs(),
      });
      try {
        const outcome = await inner.executeCapability(input);
        safeEmit({
          phase: "end",
          capabilityId: String(input.capabilityId),
          toolName: input.toolName ?? outcome.tool,
          invocationReasonKind: reasonKind,
          verificationKind,
          succeeded: outcome.kind === "success",
          atEpochMs: clock.nowEpochMs(),
        });
        return outcome;
      } catch (err) {
        safeEmit({
          phase: "end",
          capabilityId: String(input.capabilityId),
          toolName: input.toolName,
          invocationReasonKind: reasonKind,
          verificationKind,
          succeeded: false,
          atEpochMs: clock.nowEpochMs(),
        });
        throw err;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Re-exports for host consumers (so extension.ts has one import root)
// ---------------------------------------------------------------------------

export {
  UnboundMcpClient,
  type McpClient,
  type ClockPort,
  type ExecutorPort,
  type MemoryPort,
  type OrchestratorPorts,
  type PassResult,
  type ProjectGraphReader,
  type ProjectGraphRecorder,
} from "../orchestrator/index.js";

export {
  type FallbackSignalProvider,
  type ContextDiscoveryRecorder,
} from "../context/index.js";

export {
  type KeyValueStore,
  InMemoryKeyValueStore,
} from "../memory/index.js";

export { VSCodeFallbackSignalProvider } from "./vscode-fallback-signal-provider.js";
export { VSCodeMementoStore } from "./vscode-memento-store.js";
export { V1McpClientBridge, type V1McpClientLike } from "./mcp-client-bridge.js";
export {
  ArchitectV2Panel,
  type ArchitectV2PanelOptions,
} from "./chat-panel/index.js";
export {
  ExecutorAdapter,
  resolveLiveCatalog,
  type EditorBridge,
  type ShellBridge,
} from "../execution/executor-adapter.js";
