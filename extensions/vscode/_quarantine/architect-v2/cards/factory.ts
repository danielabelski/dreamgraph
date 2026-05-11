// STRICT ISOLATION (ADR-140): no import from v1.
// Slice 5 — Card factories. Pure constructors; no I/O, no Date.now() inside —
// callers pass nowEpochMs (mirrors Slice 3 ADR-153).

import {
  CARD_SCHEMA_VERSION,
  type BlockerCard,
  type Card,
  type CompletionCard,
  type ContextCard,
  type DecisionCard,
  type EditCard,
  type FallbackCard,
  type GoalCard,
  type NextStepCard,
  type OutcomeCard,
  type PlanCard,
  type PlanStep,
  type VerificationCard,
  type ArtifactRef,
  type ContinuationNeed,
  type ExecutionPlan,
  type FallbackJustification,
  type ToolOutcome,
  type VerificationEvidence,
} from './types.js';
import { computePills, type ComputePillsInput, type PillSet } from './pills.js';

export interface CardCommon {
  readonly id: string;
  readonly taskId: string;
  readonly nowEpochMs: number;
  readonly parentCardId?: string;
  readonly pills: PillSet;
}

function base<K extends Card['kind']>(
  c: CardCommon,
  kind: K,
): {
  readonly id: string;
  readonly schemaVersion: typeof CARD_SCHEMA_VERSION;
  readonly taskId: string;
  readonly kind: K;
  readonly createdAtEpochMs: number;
  readonly parentCardId?: string;
  readonly pills: PillSet;
} {
  if (!c.id) throw new Error('Card.id required');
  if (!c.taskId) throw new Error('Card.taskId required');
  if (!Number.isFinite(c.nowEpochMs) || c.nowEpochMs <= 0) {
    throw new Error('Card.nowEpochMs must be a positive epoch ms');
  }
  return {
    id: c.id,
    schemaVersion: CARD_SCHEMA_VERSION,
    taskId: c.taskId,
    kind,
    createdAtEpochMs: c.nowEpochMs,
    parentCardId: c.parentCardId,
    pills: c.pills,
  };
}

export function createGoalCard(
  c: CardCommon,
  body: GoalCard['body'],
): GoalCard {
  return Object.freeze({ ...base(c, 'goal'), body: Object.freeze(body) });
}

export function createPlanCard(
  c: CardCommon,
  steps: readonly PlanStep[],
): PlanCard {
  return Object.freeze({
    ...base(c, 'plan'),
    body: Object.freeze({ steps: Object.freeze([...steps]) }),
  });
}

export function createContextCard(
  c: CardCommon,
  body: { sources: readonly ArtifactRef[]; summary: string },
): ContextCard {
  return Object.freeze({
    ...base(c, 'context'),
    body: Object.freeze({
      sources: Object.freeze([...body.sources]),
      summary: body.summary,
    }),
  });
}

export function createDecisionCard(
  c: CardCommon,
  body: DecisionCard['body'],
): DecisionCard {
  return Object.freeze({
    ...base(c, 'decision'),
    body: Object.freeze({
      ...body,
      alternatives: Object.freeze([...body.alternatives]),
    }),
  });
}

export function createEditCard(
  c: CardCommon,
  body: { artifacts: readonly ArtifactRef[]; diffSummary: string },
): EditCard {
  return Object.freeze({
    ...base(c, 'edit'),
    body: Object.freeze({
      artifacts: Object.freeze([...body.artifacts]),
      diffSummary: body.diffSummary,
    }),
  });
}

export function createVerificationCard(
  c: CardCommon,
  evidence: VerificationEvidence,
): VerificationCard {
  return Object.freeze({
    ...base(c, 'verification'),
    body: Object.freeze({ evidence }),
  });
}

export function createBlockerCard(
  c: CardCommon,
  body: BlockerCard['body'],
): BlockerCard {
  return Object.freeze({
    ...base(c, 'blocker'),
    body: Object.freeze({
      ...body,
      blockedBy: Object.freeze([...body.blockedBy]),
    }),
  });
}

export function createCompletionCard(
  c: CardCommon,
  body: { summary: string; artifacts: readonly ArtifactRef[] },
): CompletionCard {
  return Object.freeze({
    ...base(c, 'completion'),
    body: Object.freeze({
      summary: body.summary,
      artifacts: Object.freeze([...body.artifacts]),
    }),
  });
}

/**
 * `next-step` card embeds the `ContinuationNeed` verbatim — toolName, args,
 * and reason are preserved (Slice 3 ADR-154 invariant).
 */
export function createNextStepCard(
  c: CardCommon,
  continuation: ContinuationNeed,
): NextStepCard {
  const tool = continuation?.selectedAction?.tool;
  if (!tool || typeof tool !== 'string') {
    throw new Error('next-step card requires ContinuationNeed with selectedAction.tool');
  }
  return Object.freeze({
    ...base(c, 'next-step'),
    body: Object.freeze({ continuation }),
  });
}

/**
 * Fallback card — derives `pills.fallbackReason` from the justification so
 * renderers never see a null reason on a fallback card.
 */
export function createFallbackCard(
  c: Omit<CardCommon, 'pills'>,
  pillsInput: Omit<ComputePillsInput, 'plan'>,
  plan: ExecutionPlan,
  justification: FallbackJustification,
): FallbackCard {
  const pills = computePills({ ...pillsInput, plan });
  if (pills.fallbackReason === null) {
    // Defensive: if caller passed a plan without a justification, force the
    // pill from the explicit justification arg.
    throw new Error(
      'createFallbackCard requires plan.fallbackJustification to be present',
    );
  }
  return Object.freeze({
    ...base({ ...c, pills }, 'fallback'),
    body: Object.freeze({ plan, justification }),
  });
}

/**
 * Outcome card — derives `pills.tier` and `pills.verificationStatus` from the
 * outcome so callers don't have to plumb both.
 */
export function createOutcomeCard(
  c: Omit<CardCommon, 'pills'>,
  pillsInput: Omit<ComputePillsInput, 'outcome' | 'evidence'>,
  outcome: ToolOutcome,
): OutcomeCard {
  const pills = computePills({ ...pillsInput, outcome });
  return Object.freeze({
    ...base({ ...c, pills }, 'outcome'),
    body: Object.freeze({ outcome }),
  });
}
