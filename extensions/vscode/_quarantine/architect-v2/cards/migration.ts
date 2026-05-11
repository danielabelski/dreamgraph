// STRICT ISOLATION (ADR-140): no import from v1.
// Slice 5 — Schema migration registry per ADR-162.
// v1 only at Slice 5; future bumps append one entry each.

import { CARD_SCHEMA_VERSION, type Card } from './types.js';

export type CardMigrator = (input: unknown) => Card;

/**
 * Map: from-version → migrator that takes a card at version `n` and returns
 * a card at version `n+1`. Slice 5 ships v1 only, so the map is empty.
 */
export const MIGRATIONS: ReadonlyMap<number, CardMigrator> = new Map();

/**
 * Walks `card.schemaVersion` up to CARD_SCHEMA_VERSION via registered
 * migrators. If already current, returns the input cast.
 *
 * Throws if a required migrator is missing — never silently drops a card.
 */
export function migrate(input: unknown): Card {
  const obj = input as { readonly schemaVersion?: unknown };
  const v = obj.schemaVersion;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new Error(
      `Cannot migrate card: invalid schemaVersion ${JSON.stringify(v)}`,
    );
  }
  if (v > CARD_SCHEMA_VERSION) {
    throw new Error(
      `Cannot migrate card from future version ${v} (current ${CARD_SCHEMA_VERSION}).`,
    );
  }
  let current: unknown = input;
  let version = v;
  while (version < CARD_SCHEMA_VERSION) {
    const fn = MIGRATIONS.get(version);
    if (!fn) {
      throw new Error(
        `Missing card migrator for v${version} → v${version + 1}.`,
      );
    }
    current = fn(current);
    version += 1;
  }
  return current as Card;
}
