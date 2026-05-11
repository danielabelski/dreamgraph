// architect-v2/autonomy/signals.ts
// Slice 3 — Decision-layer signals and result shapes.
//
// STRICT ISOLATION (ADR-140): no import from v1.
//
// All discriminated unions on this module use `kind` for the discriminator
// (matches `architect-v2/providers/adapter.ts`).

// ---------------------------------------------------------------------------
// Blockers
// ---------------------------------------------------------------------------

export type BlockerKind =
  | "capability_missing"
  | "permission_denied"
  | "external_dependency"
  | "ambiguous_intent"
  /** Soft blocker: tolerated up to `ModeProfile.blockerTolerance`. */
  | "soft"
  /** Hard blocker: stops the run on the first occurrence regardless of mode. */
  | "hard";

export interface Blocker {
  readonly kind: BlockerKind;
  readonly description: string;
  /** When `kind === 'capability_missing'`, names the capability. */
  readonly requiredCapability?: string;
}

// ---------------------------------------------------------------------------
// Verification failures
// ---------------------------------------------------------------------------

export type VerificationKind =
  | "build"
  | "test"
  | "type"
  | "lint"
  | "mcp_verify"
  | "invariant";

export interface VerificationFailure {
  readonly kind: VerificationKind;
  readonly description: string;
  /** Optional pointer to the artifact (file path, MCP entity id, etc.). */
  readonly artifactRef?: string;
}

// ---------------------------------------------------------------------------
// Action candidates and ranking
// ---------------------------------------------------------------------------

/**
 * (Preserved concept from v1 `RecommendedAction` — but reduced to what the
 * decision engine actually needs. No `mutuallyExclusiveWith`, no `batchGroup`,
 * no `eligible`/`withinScope` doubles. Eligibility is now expressed by
 * `requiresCapabilities` checked against `CapabilityInventory`.)
 */
export interface ActionCandidate {
  readonly id: string;
  readonly label: string;
  readonly rationale: string;
  /**
   * Exact MCP/local tool name. The continuation prompt MUST embed this
   * verbatim (ADR-154); the `ContinuationNeed` constructor enforces.
   */
  readonly tool: string;
  readonly toolArgs?: Readonly<Record<string, unknown>>;
  /** Capabilities required for this action; checked against inventory. */
  readonly requiresCapabilities: readonly string[];
  /**
   * Self-reported confidence by the action's producer, in [0, 1].
   * Higher = more sure this is the right next move.
   */
  readonly confidence: number;
}

export interface RankedActions {
  readonly ranked: readonly ActionCandidate[];
  readonly top?: ActionCandidate;
  readonly alternatives: readonly ActionCandidate[];
}

// ---------------------------------------------------------------------------
// Continuation need (success path)
// ---------------------------------------------------------------------------

/**
 * Returned inside `DecisionResult` when the engine decides to self-continue.
 * INVARIANT (ADR-154): `continuationPrompt` MUST contain `selectedAction.tool`
 * verbatim. Use `createContinuationNeed()` rather than building this literal.
 */
export interface ContinuationNeed {
  readonly selectedAction: ActionCandidate;
  readonly continuationPrompt: string;
  readonly reasoningTrace: string;
  readonly alternativesConsidered: readonly ActionCandidate[];
}

/**
 * Constructor that enforces the ADR-154 invariant. Throws if the prompt does
 * not contain the selected action's tool name. This is intentional — silent
 * tool-name drift is the failure mode v1 made too easy.
 */
export function createContinuationNeed(args: {
  selectedAction: ActionCandidate;
  continuationPrompt: string;
  reasoningTrace: string;
  alternativesConsidered: readonly ActionCandidate[];
}): ContinuationNeed {
  if (!args.continuationPrompt.includes(args.selectedAction.tool)) {
    throw new Error(
      `ADR-154 violation: continuationPrompt must embed the exact tool name '${args.selectedAction.tool}'. ` +
        `Received prompt: ${truncate(args.continuationPrompt, 160)}`,
    );
  }
  return {
    selectedAction: args.selectedAction,
    continuationPrompt: args.continuationPrompt,
    reasoningTrace: args.reasoningTrace,
    alternativesConsidered: args.alternativesConsidered,
  };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

// ---------------------------------------------------------------------------
// Stop conditions
// ---------------------------------------------------------------------------

export type StopCondition =
  | { readonly kind: "goal_reached" }
  | { readonly kind: "pass_budget_exhausted" }
  | { readonly kind: "time_budget_exhausted" }
  | { readonly kind: "blocker"; readonly blocker: Blocker }
  | { readonly kind: "no_progress"; readonly passesWithoutDelta: number }
  | { readonly kind: "no_viable_action" }
  | {
      readonly kind: "verification_failed";
      readonly failure: VerificationFailure;
    }
  | {
      readonly kind: "mode_threshold_unmet";
      readonly topConfidence: number;
      readonly threshold: number;
    }
  | { readonly kind: "user_paused" };

// ---------------------------------------------------------------------------
// Pause reasons
// ---------------------------------------------------------------------------

export type PauseReason =
  | "awaiting_user"
  | "mode_threshold_unmet"
  | "no_clear_winner";

// ---------------------------------------------------------------------------
// DecisionResult — the output of deriveNextAction()
// ---------------------------------------------------------------------------

export type DecisionResult =
  | { readonly kind: "continue"; readonly need: ContinuationNeed }
  | {
      readonly kind: "pause_for_user";
      readonly reason: PauseReason;
      readonly ranked: RankedActions;
      readonly note: string;
    }
  | { readonly kind: "stop"; readonly condition: StopCondition };
