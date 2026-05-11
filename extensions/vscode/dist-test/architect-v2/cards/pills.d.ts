import type { AutonomyMode, TaskStatus } from '../autonomy/index.js';
import type { Tier, ToolOutcome, ExecutionPlan, FallbackJustification, VerificationEvidence } from '../execution/index.js';
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
export declare const PILL_KINDS: readonly PillKind[];
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
export declare function computePills(input: ComputePillsInput): PillSet;
//# sourceMappingURL=pills.d.ts.map