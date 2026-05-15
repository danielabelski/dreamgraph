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

import {
  createCopilotCliProviderPort,
  type CopilotCliProviderPortOptions,
} from "./adapters/copilot-cli/index.js";

export interface CopilotCliPortBundleOptions {
  readonly host: ChatPanelHost;
  readonly providerOptions: CopilotCliProviderPortOptions;
}

/**
 * Build a port set where the provider port is the Copilot CLI wrapper.
 * Every other port is reused from the v1 wiring. Pure construction —
 * performs no I/O.
 */
export function buildCopilotCliPorts(
  options: CopilotCliPortBundleOptions,
): ArchitectCorePorts {
  const v1 = buildV1Ports(options.host);
  return Object.freeze({
    ...v1,
    provider: createCopilotCliProviderPort(options.providerOptions),
  });
}

export interface RunPassViaCopilotCliInput extends RunPassViaCoreInput {
  readonly providerOptions: CopilotCliProviderPortOptions;
}

/**
 * Drive one pass through `runPass()` with the Copilot CLI provider
 * port wired in. Returns the typed `PassResult` to the caller exactly
 * like `runPassViaCore`.
 */
export async function runPassViaCopilotCli(
  input: RunPassViaCopilotCliInput,
): Promise<PassResult> {
  const ports = buildCopilotCliPorts({
    host: input.host,
    providerOptions: input.providerOptions,
  });
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
