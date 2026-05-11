// STRICT ISOLATION (ADR-140): no import from v1.
// Slice 5 — 8-pill set rendered on every card. ADR-161.

import type { AutonomyMode, TaskStatus } from '../autonomy/index.js';
import type {
  Tier,
  ToolOutcome,
  ExecutionPlan,
  FallbackJustification,
  VerificationEvidence,
} from '../execution/index.js';

export type Certainty = 'low' | 'medium' | 'high';
export type GraphBound = 'yes' | 'no' | 'partial';
export type VerificationStatus = 'passed' | 'failed' | 'pending' | null;
export type FallbackReason = FallbackJustification['reason'] | null;

/** Closed pill set — exactly 8 fields, every card carries every pill. */
export interface PillSet {
  readonly certainty: Certainty;
  readonly mode: AutonomyMode;
  readonly provider: string;
  readonly graphBound: GraphBound;
  readonly autonomyState: TaskStatus;
  readonly tier: Tier | null;
  readonly fallbackReason: FallbackReason;
  readonly verificationStatus: VerificationStatus;
}

export type PillKind = keyof PillSet;
export const PILL_KINDS: readonly PillKind[] = Object.freeze([
  'certainty',
  'mode',
  'provider',
  'graphBound',
  'autonomyState',
  'tier',
  'fallbackReason',
  'verificationStatus',
]);

export interface ComputePillsInput {
  readonly certainty: Certainty;
  readonly mode: AutonomyMode;
  readonly provider: string;
  readonly autonomyState: TaskStatus;
  readonly plan?: ExecutionPlan;
  readonly outcome?: ToolOutcome;
  readonly evidence?: VerificationEvidence;
}

/** Pure derivation. Same input → same output, no I/O. */
export function computePills(input: ComputePillsInput): PillSet {
  const tier: Tier | null =
    input.outcome?.tier ?? input.plan?.tier ?? null;

  const fallbackReason: FallbackReason =
    input.plan?.fallbackJustification?.reason ?? null;

  const graphBound: GraphBound = deriveGraphBound(tier, fallbackReason);

  const verificationStatus: VerificationStatus = deriveVerificationStatus(
    input.evidence,
    input.outcome,
  );

  return Object.freeze({
    certainty: input.certainty,
    mode: input.mode,
    provider: input.provider,
    graphBound,
    autonomyState: input.autonomyState,
    tier,
    fallbackReason,
    verificationStatus,
  });
}

function deriveGraphBound(
  tier: Tier | null,
  fallbackReason: FallbackReason,
): GraphBound {
  if (tier === null) return 'no';
  if (tier <= 3) return fallbackReason === null ? 'yes' : 'partial';
  // T4/T5 — by definition outside DreamGraph tiers.
  return 'no';
}

function deriveVerificationStatus(
  evidence: VerificationEvidence | undefined,
  outcome: ToolOutcome | undefined,
): VerificationStatus {
  const ev = evidence ?? (outcome && 'evidence' in outcome ? outcome.evidence : undefined);
  if (!ev) return null;
  return ev.passed ? 'passed' : 'failed';
}
