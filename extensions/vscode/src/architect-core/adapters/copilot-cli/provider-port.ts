// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — `ProviderPort` wrapper (Slice 4).
//
// `createCopilotCliProviderPort` plugs the Slice 2 orchestrator into
// the architect-core `ProviderPort` seam so the chat-panel pass driver
// can route a turn to the Copilot CLI surface without knowing anything
// about `child_process`, `--prompt`, or run directories.
//
// Wire shape:
//
//   pass.ts → ports.provider.callProvider(input)
//        ↓
//     serialize `input.prompt.conversation` to a single prompt string
//        ↓
//     runCopilotCli({ prompt, model, invocationCwd, timeoutMs, … }, deps)
//        ↓
//     project `CopilotCliRunResult` → `ProviderProposal`
//
// IMPORTANT design choices:
//
//  * The CLI surface executes its own tools in-process via the
//    DreamGraph stdio MCP bridge. By the time `runCopilotCli` returns,
//    every tool call the model wanted to make has already happened. We
//    therefore set `proposal.toolCalls = []` and `stopReason = "end_turn"`
//    — there are no pending `ToolUseRequest`s for the pass driver to
//    dispatch. The classified tool-call audit lives on the
//    `CopilotCliRunResult` and is surfaced via the `onRunResult` hook.
//
//  * `ProviderPort.llm` is a non-optional reference to an `ArchitectLlm`
//    instance (escape hatch for adapters). Per the binding rule against
//    empty stubs, we do NOT fabricate one. The factory takes the host's
//    existing `ArchitectLlm` reference as a dependency and exposes it
//    verbatim. The pass driver itself does not consume `port.llm`.
//
//  * Failures from the orchestrator are surfaced as thrown `Error`s
//    annotated with the Copilot-CLI failure code. The pass driver
//    treats provider errors as recoverable and surfaces them to the
//    chat panel; this matches v1 `ArchitectLlm` behavior.
//
//  * `getCapabilities()` reports `imageAttachments: false` and
//    `textAttachments: false`. The CLI accepts only a single string
//    prompt; binary attachments are converted to placeholder text by
//    the prompt serializer to keep multi-modal output uniform.
//
//  * `onStreamChunk`, when supplied, receives the full assistant text
//    once at the end of the run. The CLI does not stream tokens to
//    stdout the way the OpenAI / Anthropic streaming endpoints do;
//    forwarding raw stdout chunks would leak ANSI escapes and partial
//    UI-control bytes into the chat bubble. We deliver the cleaned
//    transcript as a single chunk so the renderer behavior remains
//    provider-agnostic.

import type { ArchitectLlm, ArchitectToolResponse } from "../../../architect-llm.js";
import type {
  CallProviderInput,
  ProviderPort,
} from "../../ports.js";
import type { ProviderProposal } from "../../types.js";

import {
  runCopilotCli,
  type ClassifiedToolCall,
  type CopilotCliDeps,
  type CopilotCliRunResult,
} from "./orchestrator.js";
import { serializeConversationForCopilotCli } from "./prompt-serializer.js";

export interface CopilotCliProviderPortOptions {
  /**
   * Reference to the host's `ArchitectLlm`. Exposed verbatim through
   * `port.llm` to satisfy the architect-core port contract. Not used
   * for any wire calls; the CLI surface owns its own model selection.
   */
  readonly hostLlm: ArchitectLlm;
  /**
   * Working directory passed to every `runCopilotCli` invocation.
   * Typically the workspace root; the orchestrator never writes here.
   */
  readonly invocationCwd: string;
  /**
   * Hard wall-clock cap per turn, in milliseconds. Required (no
   * implicit infinite runs).
   */
  readonly timeoutMs: number;
  /**
   * Base process environment. Forwarded to the orchestrator, which
   * overlays `COPILOT_HOME` and the per-run MCP token without
   * mutating the input map.
   */
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  /**
   * Optional model selector forwarded as `--model <model>` when set.
   */
  readonly model?: string;
  /**
   * Optional override of the binary name. Defaults to `"copilot"`.
   * Useful in tests and when packagers ship a renamed binary.
   */
  readonly binaryName?: string;
  /**
   * Effectful ports the orchestrator depends on. Production code
   * supplies `HOST_FS`, `HOST_PROCESS`, `HOST_CRYPTO`, `HOST_CLOCK`
   * plus `createHostRegistry` / `createHostAudit`. Tests inject fakes.
   */
  readonly deps: CopilotCliDeps;
  /**
   * Observer hook invoked once per provider call with the full
   * `CopilotCliRunResult`. The chat panel uses this to mirror tool-
   * call audit entries into its tool-trace channel and to surface
   * diagnostics. The provider port itself never inspects the result
   * past projecting the `ProviderProposal`.
   */
  readonly onRunResult?: (result: CopilotCliRunResult) => void;
}

function validateOptions(opts: CopilotCliProviderPortOptions): void {
  if (!opts || typeof opts !== "object") {
    throw new Error("createCopilotCliProviderPort: options object is required");
  }
  if (!opts.hostLlm) {
    throw new Error("createCopilotCliProviderPort: hostLlm reference is required");
  }
  if (typeof opts.invocationCwd !== "string" || opts.invocationCwd.length === 0) {
    throw new Error("createCopilotCliProviderPort: invocationCwd must be a non-empty string");
  }
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new Error("createCopilotCliProviderPort: timeoutMs must be a positive finite number");
  }
  if (!opts.baseEnv || typeof opts.baseEnv !== "object") {
    throw new Error("createCopilotCliProviderPort: baseEnv object is required");
  }
  if (!opts.deps || typeof opts.deps !== "object") {
    throw new Error("createCopilotCliProviderPort: deps object is required");
  }
}

function buildFailureError(result: CopilotCliRunResult): Error {
  const failure = result.failure;
  const code = failure?.code ?? "COPILOT_CLI_UNKNOWN_FAILURE";
  const message = failure?.message ?? "Copilot CLI run failed without a failure descriptor";
  const err = new Error(`[${code}] ${message}`);
  (err as Error & { copilotCliFailureCode?: string }).copilotCliFailureCode = code;
  (err as Error & { copilotCliRunResult?: CopilotCliRunResult }).copilotCliRunResult = result;
  return err;
}

function projectProposal(
  result: CopilotCliRunResult,
  classifiedCalls: readonly ClassifiedToolCall[],
): ProviderProposal {
  const transcript = result.transcript;
  const content = transcript ? transcript.assistantText : "";
  const startedAt = result.startedAtEpochMs;
  const endedAt = result.endedAtEpochMs;
  const durationMs = endedAt - startedAt;

  const response: ArchitectToolResponse = {
    content,
    promptTokens: 0,
    completionTokens: 0,
    durationMs: durationMs > 0 ? durationMs : 0,
    toolCalls: [],
    stopReason: "end_turn",
  };

  // The proposal carries no pending tool calls — the CLI executed all
  // of them in-process. Surface the audit through `onRunResult`.
  void classifiedCalls;

  return Object.freeze({
    response,
    toolCalls: Object.freeze([]) as readonly never[],
  });
}

export function createCopilotCliProviderPort(
  options: CopilotCliProviderPortOptions,
): ProviderPort {
  validateOptions(options);

  return Object.freeze({
    llm: options.hostLlm,

    getCapabilities(): { readonly textAttachments: boolean; readonly imageAttachments: boolean } {
      return Object.freeze({ textAttachments: false, imageAttachments: false });
    },

    async callProvider(input: CallProviderInput): Promise<ProviderProposal> {
      const promptText = serializeConversationForCopilotCli(input.prompt.conversation);

      const result = await runCopilotCli(
        {
          prompt: promptText,
          model: options.model,
          invocationCwd: options.invocationCwd,
          timeoutMs: options.timeoutMs,
          abortSignal: input.abortSignal,
          baseEnv: options.baseEnv,
          binaryName: options.binaryName,
          // Note: stdout/stderr chunk listeners are intentionally NOT
          // forwarded. See the file header for the reasoning. We emit
          // the cleaned transcript as a single stream chunk after the
          // run completes.
        },
        options.deps,
      );

      if (options.onRunResult) {
        try {
          options.onRunResult(result);
        } catch {
          // Observer failures must not crash the pass driver.
        }
      }

      if (!result.ok) {
        throw buildFailureError(result);
      }

      const proposal = projectProposal(result, result.toolCalls);

      if (input.onStreamChunk && proposal.response.content.length > 0) {
        input.onStreamChunk(proposal.response.content);
      }

      return proposal;
    },
  });
}
