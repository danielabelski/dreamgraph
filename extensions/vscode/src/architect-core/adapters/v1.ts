// SPDX-License-Identifier: AGPL-3.0-or-later
//
// architect-core/adapters/v1.ts — Phase 3a (ADR-089).
//
// Real adapter factories that bind the architect-core ports to v1's
// `ChatPanel` internals via a narrow `ChatPanelHost` accessor surface.
// Each factory returns a frozen port object — no classes, no shared
// mutable state, every effect routed through the host.
//
// STRICT v1: no `architect-v2/` imports. Provider knowledge stays
// behind `ArchitectLlm`; no method here names a provider.

import { assemblePrompt } from "../../prompts/index.js";
import { RESPONSES_RAW_ITEMS_KEY } from "../../openai-responses-adapter.js";
import type {
  ArchitectMessage,
  ArchitectToolResponse,
  ToolDefinition as LlmToolDefinition,
} from "../../architect-llm.js";
import type {
  AttachmentPort,
  AutonomyPort,
  BuildContextInput,
  CallProviderInput,
  ComposePromptInput,
  ContextBuilderPort,
  ExecuteToolInput,
  MemoryPort,
  PromptComposerPort,
  ProviderPort,
  ToolExecutorPort,
} from "../ports.js";
import type {
  AutonomyContract,
  BuildContextResult,
  PromptParts,
  ProviderProposal,
  ToolInvocationRecord,
} from "../types.js";
import type { ChatPanelHost } from "./host.js";

// ---------------------------------------------------------------------------
// ContextBuilderPort — host already built the envelope + assembled context;
// the adapter simply re-projects it onto the seam's typed return value.
// ---------------------------------------------------------------------------
export function createContextBuilderPort(host: ChatPanelHost): ContextBuilderPort {
  return Object.freeze({
    async buildContext(_input: BuildContextInput): Promise<BuildContextResult> {
      void _input;
      return Object.freeze({
        envelope: host.envelope,
        assembledContext: host.contextResult.assembledContext,
        reasoningPacket: host.contextResult.reasoningPacket,
        // `reasoningLens` is a string id; v1 doesn't expose one separately
        // through the host today — composer falls back to packet-derived
        // lens selection inside `assemblePrompt`.
        reasoningLens: undefined,
      });
    },
  });
}

// ---------------------------------------------------------------------------
// PromptComposerPort — wraps v1 `assemblePrompt`. The composer is pure;
// it does not reach back into the host.
// ---------------------------------------------------------------------------
export function createPromptComposerPort(host: ChatPanelHost): PromptComposerPort {
  return Object.freeze({
    async composePrompt(input: ComposePromptInput): Promise<PromptParts> {
      const autonomyInstructionState = input.autonomyContract.enabled
        ? {
            mode: input.autonomyContract.mode,
            remainingAutoPasses: input.autonomyContract.remainingAutoPasses,
            completedAutoPasses: input.autonomyContract.completedAutoPasses,
            totalAuthorizedPasses: input.autonomyContract.totalAuthorizedPasses,
            timeBudgetTotalMs: input.autonomyContract.timeBudgetTotalMs,
            timeBudgetStartedAtEpochMs: input.autonomyContract.timeBudgetStartedAtEpochMs,
            enabled: true as const,
          }
        : undefined;

      const prompt = assemblePrompt(
        input.task,
        // assemblePrompt accepts the v1 envelope shape directly.
        input.contextResult.envelope as Parameters<typeof assemblePrompt>[1],
        input.contextResult.assembledContext,
        input.additionalInstructions,
        autonomyInstructionState as Parameters<typeof assemblePrompt>[4],
        input.provider,
        // Forward the packet's lens object so packet-driven framing
        // continues to work; assemblePrompt accepts it or undefined.
        (input.contextResult.reasoningPacket?.task?.lens) as Parameters<typeof assemblePrompt>[6],
      );

      // System message first, then bounded prior messages, then the new
      // user turn. When attachments are present the user content is a
      // typed block array (D3 multi-modal); otherwise a plain string.
      // architect-llm provider serializers translate both shapes per-
      // provider, so the seam stays provider-agnostic.
      const userTurn: ArchitectMessage = input.userIntent.contentBlocks
        ? { role: "user", content: input.userIntent.contentBlocks as ArchitectMessage["content"] }
        : { role: "user", content: input.userIntent.text };

      const conversation: ArchitectMessage[] = [
        { role: "system", content: prompt.system },
        ...input.priorMessages,
        userTurn,
      ];

      void host;

      return Object.freeze({
        system: prompt.system,
        conversation: Object.freeze(conversation.slice()),
      });
    },
  });
}

// ---------------------------------------------------------------------------
// ProviderPort — wraps `ArchitectLlm`.
//
// Two paths kept identical to v1 inline behavior:
//   - tools.length === 0: stream tokens through `architectLlm.stream` so
//     the chat bubble renders incrementally.
//   - tools.length  >  0: route through `callWithTools`, rebuilding the
//     `rawMessages` thread from `iterationHistory` so OpenAI Responses
//     reasoning items + tool_use/tool_result pairs replay in the same
//     shape `runAgenticLoop` would have produced.
// ---------------------------------------------------------------------------
export function createProviderPort(host: ChatPanelHost): ProviderPort {
  return Object.freeze({
    llm: host.architectLlm,

    getCapabilities: () => host.getProviderCapabilities(),

    async callProvider(input: CallProviderInput): Promise<ProviderProposal> {
      const { prompt, tools, iterationHistory, onStreamChunk, abortSignal } = input;

      const wireMessages: ArchitectMessage[] = [...prompt.conversation];

      if (tools.length === 0) {
        // Pure streaming round-trip. No tool calls possible.
        let buffer = "";
        const streamed = await host.architectLlm.stream(
          wireMessages,
          (chunk) => {
            buffer += chunk;
            onStreamChunk?.(chunk);
          },
          abortSignal,
        );
        const text = streamed.content && streamed.content.length > 0 ? streamed.content : buffer;
        const response: ArchitectToolResponse = {
          content: text,
          promptTokens: streamed.promptTokens,
          completionTokens: streamed.completionTokens,
          durationMs: streamed.durationMs,
          toolCalls: [],
          stopReason: "end_turn",
        };
        return Object.freeze({
          response,
          toolCalls: Object.freeze([]) as readonly never[],
        });
      }

      // Tool-enabled round-trip. Reconstruct `rawMessages` from
      // `iterationHistory` so the model sees the same running tool
      // dialogue v1's `runAgenticLoop` builds inline.
      const rawMessages: unknown[] = [];
      for (const iter of iterationHistory) {
        const assistantBlocks: Array<Record<string, unknown>> = [];
        if (iter.assistantText) {
          assistantBlocks.push({ type: "text", text: iter.assistantText });
        }
        for (const call of iter.toolCalls) {
          assistantBlocks.push({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: call.input,
          });
        }
        const assistantMsg: Record<string, unknown> = { role: "assistant", content: assistantBlocks };
        if (iter.providerRawAssistant && iter.providerRawAssistant.length > 0) {
          assistantMsg[RESPONSES_RAW_ITEMS_KEY] = iter.providerRawAssistant;
        }
        rawMessages.push(assistantMsg);

        if (iter.toolInvocations.length > 0) {
          const toolResultBlocks = iter.toolInvocations.map((inv: ToolInvocationRecord) => ({
            type: "tool_result" as const,
            tool_use_id: inv.call.id,
            content: inv.resultText,
            ...(inv.isError ? { is_error: true } : {}),
          }));
          rawMessages.push({ role: "user", content: toolResultBlocks });
        }
      }

      const response = await host.architectLlm.callWithTools(
        wireMessages,
        (tools as readonly LlmToolDefinition[]).slice(),
        rawMessages.length > 0 ? rawMessages : undefined,
        abortSignal,
      );

      // Forward assistant text via the stream sink so the chat bubble
      // updates for tool-call iterations (matches `runAgenticLoop`).
      if (response.content && onStreamChunk) {
        onStreamChunk(response.content);
      }

      return Object.freeze({
        response,
        toolCalls: Object.freeze(response.toolCalls?.slice() ?? []),
      });
    },
  });
}

// ---------------------------------------------------------------------------
// ToolExecutorPort — wraps the host's tool dispatch. The host owns
// MCP/local routing, compression, tool-trace recording, and progress
// events; the adapter only times the call and projects the result.
// ---------------------------------------------------------------------------
export function createToolExecutorPort(host: ChatPanelHost): ToolExecutorPort {
  return Object.freeze({
    async executeTool(input: ExecuteToolInput): Promise<ToolInvocationRecord> {
      const startedAt = Date.now();
      const result = await host.executeTool({
        id: input.call.id,
        name: input.call.name,
        input: input.call.input,
      });
      return Object.freeze({
        call: input.call,
        resultText: result.resultText,
        isError: result.isError,
        durationMs: result.durationMs > 0 ? result.durationMs : Date.now() - startedAt,
      });
    },
  });
}

// ---------------------------------------------------------------------------
// MemoryPort — delegates to the host's persistence helpers so the
// existing anchor-refresh + chat-memory write paths run unchanged.
// ---------------------------------------------------------------------------
export function createMemoryPort(host: ChatPanelHost): MemoryPort {
  return Object.freeze({
    async persistUserMessage(text: string, contentBlocks?: readonly unknown[]): Promise<void> {
      await host.persistUserMessage(text, contentBlocks);
    },
    async persistAssistantMessage(args: {
      readonly content: string;
      readonly verdict?: { readonly level: string; readonly summary: string };
      readonly providerRawAssistant?: readonly unknown[];
    }): Promise<void> {
      await host.persistAssistantMessage({
        content: args.content,
        providerRawAssistant: args.providerRawAssistant,
      });
    },
  });
}

// ---------------------------------------------------------------------------
// AttachmentPort — projects host-side attachment state onto the seam.
// ---------------------------------------------------------------------------
export function createAttachmentPort(host: ChatPanelHost): AttachmentPort {
  return Object.freeze({
    buildContentBlocksForTurn(_text: string): readonly unknown[] | undefined {
      void _text;
      return host.contentBlocks;
    },
    attachmentsDroppedThisTurn(): readonly string[] {
      return host.droppedAttachmentNames;
    },
    async clearAfterDispatch(): Promise<void> {
      await host.clearAttachments();
    },
    summaryForPrompt(): string {
      return host.attachmentSummary;
    },
  });
}

// ---------------------------------------------------------------------------
// AutonomyPort — projects autonomy state onto the seam and drives the
// `recordPassCompleted` host hook after persistence.
// ---------------------------------------------------------------------------
export function createAutonomyPort(host: ChatPanelHost): AutonomyPort {
  return Object.freeze({
    contractForTurn(_promptText: string): AutonomyContract {
      void _promptText;
      const s = host.autonomyState;
      return Object.freeze({
        enabled: host.autonomyEnabled,
        mode: s.mode,
        remainingAutoPasses: s.remainingAutoPasses,
        completedAutoPasses: s.completedAutoPasses,
        totalAuthorizedPasses: s.totalAuthorizedPasses,
        timeBudgetTotalMs: s.timeBudgetTotalMs,
        timeBudgetStartedAtEpochMs: s.timeBudgetStartedAtEpochMs,
      });
    },
    async recordPassCompleted(args: {
      readonly assistantText: string;
      readonly toolInvocations: number;
    }): Promise<void> {
      await host.recordPassCompleted(args);
    },
  });
}
