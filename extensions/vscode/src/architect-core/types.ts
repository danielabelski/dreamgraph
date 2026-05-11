// SPDX-License-Identifier: AGPL-3.0-or-later
//
// architect-core/types.ts — Phase 1 strict skeleton (ADR-089).
//
// Concept import from architect-v2/orchestrator/types.ts, re-expressed on
// the v1 type universe. STRICT ISOLATION (ADR-140): this module imports
// nothing from `architect-v2/`. It re-uses v1 types from `architect-llm.ts`
// and `types.ts` so the seam is type-compatible with the production
// chat-panel turn driver.
//
// Phase 1 ships interfaces + types only. No runtime values, no functions,
// no classes. Per the no-empty-stubs rule, an implementation file is not
// added until adapters exist (Phase 2 per ADR-089).

import type {
  ArchitectContent,
  ArchitectMessage,
  ArchitectProvider,
  ArchitectToolResponse,
  ToolDefinition,
  ToolUseRequest,
} from "../architect-llm.js";
import type { AutonomyMode } from "../autonomy.js";
import type { ArchitectTask } from "../prompts/index.js";
import type { EditorContextEnvelope, ReasoningPacket } from "../types.js";

/**
 * UserIntent — what the host hands to the seam to drive a single pass.
 *
 * Carries the trimmed prompt text, any per-turn attachments (already
 * normalized into provider-agnostic content blocks by the AttachmentPort),
 * and the small set of session signals chat-panel needs to route the turn
 * (instance binding, autonomy override parsed from the prompt, optional
 * stop-context resume payload from a prior pass).
 *
 * Mirrors the v2 `UserIntent` concept but stays on v1 types: no
 * `ProjectGraphNodeId`, no `GraphScope` — those belong to Phase 5.
 */
export interface UserIntent {
  /** Trimmed user prompt text. May be empty when only attachments are sent. */
  readonly text: string;
  /**
   * Provider-agnostic content blocks for the user message body. When the
   * turn carries no attachments this is `undefined` and the seam sends
   * `text` as a plain string (matches today's chat-panel behavior).
   * When attachments are present this is the canonical block array
   * produced by `_buildUserContentBlocks`; the architect-llm provider
   * adapters serialize it per provider (ADR-089 + D3 fix).
   */
  readonly contentBlocks?: readonly ArchitectContent[];
  /** Active DreamGraph instance binding for persistence routing. */
  readonly instanceId?: string;
  /**
   * Stop-context block carried over from a previous autonomy pass that
   * paused mid-task. The seam injects it into the system prompt so
   * "resume" re-enters from the known task position. `undefined` for
   * fresh turns.
   */
  readonly stopContextBlock?: string;
}

/**
 * AutonomyContract — the visible counters and reporting requirements
 * threaded into the system prompt for an autonomy-enabled pass. Mirrors
 * the v1 autonomy state shape so chat-panel can construct it from
 * `parseAutonomyRequest` without a transformation step.
 */
export interface AutonomyContract {
  readonly enabled: boolean;
  readonly mode: AutonomyMode;
  readonly remainingAutoPasses: number;
  readonly completedAutoPasses: number;
  readonly totalAuthorizedPasses?: number;
  readonly timeBudgetTotalMs?: number;
  readonly timeBudgetStartedAtEpochMs?: number;
}

/**
 * PromptParts — the composed prompt for a single provider call.
 *
 * Kept narrow (system + conversation) because v1's `assemblePrompt`
 * already returns this shape. Provider-specific framing (Anthropic
 * `system` field vs OpenAI `developer` role) lives in `architect-llm.ts`
 * adapters, not here.
 */
export interface PromptParts {
  readonly system: string;
  readonly conversation: readonly ArchitectMessage[];
}

/**
 * ProviderProposal — what a single provider call returns to the seam.
 *
 * v1 today returns `ArchitectToolResponse` directly; the seam wraps it so
 * future providers (or replay backends) can attach a normalized verdict
 * preview without touching the architect-llm contract.
 */
export interface ProviderProposal {
  readonly response: ArchitectToolResponse;
  /** Tool calls extracted from the response, in invocation order. */
  readonly toolCalls: readonly ToolUseRequest[];
}

/**
 * ToolInvocationRecord — a single tool call + its outcome captured during
 * a pass. The seam emits these in order; chat-panel renders them via the
 * existing tool-trace channel (no new UI surface).
 */
export interface ToolInvocationRecord {
  readonly call: ToolUseRequest;
  readonly resultText: string;
  readonly isError: boolean;
  readonly durationMs: number;
}

/**
 * PassGoal — a focused sub-goal that drives one coherent unit of
 * progress toward the parent TaskGoal.
 *
 * Slicing rule (binding):
 *   - A pass is one coherent unit of progress toward the task goal.
 *   - Each pass has a focused sub-goal, maintains cognitive continuity
 *     across its inner tool calls, allows many tool calls internally,
 *     and ends with a meaningful state transition that the verdict
 *     layer can assess and the graph layer can record.
 *   - The next pass plans against the recorded state.
 *
 * Example (Task = "Implement transcript persistence"):
 *   Pass 1 sub-goal: "inspect current persistence flow" — read
 *     transcript storage, identify hydration path, maybe patch one
 *     file, maybe run one verification, produce verdict + next step.
 *   Pass 2 sub-goal: "integrate replay/hydration" — patch renderer
 *     edge cases, verify reset flow, summarize outcome.
 *
 * Sizing implication: a sub-goal that produces no assessable state
 * transition ("think about it", "keep going") is not a valid PassGoal.
 * A sub-goal that contains two unrelated coherent units of progress
 * should be split into two passes.
 *
 * Optional today: when omitted the pass runs in legacy free-form mode
 * (matches today's chat-panel behavior). Recommended for Phase 3+.
 */
export interface PassGoal {
  readonly id: string;
  /** The focused sub-goal: one coherent unit of progress toward the task. */
  readonly summary: string;
  /**
   * Free-form description of the meaningful state transition that
   * marks this pass complete (what the verdict layer scores against).
   */
  readonly successCriteria?: string;
}

/**
 * TaskGoal — the larger objective the parent task is driving toward.
 *
 * The task is the sum of its passes. Each completed pass advances the
 * task by one coherent unit of progress whose outcome has been
 * assessed and recorded into the graph. The seam never edits a
 * TaskGoal; goal lifecycle (decomposing the task into sub-goals,
 * marking sub-goals complete, deciding when the task is done) is
 * owned by the autonomy continuation engine that plans pass N+1 from
 * the graph state recorded after pass N.
 */
export interface TaskGoal {
  readonly id: string;
  readonly summary: string;
  /** Sub-goals already completed for this task, in completion order. */
  readonly completedPassGoals?: readonly PassGoal[];
}

/**
 * IterationOutcome — one inner round-trip inside a single pass: the
 * provider's response + the tool batch the seam executed against it.
 *
 * v1 chat-panel iterates this loop up to ~12 times per pass when the
 * provider keeps emitting tool_use blocks ("tens of consecutive tool
 * calls per pass when they serve the pass goal" — that is the design
 * point this type makes explicit at the seam).
 */
export interface IterationOutcome {
  /** 1-based iteration index within the pass. */
  readonly index: number;
  /** Assistant text emitted in this iteration (may be empty). */
  readonly assistantText: string;
  /** Tool calls the provider emitted in this iteration. */
  readonly toolCalls: readonly ToolUseRequest[];
  /** Tool invocation records aligned 1:1 with `toolCalls`. */
  readonly toolInvocations: readonly ToolInvocationRecord[];
  /**
   * Provider-specific verbatim assistant items for this iteration
   * (e.g. OpenAI Responses output[] including reasoning items). The
   * adapter threads these through unchanged so the next iteration's
   * provider call can replay them.
   */
  readonly providerRawAssistant?: readonly unknown[];
}

/**
 * Reason a pass stopped iterating. `complete` = provider emitted no more
 * tool calls (the natural stop). `max-iterations` = the inner cap was
 * reached. `aborted` = the host signal cancelled the pass.
 * `error` = an uncaught provider/tool error escaped to the driver.
 */
export type PassStopReason =
  | "complete"
  | "max-iterations"
  | "aborted"
  | "error";

/**
 * Verdict — minimal shape matching what `chat-panel.ts` already writes
 * onto assistant messages. Re-stated here so the PassResult is closed
 * over a single import surface; the v1 `chat-memory.ts` `verdict` type
 * is identical (`{ level: string; summary: string }`).
 */
export interface Verdict {
  readonly level: string;
  readonly summary: string;
}

/**
 * PassResult — the typed envelope returned by `runPass()`.
 *
 * Designed to be the assessable, graph-recordable record of one
 * coherent unit of progress toward the task goal. The verdict layer
 * reads `iterations` + `toolInvocations` to score whether the
 * sub-goal was reached (the meaningful state transition); the graph
 * layer records the outcome so the next pass plans against the
 * updated state.
 *
 * Invariants:
 *  - `assistantMessage.content` is the concatenated user-visible
 *    assistant text across all inner iterations (empty string is
 *    permitted when the pass produced only tool invocations).
 *  - `iterations` is non-empty for every terminated pass (even on
 *    error a synthetic iteration is appended carrying the failure
 *    message) so the assessor always has something to score.
 *  - `toolInvocations` is the flat in-order view of every tool call
 *    executed during the pass; `iterations[i].toolInvocations` is the
 *    per-iteration breakdown. Cognitive continuity across iterations
 *    is preserved by reusing the same composed prompt and surfacing
 *    growing iteration history to the provider adapter.
 *  - `verdict` is set when the seam derived one; `undefined` when the
 *    legacy verdict-extraction path on chat-panel will produce it.
 *  - `endedAtEpochMs` − `startedAtEpochMs` is the wall-clock pass
 *    duration used by the budget coordinator and tool-trace timing.
 */
export interface PassResult {
  readonly startedAtEpochMs: number;
  readonly endedAtEpochMs: number;
  readonly assistantMessage: {
    /** Concatenated assistant text across all iterations of the pass. */
    readonly content: string;
    readonly verdict?: Verdict;
  };
  /**
   * Inner agentic-loop iterations executed during this pass, in order.
   * `iterations.length` is bounded by the driver's `maxIterations` cap.
   */
  readonly iterations: readonly IterationOutcome[];
  /**
   * Flat tool-invocation list across all iterations, in execution order.
   * Convenience view for callers that only need the trace; equivalent to
   * `iterations.flatMap(i => i.toolInvocations)`.
   */
  readonly toolInvocations: readonly ToolInvocationRecord[];
  /** Why the pass stopped iterating. */
  readonly stopReason: PassStopReason;
  /**
   * Provider-specific verbatim assistant items from the FINAL iteration.
   * Threaded through to the persistence layer so the next pass's replay
   * logic in chat-panel keeps working.
   */
  readonly providerRawAssistant?: readonly unknown[];
  /**
   * Stop-context block to persist for the next pass's resume injection.
   * `undefined` when the pass completed cleanly with no continuation.
   */
  readonly nextStopContextBlock?: string;
  /**
   * Names of attachments that were silently dropped this pass because
   * the active provider/model could not accept them (e.g. images on
   * Ollama). The host posts a SYSTEM card per name; the seam only
   * reports the fact (D3 behavior preserved across the seam).
   */
  readonly droppedAttachments: readonly string[];
  /** Pass goal this pass was driving toward, when one was supplied. */
  readonly passGoal?: PassGoal;
  /** Task goal this pass contributed to, when one was supplied. */
  readonly taskGoal?: TaskGoal;
}

/**
 * BuildContextResult — v1 produces the envelope and the assembled
 * context block (a string baked from the reasoning packet) in two stages
 * but always together. The seam returns both as one value so the
 * PromptComposerPort never has to call back into the assembler.
 */
export interface BuildContextResult {
  readonly envelope: EditorContextEnvelope | null;
  /** Assembled context text (already tier-trimmed, ADR-097-safe). */
  readonly assembledContext: string;
  /** Reasoning packet when one was produced; undefined for shallow turns. */
  readonly reasoningPacket?: ReasoningPacket | null;
  /** Lens carried out of the reasoning packet; forwarded to the composer. */
  readonly reasoningLens?: string;
}

export type {
  ArchitectContent,
  ArchitectMessage,
  ArchitectProvider,
  ArchitectTask,
  ArchitectToolResponse,
  EditorContextEnvelope,
  ReasoningPacket,
  ToolDefinition,
  ToolUseRequest,
};
