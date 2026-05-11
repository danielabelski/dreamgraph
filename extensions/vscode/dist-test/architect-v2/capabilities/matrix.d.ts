import type { Intent } from '../execution/index.js';
export type CapabilityGroup = 'navigation' | 'history' | 'mutation' | 'verification' | 'cognition' | 'environment';
export type CapabilityId = 'navigate.symbol' | 'navigate.references' | 'read.file' | 'read.dir' | 'read.markdown.chapter' | 'search.text' | 'search.semantic' | 'search.api' | 'search.data_model' | 'search.ui' | 'read.history.git' | 'read.adr' | 'read.workflow' | 'read.narrative' | 'explain.causal' | 'explain.temporal' | 'plan.remediation' | 'memory.recall' | 'mutate.file.create' | 'mutate.file.edit' | 'mutate.file.patch' | 'mutate.file.append' | 'mutate.file.delete_rename' | 'mutate.markdown.chapter' | 'mutate.api.surface' | 'mutate.graph.wire' | 'mutate.entity.edit' | 'verify.build' | 'verify.test' | 'verify.type' | 'verify.lint' | 'verify.discipline' | 'verify.invariant' | 'memory.persist' | 'cognition.dream' | 'cognition.tension.resolve' | 'task.create_continuation' | 'env.web.fetch' | 'env.terminal.run' | 'env.clipboard' | 'env.diagnostics.live' | 'env.lm.invoke_tool';
export interface CapabilityRecord {
    readonly id: CapabilityId;
    readonly group: CapabilityGroup;
    readonly graphFirst: readonly Intent[];
    readonly fallback: readonly Intent[];
    readonly graphOnly: boolean;
    readonly winRationale: string;
    /** Optional: enrichment intent to queue when fallback is used. */
    readonly enrichOnFallback?: Intent;
}
/**
 * Frozen capability matrix. Mirrors the §2 tables of
 * `plans/ARCHITECT_V2_SLICE6_CAPABILITY_MATRIX.md` 1:1.
 */
export declare const CAPABILITY_MATRIX: readonly CapabilityRecord[];
export declare function getCapability(id: CapabilityId): CapabilityRecord;
export declare const CAPABILITY_COUNT: number;
//# sourceMappingURL=matrix.d.ts.map