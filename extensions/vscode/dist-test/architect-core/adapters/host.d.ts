import type { ArchitectLlm, ArchitectMessage } from "../../architect-llm.js";
import type { ContextBuilder } from "../../context-builder.js";
import type { AutonomyState } from "../../autonomy.js";
import type { ArchitectContent, ArchitectTask, EditorContextEnvelope, ReasoningPacket } from "../types.js";
/**
 * Narrow accessor surface implemented by `ChatPanel` (Phase 3a).
 *
 * Every method is a thin pass-through to existing chat-panel state —
 * the adapters perform no policy decisions on their own; they just
 * route the runPass driver into v1 internals. This preserves
 * byte-identical behavior under the `useCorePass` flag.
 */
export interface ChatPanelHost {
    /** Live `ArchitectLlm` instance (must already be configured). */
    readonly architectLlm: ArchitectLlm;
    /** Live `ContextBuilder` instance for envelope + assembly. */
    readonly contextBuilder: ContextBuilder;
    /** Per-turn budget coordinator (opaque; forwarded back to v1 internals). */
    readonly budgetCoordinator: unknown;
    /**
     * Bounded prior-conversation slice already truncated by v1's
     * `buildBoundedConversationMessages`. The driver re-uses these as
     * `priorMessages` for the prompt composer.
     */
    readonly priorMessages: readonly ArchitectMessage[];
    /** Architect task type for this turn (`chat` for normal turns). */
    readonly task: ArchitectTask;
    /** Pre-built envelope for this turn (host already called `buildEnvelope`). */
    readonly envelope: EditorContextEnvelope;
    /** Pre-built prompt context (host already called `_buildPromptContext`). */
    readonly contextResult: {
        readonly assembledContext: string;
        readonly reasoningPacket: ReasoningPacket | null;
    };
    /** Snapshot of the autonomy state to expose via `AutonomyPort.contractForTurn`. */
    readonly autonomyState: AutonomyState;
    /** Whether autonomy continuation is enabled this turn. */
    readonly autonomyEnabled: boolean;
    /**
     * Stop-context block carried over from a previous autonomy pass that
     * paused. `undefined` for fresh turns.
     */
    readonly stopContextBlock: string | undefined;
    /** Pre-built attachment content blocks; `undefined` when no attachments. */
    readonly contentBlocks: readonly ArchitectContent[] | undefined;
    /** Names of attachments dropped this turn because the model can't accept them. */
    readonly droppedAttachmentNames: readonly string[];
    /** Plain-text attachment summary for prompt inlining (empty string if none). */
    readonly attachmentSummary: string;
    /** Persist the user message that just shipped to the provider. */
    persistUserMessage(text: string, contentBlocks?: readonly unknown[]): Promise<void>;
    /** Persist the assistant turn after the pass completes. */
    persistAssistantMessage(args: {
        readonly content: string;
        readonly providerRawAssistant?: readonly unknown[];
    }): Promise<void>;
    /** Reset attachment state after the message has shipped (D3 invariant). */
    clearAttachments(): Promise<void>;
    /** Notify autonomy bookkeeping that a pass completed. */
    recordPassCompleted(args: {
        readonly assistantText: string;
        readonly toolInvocations: number;
    }): Promise<void>;
    /** Execute one tool call (MCP or local) and return a normalized result. */
    executeTool(call: {
        readonly id: string;
        readonly name: string;
        readonly input: Record<string, unknown> | undefined;
    }): Promise<{
        readonly resultText: string;
        readonly isError: boolean;
        readonly durationMs: number;
    }>;
    /** Provider/model attachment capability snapshot. */
    getProviderCapabilities(): {
        readonly textAttachments: boolean;
        readonly imageAttachments: boolean;
    };
}
//# sourceMappingURL=host.d.ts.map