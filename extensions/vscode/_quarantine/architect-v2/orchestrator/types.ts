// STRICT ISOLATION (ADR-140): no import from v1.
// Slice 8A.1 — Orchestrator placeholder types.
//
// These types are the *contract surface* the runtime sub-slices (8A.2-8A.5)
// must satisfy. Concrete shapes for ContextEnvelope and PromptParts are
// defined here as opaque carriers; their internal structure is owned by
// the `context/` and `prompts/` sub-slices respectively. The orchestrator
// only threads them between ports.

import type { Card } from "../cards/index.js";
import type {
  ActionCandidate,
  ContinuationNeed,
  TaskState,
} from "../autonomy/index.js";
import type { ToolOutcome } from "../execution/index.js";
import type {
  CompletionMetrics,
  CompletionStatus,
} from "../verification/index.js";

/**
 * What the user (or a continuation) is asking the pass to do. The
 * orchestrator builds context and prompts from this; providers turn it
 * into ranked action candidates.
 */
export interface UserIntent {
  /** Free-form natural language goal/instruction for this pass. */
  readonly text: string;
  /** Optional continuation that triggered this pass (Slice 3). */
  readonly continuation?: ContinuationNeed;
  /** Caller-supplied attachments (file URIs, selections, etc.). */
  readonly attachments?: readonly UserAttachment[];
}

export interface UserAttachment {
  readonly kind: "file" | "selection" | "url" | "image";
  readonly uri: string;
  readonly summary?: string;
}

/**
 * Opaque context envelope. Concrete shape owned by sub-slice 8A.3.
 * The orchestrator only passes it from ContextBuilder to PromptComposer.
 */
export interface ContextEnvelope {
  readonly schemaVersion: 1;
  /** Provider-window-aware budget the envelope was built against. */
  readonly windowTokens: number;
  /** Token estimate of the assembled context. */
  readonly estimatedTokens: number;
  /** Free-form sections; opaque to the orchestrator. */
  readonly sections: readonly ContextSection[];
  /**
   * ADR-176: requirements declared by the composer that the assembler
   * could not satisfy (no source produced data, or budget pressure
   * dropped them). Empty array when fully satisfied; never undefined.
   */
  readonly unmetRequirements?: readonly UnmetRequirement[];
}

export interface ContextSection {
  readonly id: string;
  readonly source: "graph" | "file" | "history" | "environment";
  readonly tokens: number;
  readonly content: string;
  /**
   * ADR-176: optional provenance recording which composer-declared
   * requirement this section answered, which signal source served it,
   * and whether it was a fallback substitution. Optional for legacy /
   * test envelopes; assemblers should set it when known.
   */
  readonly provenance?: SectionProvenance;
}

/**
 * ADR-176: per-section provenance. Records which requirement kind the
 * section satisfies and which signal source produced it.
 */
export interface SectionProvenance {
  /** Requirement kind from ContextRequirementManifest, e.g. 'adr_lineage'. */
  readonly requirementKind: string;
  /** Which signal source produced this section. */
  readonly signalSource: "project_graph" | "fallback" | "synthetic";
  /**
   * Set when the section was produced by FallbackSignalProvider in
   * substitution for a graph-shaped requirement (graph reader returned
   * sparse/absent richness). Names the reason for audit.
   */
  readonly fallbackReason?: "graph_sparse" | "graph_absent" | "graph_error";
}

/**
 * ADR-176: a requirement the composer declared that the assembler could
 * not satisfy. Surfaced on ContextEnvelope so the composer/audit can
 * see what was asked for and not delivered.
 */
export interface UnmetRequirement {
  readonly requirementKind: string;
  readonly reason:
    | "no_signal_source"
    | "graph_absent"
    | "fallback_empty"
    | "budget_dropped"
    | "source_error";
  readonly note?: string;
}

/**
 * Opaque prompt parts. Concrete shape owned by sub-slice 8A.2.
 * The orchestrator passes this to the Executor port unchanged.
 */
export interface PromptParts {
  readonly schemaVersion: 1;
  readonly system: string;
  readonly user: string;
  /** Optional tool-use contract appended per provider conventions. */
  readonly toolContract?: string;
}

/**
 * Result of a single orchestrator pass. Returned to the caller (chat panel
 * or continuation driver) for rendering and persistence.
 */
export interface PassResult {
  readonly newTaskState: TaskState;
  /** Cards produced this pass (Slice 5). */
  readonly cards: readonly Card[];
  /** Tool outcomes captured this pass (Slice 4). */
  readonly outcomes: readonly ToolOutcome[];
  /** Per-mutation completion classifications (Slice 7). */
  readonly classifications: readonly CompletionStatus[];
  /** Aggregated metrics for this pass (Slice 7). */
  readonly metrics: CompletionMetrics;
  /** When set, the orchestrator wants the caller to issue a follow-up pass. */
  readonly continuation?: ContinuationNeed;
  /** Free-form one-line summary of what changed (mirrored on PassRecord). */
  readonly deltaSummary: string;
  /**
   * Free-form prose the model emitted alongside its structured tool
   * calls (the classic "By the way, I noticed X" closing remark).
   * The card taxonomy is closed (ADR-160) and cannot host arbitrary
   * commentary, so the chat panel surfaces this verbatim *after* the
   * rendered cards via `renderTrailingNote`. Absent when the model
   * produced no free-form text or only structured output.
   */
  readonly trailingNote?: string;
}

/**
 * Action candidates produced by the provider for this pass. The provider
 * adapter is responsible for parsing its own response shape into this
 * canonical form (Slice 2 responsibility).
 */
export interface ProviderProposal {
  readonly candidates: readonly ActionCandidate[];
  /** Optional free-form rationale string from the model. */
  readonly rationale?: string;
}
