// architect-v2/execution/outcome.ts
// Slice 4 — Provider-neutral ToolOutcome event (ADR-157).
//
// STRICT ISOLATION (ADR-140): no import from v1.
//
// Every tool result — MCP, VS Code, shell — is normalized into one of three
// `ToolOutcome` shapes before any later slice sees it. Cards, the verification
// harness, and the autonomy decision engine all read this exact union.

import type { Intent } from "./intents.js";
import type { Tier } from "./tiers.js";

/**
 * Stable handle to something the tool produced or modified. Same shape
 * Slice 3 `TaskState.artifacts` consumes for no-progress detection.
 */
export interface ArtifactRef {
  readonly kind:
    | "file"
    | "mcp_entity"
    | "graph_edge"
    | "verification"
    | "narrative"
    | "adr"
    | "card";
  readonly id: string;
  /** Optional content hash for delta detection. */
  readonly hash?: string;
}

/**
 * Verification evidence carried by `success` outcomes that are themselves
 * verification operations (build/test/lint/mcp_verify/etc.).
 */
export interface VerificationEvidence {
  readonly kind: "build" | "test" | "type" | "lint" | "mcp_verify" | "invariant";
  readonly passed: boolean;
  readonly summary: string;
  readonly failures?: readonly {
    readonly description: string;
    readonly artifactRef?: string;
  }[];
}

interface OutcomeBase {
  readonly tool: string;
  readonly tier: Tier;
  readonly intent: Intent;
  readonly executedAtEpochMs: number;
  readonly durationMs: number;
}

export interface SuccessOutcome extends OutcomeBase {
  readonly kind: "success";
  readonly artifacts: readonly ArtifactRef[];
  readonly evidence?: VerificationEvidence;
  /**
   * Optional serializable payload returned by the tool (e.g. the JSON
   * body of an MCP read tool like `query_resource`). Surfaced verbatim
   * in the OutcomeCard so the user can see what the tool actually
   * returned. Limited to plain JSON values; large payloads should be
   * truncated by the producer before reaching this field.
   */
  readonly payload?: unknown;
}

export interface FailureOutcome extends OutcomeBase {
  readonly kind: "failure";
  readonly failureReason: string;
  /** True if the orchestrator may retry the same tool with the same args. */
  readonly recoverable: boolean;
  /**
   * If the failure mode suggests trying a different tier (e.g. MCP tool
   * threw → try VS Code), the suggested tier is named here. The orchestrator
   * is free to ignore this hint.
   */
  readonly suggestedFallbackTier?: Tier;
}

export interface PartialOutcome extends OutcomeBase {
  readonly kind: "partial";
  readonly artifacts: readonly ArtifactRef[];
  readonly blockedBy: string;
  /** Same semantics as SuccessOutcome.payload — see above. */
  readonly payload?: unknown;
}

export type ToolOutcome = SuccessOutcome | FailureOutcome | PartialOutcome;

// ---------------------------------------------------------------------------
// Constructors — small, but they exist so callers can't accidentally drift
// from the canonical shape.
// ---------------------------------------------------------------------------

export function success(args: Omit<SuccessOutcome, "kind">): SuccessOutcome {
  validateBase(args);
  return { kind: "success", ...args };
}

export function failure(args: Omit<FailureOutcome, "kind">): FailureOutcome {
  validateBase(args);
  return { kind: "failure", ...args };
}

export function partial(args: Omit<PartialOutcome, "kind">): PartialOutcome {
  validateBase(args);
  return { kind: "partial", ...args };
}

function validateBase(args: OutcomeBase): void {
  if (!args.tool) throw new Error("ToolOutcome.tool must be a non-empty string");
  if (args.durationMs < 0) {
    throw new Error("ToolOutcome.durationMs must be >= 0");
  }
  if (args.executedAtEpochMs <= 0) {
    throw new Error("ToolOutcome.executedAtEpochMs must be > 0");
  }
}

/**
 * True if the outcome modified observable state (an artifact was produced
 * or changed). Used by Slice 3 no-progress detection at the orchestrator
 * boundary.
 */
export function outcomeProducedArtifacts(o: ToolOutcome): boolean {
  if (o.kind === "failure") return false;
  return o.artifacts.length > 0;
}
