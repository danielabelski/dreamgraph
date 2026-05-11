// STRICT ISOLATION (ADR-140): no import from v1.
// Slice 5 — Cards vNext. Closed taxonomy of 11 card kinds, schemaVersion: 1.

import type { ContinuationNeed, AutonomyMode, TaskStatus } from '../autonomy/index.js';
import type {
  Tier,
  ToolOutcome,
  ExecutionPlan,
  FallbackJustification,
  ArtifactRef,
  VerificationEvidence,
} from '../execution/index.js';
import type { PillSet } from './pills.js';

/** Current card schema version. Bumping requires a new migration entry. */
export const CARD_SCHEMA_VERSION = 1 as const;
export type CardSchemaVersion = typeof CARD_SCHEMA_VERSION;

/** Closed taxonomy — ADR-160. No string escape hatch. */
export type CardKind =
  | 'goal'
  | 'plan'
  | 'context'
  | 'decision'
  | 'edit'
  | 'verification'
  | 'blocker'
  | 'next-step'
  | 'completion'
  | 'fallback'
  | 'outcome';

export interface PlanStep {
  readonly id: string;
  readonly description: string;
  readonly intent?: string;
}

export interface BaseCard {
  readonly id: string;
  readonly schemaVersion: CardSchemaVersion;
  readonly taskId: string;
  readonly kind: CardKind;
  readonly createdAtEpochMs: number;
  readonly parentCardId?: string;
  readonly pills: PillSet;
}

export interface GoalCard extends BaseCard {
  readonly kind: 'goal';
  readonly body: {
    readonly statement: string;
    readonly acceptance: readonly string[];
  };
}

export interface PlanCard extends BaseCard {
  readonly kind: 'plan';
  readonly body: {
    readonly steps: readonly PlanStep[];
  };
}

export interface ContextCard extends BaseCard {
  readonly kind: 'context';
  readonly body: {
    readonly sources: readonly ArtifactRef[];
    readonly summary: string;
  };
}

export interface DecisionCard extends BaseCard {
  readonly kind: 'decision';
  readonly body: {
    readonly question: string;
    readonly chosen: string;
    readonly alternatives: readonly string[];
    readonly rationale: string;
    readonly adrRef?: string;
  };
}

export interface EditCard extends BaseCard {
  readonly kind: 'edit';
  readonly body: {
    readonly artifacts: readonly ArtifactRef[];
    readonly diffSummary: string;
  };
}

export interface VerificationCard extends BaseCard {
  readonly kind: 'verification';
  readonly body: {
    readonly evidence: VerificationEvidence;
  };
}

export interface BlockerCard extends BaseCard {
  readonly kind: 'blocker';
  readonly body: {
    readonly reason: string;
    readonly blockedBy: readonly string[];
    readonly suggestedRecovery?: string;
  };
}

export interface NextStepCard extends BaseCard {
  readonly kind: 'next-step';
  readonly body: {
    readonly continuation: ContinuationNeed;
  };
}

export interface CompletionCard extends BaseCard {
  readonly kind: 'completion';
  readonly body: {
    readonly summary: string;
    readonly artifacts: readonly ArtifactRef[];
  };
}

export interface FallbackCard extends BaseCard {
  readonly kind: 'fallback';
  readonly body: {
    readonly plan: ExecutionPlan;
    readonly justification: FallbackJustification;
  };
}

export interface OutcomeCard extends BaseCard {
  readonly kind: 'outcome';
  readonly body: {
    readonly outcome: ToolOutcome;
  };
}

export type Card =
  | GoalCard
  | PlanCard
  | ContextCard
  | DecisionCard
  | EditCard
  | VerificationCard
  | BlockerCard
  | NextStepCard
  | CompletionCard
  | FallbackCard
  | OutcomeCard;

/** Exhaustiveness helper — every consumer-side switch must use this. */
export function assertNeverCard(c: never): never {
  throw new Error(`Unknown card kind: ${JSON.stringify(c)}`);
}

/** Re-exported for convenience to callers that build cards from autonomy/exec types. */
export type { ContinuationNeed, AutonomyMode, TaskStatus };
export type {
  Tier,
  ToolOutcome,
  ExecutionPlan,
  FallbackJustification,
  ArtifactRef,
  VerificationEvidence,
};
