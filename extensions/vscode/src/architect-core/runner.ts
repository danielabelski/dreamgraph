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

import { runPass, type RunPassInput } from "./pass.js";
import type { ArchitectCorePorts } from "./ports.js";
import type { PassResult, ToolDefinition } from "./types.js";
import type { ChatPanelHost } from "./adapters/host.js";
import { SYSTEM_CLOCK } from "./adapters/clock.js";
import {
  createAttachmentPort,
  createAutonomyPort,
  createContextBuilderPort,
  createMemoryPort,
  createPromptComposerPort,
  createProviderPort,
  createToolExecutorPort,
} from "./adapters/v1.js";

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
export function buildV1Ports(host: ChatPanelHost): ArchitectCorePorts {
  return Object.freeze({
    contextBuilder: createContextBuilderPort(host),
    promptComposer: createPromptComposerPort(host),
    provider: createProviderPort(host),
    toolExecutor: createToolExecutorPort(host),
    memory: createMemoryPort(host),
    attachments: createAttachmentPort(host),
    autonomy: createAutonomyPort(host),
    clock: SYSTEM_CLOCK,
  });
}

/**
 * Drive one pass through `runPass()` with the v1-bound port set.
 *
 * The host is the source of truth for envelope, context, autonomy state,
 * and attachment decisions — those are computed once in `handleUserMessage`
 * and projected through `ChatPanelHost`. The runner only orchestrates.
 */
export async function runPassViaCore(input: RunPassViaCoreInput): Promise<PassResult> {
  const ports = buildV1Ports(input.host);
  const driverInput: RunPassInput = {
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
  return runPass(driverInput);
}
