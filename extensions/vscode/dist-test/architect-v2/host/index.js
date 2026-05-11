"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveLiveCatalog = exports.ExecutorAdapter = exports.ArchitectV2Panel = exports.V1McpClientBridge = exports.VSCodeMementoStore = exports.VSCodeFallbackSignalProvider = exports.InMemoryKeyValueStore = exports.UnboundMcpClient = void 0;
exports.createArchitectHost = createArchitectHost;
const index_js_1 = require("../context/index.js");
const index_js_2 = require("../context/index.js");
const index_js_3 = require("../memory/index.js");
const index_js_4 = require("../orchestrator/index.js");
const index_js_5 = require("../prompts/index.js");
const index_js_6 = require("../providers/index.js");
const executor_adapter_js_1 = require("../execution/executor-adapter.js");
const index_js_7 = require("../capabilities/index.js");
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
async function createArchitectHost(options) {
    const { provider, model } = await (0, index_js_6.resolveModel)(options.providerId, options.modelIdOverride);
    const windowTokens = options.windowTokensOverride ?? model.contextWindow;
    const clock = options.clock ?? index_js_4.SYSTEM_CLOCK;
    // Memory wiring.
    const memory = options.workspaceState
        ? new index_js_3.DefaultMemoryAdapter({ store: options.workspaceState })
        : options.workspaceState === undefined && options.memoryNamespace === undefined
            ? index_js_3.NullMemoryPort
            : new index_js_3.DefaultMemoryAdapter({ store: new index_js_3.InMemoryKeyValueStore() });
    // DreamGraph adapter pair (or Null pair when no MCP client wired).
    const projectGraphReader = options.mcpClient
        ? new index_js_4.DreamGraphReaderAdapter({ client: options.mcpClient })
        : index_js_4.NullProjectGraphReader;
    const dreamGraphRecorder = options.mcpClient
        ? new index_js_4.DreamGraphRecorderAdapter({
            client: options.mcpClient,
            logErrors: options.logMcpErrors ?? false,
        })
        : undefined;
    const projectGraphRecorder = dreamGraphRecorder ?? index_js_4.NullProjectGraphRecorder;
    const discoveryRecorder = dreamGraphRecorder ?? index_js_2.NullContextDiscoveryRecorder;
    const fallback = options.fallback ?? new index_js_2.NullFallbackSignalProvider();
    // Composer + builder.
    const promptComposer = new index_js_5.DefaultPromptComposer();
    const contextBuilder = new index_js_1.DefaultContextBuilder({
        graphReader: projectGraphReader,
        fallback,
        discoveryRecorder,
    });
    // Executor wiring: caller-supplied or built from the resolved provider.
    let executor;
    if (options.executor) {
        executor = options.executor;
    }
    else {
        if (!options.providerConfig) {
            throw new Error("createArchitectHost: providerConfig is required when no explicit executor is supplied.");
        }
        const mcpForExecutor = options.mcpClient ?? new index_js_4.UnboundMcpClient();
        const resolvedCatalog = await (0, executor_adapter_js_1.resolveLiveCatalog)({
            mcpClient: mcpForExecutor,
        });
        executor = new executor_adapter_js_1.ExecutorAdapter({
            providerProfile: provider,
            model,
            providerConfig: options.providerConfig,
            mcpClient: mcpForExecutor,
            resolvedCatalog,
            densityProbe: options.densityProbe ?? index_js_7.EMPTY_DENSITY_PROBE,
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
    const ports = Object.freeze({
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
        async runPass(input) {
            const passInput = {
                taskState: input.taskState,
                userIntent: input.userIntent,
                providerProfile: provider,
                ports,
                windowTokens,
            };
            return (0, index_js_4.runPass)(passInput);
        },
    });
}
/**
 * Wraps an ExecutorPort so each `executeCapability` call emits start /
 * end activity events to the supplied listener. The wrapper is a thin
 * pass-through; listener errors are swallowed so they cannot affect
 * orchestrator semantics.
 */
function wrapExecutorWithActivity(inner, listener, clock) {
    const safeEmit = (event) => {
        try {
            listener(event);
        }
        catch {
            // Best-effort UI tap; never let it break a pass.
        }
    };
    return {
        callProvider: inner.callProvider.bind(inner),
        async executeCapability(input) {
            const reasonKind = input.invocationReason.kind;
            const verificationKind = input.invocationReason.kind === "verification"
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
            }
            catch (err) {
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
var index_js_8 = require("../orchestrator/index.js");
Object.defineProperty(exports, "UnboundMcpClient", { enumerable: true, get: function () { return index_js_8.UnboundMcpClient; } });
var index_js_9 = require("../memory/index.js");
Object.defineProperty(exports, "InMemoryKeyValueStore", { enumerable: true, get: function () { return index_js_9.InMemoryKeyValueStore; } });
var vscode_fallback_signal_provider_js_1 = require("./vscode-fallback-signal-provider.js");
Object.defineProperty(exports, "VSCodeFallbackSignalProvider", { enumerable: true, get: function () { return vscode_fallback_signal_provider_js_1.VSCodeFallbackSignalProvider; } });
var vscode_memento_store_js_1 = require("./vscode-memento-store.js");
Object.defineProperty(exports, "VSCodeMementoStore", { enumerable: true, get: function () { return vscode_memento_store_js_1.VSCodeMementoStore; } });
var mcp_client_bridge_js_1 = require("./mcp-client-bridge.js");
Object.defineProperty(exports, "V1McpClientBridge", { enumerable: true, get: function () { return mcp_client_bridge_js_1.V1McpClientBridge; } });
var index_js_10 = require("./chat-panel/index.js");
Object.defineProperty(exports, "ArchitectV2Panel", { enumerable: true, get: function () { return index_js_10.ArchitectV2Panel; } });
var executor_adapter_js_2 = require("../execution/executor-adapter.js");
Object.defineProperty(exports, "ExecutorAdapter", { enumerable: true, get: function () { return executor_adapter_js_2.ExecutorAdapter; } });
Object.defineProperty(exports, "resolveLiveCatalog", { enumerable: true, get: function () { return executor_adapter_js_2.resolveLiveCatalog; } });
//# sourceMappingURL=index.js.map