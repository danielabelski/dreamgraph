// STRICT ISOLATION (ADR-140): no import from v1.
// Slice 5 — Split persistence (DG-heavy) per ADR-159.
// Pure shape + pure mappers. NO I/O. Slice 7 wires durable to MCP entities.

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
export function splitForPersistence(
  card: Card,
  ephemeral: EphemeralCardState,
): PersistenceSplit {
  return Object.freeze({
    durable: Object.freeze({ card }),
    ephemeral: freezeEphemeral(ephemeral),
  });
}

export function createEmptyEphemeralState(): EphemeralCardState {
  return freezeEphemeral({
    collapsedCardIds: new Set<string>(),
    scrollPosition: 0,
    focusedCardId: null,
  });
}

function freezeEphemeral(s: EphemeralCardState): EphemeralCardState {
  return Object.freeze({
    collapsedCardIds: s.collapsedCardIds,
    scrollPosition: s.scrollPosition,
    focusedCardId: s.focusedCardId,
  });
}
