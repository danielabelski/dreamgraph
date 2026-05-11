// SPDX-License-Identifier: AGPL-3.0-or-later
//
// architect-core/ports.ts — Phase 1 strict skeleton (ADR-089).
//
// Port interfaces for the v1 architect-core seam. These are the only
// effects the future `runPass()` driver will perform; every effect is
// injected so the driver itself stays pure (no I/O, no globals, no
// `vscode.*` imports).
//
// STRICT ISOLATION (ADR-140): no imports from `architect-v2/`. Concept
// imported from `architect-v2/orchestrator/ports.ts`; types are v1-native.
//
// Hard rules (ADR-089):
//  - Interfaces only in this file. No classes, no const objects, no
//    factory functions. Implementations ship with their adapters in
//    Phase 2.
//  - Every method is async even when an implementation could be sync,
//    so the driver never has to special-case the wire.
//  - No port returns `void`; either a typed result or `Promise<void>`
//    explicitly. Silent ports hide bugs.
//  - Provider-agnostic: no method signature names a provider; per-
//    provider serialization stays in `architect-llm.ts`.

import type { ArchitectLlm } from "../architect-llm.js";
import type {
  ArchitectMessage,
  ArchitectProvider,
  ArchitectTask,
  AutonomyContract,
  BuildContextResult,
  IterationOutcome,
  PassGoal,
  PromptParts,
  ProviderProposal,
  TaskGoal,
  ToolDefinition,
  ToolInvocationRecord,
  ToolUseRequest,
  UserIntent,
} from "./types.js";

// ---------------------------------------------------------------------------
// ContextBuilder port — wraps v1 `ContextBuilder.buildEnvelope`
// ---------------------------------------------------------------------------

export interface BuildContextInput {
  readonly userIntent: UserIntent;
  /** Source label (e.g. `"chat"`) propagated into the v1 envelope. */
  readonly commandSource: string;
  /**
   * Pressure-aware coordinator handle. The seam treats this as opaque
   * and forwards it to the underlying v1 ContextBuilder so the existing
   * trim policy continues to apply unchanged.
   */
  readonly budgetCoordinator?: unknown;
}

export interface ContextBuilderPort {
  buildContext(input: BuildContextInput): Promise<BuildContextResult>;
}

// ---------------------------------------------------------------------------
// PromptComposer port — wraps v1 `assemblePrompt`
// ---------------------------------------------------------------------------

export interface ComposePromptInput {
  readonly userIntent: UserIntent;
  readonly contextResult: BuildContextResult;
  /**
   * Bounded conversation history (already truncated by the caller via
   * v1's `buildBoundedConversationMessages`). The composer prepends
   * these to the new user turn it constructs from `userIntent`.
   */
  readonly priorMessages: readonly ArchitectMessage[];
  /**
   * Free-form additional instructions to inline below the context block
   * (attachment summary, stop-context resume, etc.). The composer treats
   * this as opaque text and concatenates it verbatim.
   */
  readonly additionalInstructions?: string;
  readonly autonomyContract: AutonomyContract;
  /**
   * Architect task type (`chat` for normal turns; other values for
   * specialized invocations). Forwarded to v1 `assemblePrompt`.
   */
  readonly task: ArchitectTask;
  /**
   * Active provider name. v1 `assemblePrompt` uses it to inject
   * provider-specific discipline blocks.
   */
  readonly provider: ArchitectProvider;
  /**
   * Per-pass goal the composer can frame the system prompt around.
   * When `undefined` the composer falls back to legacy free-form
   * framing (matches today's chat-panel behavior).
   */
  readonly passGoal?: PassGoal;
  /**
   * Larger task this pass contributes to. The composer references it
   * to anchor multi-pass progress ("pass N for task T").
   */
  readonly taskGoal?: TaskGoal;
}

export interface PromptComposerPort {
  composePrompt(input: ComposePromptInput): Promise<PromptParts>;
}

// ---------------------------------------------------------------------------
// Provider port — wraps `ArchitectLlm` (provider-agnostic at this seam)
// ---------------------------------------------------------------------------

export interface CallProviderInput {
  readonly prompt: PromptParts;
  readonly tools: readonly ToolDefinition[];
  /**
   * Iteration history accumulated during the current pass: every prior
   * inner round-trip's assistant message + tool result batch. The adapter
   * appends these to the wire-level message array so the provider sees
   * the running tool dialogue. Empty array on the first iteration.
   */
  readonly iterationHistory: readonly IterationOutcome[];
  /**
   * Streaming text sink. The port forwards every chunk verbatim; the
   * adapter is responsible for any provider-specific stream shaping
   * (already implemented in v1's `ArchitectLlm`).
   */
  readonly onStreamChunk?: (chunk: string) => void;
  /** Cancellation signal forwarded to the underlying transport. */
  readonly abortSignal?: AbortSignal;
}

export interface ProviderPort {
  /**
   * Send the composed prompt to the active provider via `ArchitectLlm`.
   * Returns the canonical proposal envelope; the architect-core driver
   * never sees the provider's wire format.
   */
  callProvider(input: CallProviderInput): Promise<ProviderProposal>;

  /**
   * Provider/model capability snapshot (image attachments, text
   * attachments). Forwarded to the AttachmentPort so it can decide
   * whether to ship image bytes or post a SYSTEM-card notice (D3
   * behavior preserved).
   */
  getCapabilities(): {
    readonly textAttachments: boolean;
    readonly imageAttachments: boolean;
  };

  /** Reference to the underlying v1 LLM driver (escape hatch for adapters). */
  readonly llm: ArchitectLlm;
}

// ---------------------------------------------------------------------------
// Tool executor port — wraps v1's MCP tool dispatch
// ---------------------------------------------------------------------------

export interface ExecuteToolInput {
  readonly call: ToolUseRequest;
}

export interface ToolExecutorPort {
  /**
   * Invoke a single tool call (MCP or built-in) and return a normalized
   * record. The adapter performs all timing, error capture, and result
   * serialization; the driver only sees the typed record.
   */
  executeTool(input: ExecuteToolInput): Promise<ToolInvocationRecord>;
}

// ---------------------------------------------------------------------------
// Memory port — wraps v1 `persistMessages` + storage
// ---------------------------------------------------------------------------

export interface MemoryPort {
  /**
   * Persist a single user message before the provider call. Returns when
   * durable storage has accepted the write.
   */
  persistUserMessage(text: string, contentBlocks?: readonly unknown[]): Promise<void>;

  /**
   * Persist the assistant message produced by a pass. The seam passes
   * the full `PassResult.assistantMessage` payload; the adapter maps it
   * onto v1's `ChatMessage` shape.
   */
  persistAssistantMessage(args: {
    readonly content: string;
    readonly verdict?: { readonly level: string; readonly summary: string };
    readonly providerRawAssistant?: readonly unknown[];
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Attachment port — wraps the D3 attachment lifecycle
// ---------------------------------------------------------------------------

export interface AttachmentPort {
  /**
   * Build provider-agnostic content blocks for the user message body.
   * Returns `undefined` when no attachments are pending — the driver
   * then sends `text` as a plain string (matches today's behavior for
   * text-only turns).
   */
  buildContentBlocksForTurn(text: string): readonly unknown[] | undefined;

  /**
   * Names of attachments that will be dropped because the active model
   * cannot accept them (e.g. images on Ollama). The driver surfaces
   * these via a SYSTEM card before the provider call (D3 behavior).
   */
  attachmentsDroppedThisTurn(): readonly string[];

  /**
   * Clear pending attachments after they have been bound to the
   * outgoing message. Idempotent. The driver calls this exactly once
   * per pass, before the network call.
   */
  clearAfterDispatch(): Promise<void>;

  /** Short text summary of pending attachments (for prompt inlining). */
  summaryForPrompt(): string;
}

// ---------------------------------------------------------------------------
// Autonomy port — wraps v1's autonomy-state plumbing
// ---------------------------------------------------------------------------

export interface AutonomyPort {
  /**
   * Snapshot of the autonomy contract for the upcoming pass. The driver
   * passes this verbatim to the PromptComposer; no transformation.
   */
  contractForTurn(promptText: string): AutonomyContract;

  /**
   * Notify the autonomy subsystem that a pass has finished and supply
   * the final assistant text + tool count so it can update its
   * pass-budget bookkeeping. The driver calls this exactly once per
   * pass, after persistence.
   */
  recordPassCompleted(args: {
    readonly assistantText: string;
    readonly toolInvocations: number;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Clock port — pure but injected for deterministic tests
// ---------------------------------------------------------------------------

export interface ClockPort {
  nowEpochMs(): number;
}

// ---------------------------------------------------------------------------
// Aggregate port bag passed into `runPass()` (Phase 2)
// ---------------------------------------------------------------------------

export interface ArchitectCorePorts {
  readonly contextBuilder: ContextBuilderPort;
  readonly promptComposer: PromptComposerPort;
  readonly provider: ProviderPort;
  readonly toolExecutor: ToolExecutorPort;
  readonly memory: MemoryPort;
  readonly attachments: AttachmentPort;
  readonly autonomy: AutonomyPort;
  readonly clock: ClockPort;
}
