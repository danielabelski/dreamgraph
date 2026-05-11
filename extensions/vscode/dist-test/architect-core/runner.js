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
//# sourceMappingURL=runner.js.map