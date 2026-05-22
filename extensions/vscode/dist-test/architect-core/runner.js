"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// architect-core/runner.ts — Phase 3a (ADR-089).
//
// Top-level wiring for the v1 architect-core seam. Builds the full
// `ArchitectCorePorts` bag from a `ChatPanelHost` and runs one pass.
// Returns the typed `PassResult` to the caller; the host renders it.
//
// Phase 3a routing predicate (in ChatPanel): the seam currently runs
// only for text-only turns (no attachments) without autonomy
// continuation. All other paths fall through to the inline orchestration
// in `chat-panel.handleUserMessage`. The flag `dreamgraph.architect.useCorePass`
// gates entry. When the flag is off, behavior is byte-identical to today.
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildV1Ports = buildV1Ports;
exports.runPassViaCore = runPassViaCore;
exports.buildCopilotCliPorts = buildCopilotCliPorts;
exports.runPassViaCopilotCli = runPassViaCopilotCli;
exports.buildCodexCliPorts = buildCodexCliPorts;
exports.runPassViaCodexCli = runPassViaCodexCli;
const pass_js_1 = require("./pass.js");
const clock_js_1 = require("./adapters/clock.js");
const v1_js_1 = require("./adapters/v1.js");
/**
 * Build the v1-bound port set for `host`. Pure construction — performs
 * no I/O. Exposed so callers can introspect or replace individual ports
 * during integration tests; production callers should use `runPassViaCore`.
 */
function buildV1Ports(host) {
    return Object.freeze({
        contextBuilder: (0, v1_js_1.createContextBuilderPort)(host),
        promptComposer: (0, v1_js_1.createPromptComposerPort)(host),
        provider: (0, v1_js_1.createProviderPort)(host),
        toolExecutor: (0, v1_js_1.createToolExecutorPort)(host),
        memory: (0, v1_js_1.createMemoryPort)(host),
        attachments: (0, v1_js_1.createAttachmentPort)(host),
        autonomy: (0, v1_js_1.createAutonomyPort)(host),
        clock: clock_js_1.SYSTEM_CLOCK,
    });
}
/**
 * Drive one pass through `runPass()` with the v1-bound port set.
 *
 * The host is the source of truth for envelope, context, autonomy state,
 * and attachment decisions — those are computed once in `handleUserMessage`
 * and projected through `ChatPanelHost`. The runner only orchestrates.
 */
async function runPassViaCore(input) {
    const ports = buildV1Ports(input.host);
    const driverInput = {
        userIntent: {
            text: input.text,
            contentBlocks: input.host.contentBlocks,
            stopContextBlock: input.host.stopContextBlock,
        },
        ports,
        priorMessages: input.host.priorMessages,
        task: input.host.task,
        provider: input.host.architectLlm.provider ?? "anthropic",
        tools: input.tools,
        budgetCoordinator: input.host.budgetCoordinator,
        onStreamChunk: input.onStreamChunk,
        abortSignal: input.abortSignal,
    };
    return (0, pass_js_1.runPass)(driverInput);
}
// ---------------------------------------------------------------------------
// Copilot CLI surface — Slice 4 host wiring.
//
// Same architect-core seam, but the `provider` port routes the turn to
// the Copilot CLI orchestrator instead of `ArchitectLlm`. Every other
// port (context builder, prompt composer, tool executor, memory,
// attachments, autonomy, clock) reuses the v1 host wiring so the
// chat-panel persistence, autonomy gates, and tool-trace channel
// behave identically regardless of which surface produced the
// assistant turn.
//
// The router (chat panel) chooses between `runPassViaCore` and
// `runPassViaCopilotCli` per turn based on the user's provider
// selection. This file does NOT implement that selection — it only
// makes both wirings available behind matching entry points.
// ---------------------------------------------------------------------------
const index_js_1 = require("./adapters/copilot-cli/index.js");
const index_js_2 = require("./adapters/codex-cli/index.js");
/**
 * Build a port set where the provider port is the Copilot CLI wrapper.
 * Every other port is reused from the v1 wiring. Pure construction —
 * performs no I/O.
 */
function buildCopilotCliPorts(options) {
    const v1 = buildV1Ports(options.host);
    return Object.freeze({
        ...v1,
        provider: (0, index_js_1.createCopilotCliProviderPort)(options.providerOptions),
    });
}
/**
 * Drive one pass through `runPass()` with the Copilot CLI provider
 * port wired in. Returns the typed `PassResult` to the caller exactly
 * like `runPassViaCore`.
 */
async function runPassViaCopilotCli(input) {
    const ports = buildCopilotCliPorts({
        host: input.host,
        providerOptions: input.providerOptions,
    });
    const driverInput = {
        userIntent: {
            text: input.text,
            contentBlocks: input.host.contentBlocks,
            stopContextBlock: input.host.stopContextBlock,
        },
        ports,
        priorMessages: input.host.priorMessages,
        task: input.host.task,
        provider: input.host.architectLlm.provider ?? "anthropic",
        tools: input.tools,
        budgetCoordinator: input.host.budgetCoordinator,
        onStreamChunk: input.onStreamChunk,
        abortSignal: input.abortSignal,
    };
    return (0, pass_js_1.runPass)(driverInput);
}
/**
 * Build a port set where the provider port is the Codex CLI wrapper.
 * Every other port is reused from the v1 wiring. Pure construction -
 * performs no I/O.
 */
function buildCodexCliPorts(options) {
    const v1 = buildV1Ports(options.host);
    return Object.freeze({
        ...v1,
        provider: (0, index_js_2.createCodexCliProviderPort)(options.providerOptions),
    });
}
/**
 * Drive one pass through `runPass()` with the Codex CLI provider port
 * wired in. Chat routing remains a separate integration step; this
 * function exposes the provider-neutral seam for that route.
 */
async function runPassViaCodexCli(input) {
    const ports = buildCodexCliPorts({
        host: input.host,
        providerOptions: input.providerOptions,
    });
    const driverInput = {
        userIntent: {
            text: input.text,
            contentBlocks: input.host.contentBlocks,
            stopContextBlock: input.host.stopContextBlock,
        },
        ports,
        priorMessages: input.host.priorMessages,
        task: input.host.task,
        provider: input.host.architectLlm.provider ?? "anthropic",
        tools: input.tools,
        budgetCoordinator: input.host.budgetCoordinator,
        onStreamChunk: input.onStreamChunk,
        abortSignal: input.abortSignal,
    };
    return (0, pass_js_1.runPass)(driverInput);
}
//# sourceMappingURL=runner.js.map