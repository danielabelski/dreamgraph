import type { Card } from './types.js';
/**
 * Durable record per card — persisted as a DreamGraph entity in Slice 7.
 * Carries the entire card; the only thing NOT durable is webview UI flags.
 */
export interface DurableCardRecord {
    readonly card: Card;
}
/**
 * Ephemeral state held only in the webview. Never sent to MCP.
 * Lost on reload — by design.
 */
export interface EphemeralCardState {
    readonly collapsedCardIds: ReadonlySet<string>;
    readonly scrollPosition: number;
    readonly focusedCardId: string | null;
}
export interface PersistenceSplit {
    readonly durable: DurableCardRecord;
    readonly ephemeral: EphemeralCardState;
}
/** Pure split — no I/O, no mutation. */
export declare function splitForPersistence(card: Card, ephemeral: EphemeralCardState): PersistenceSplit;
export declare function createEmptyEphemeralState(): EphemeralCardState;
//# sourceMappingURL=persistence.d.ts.map