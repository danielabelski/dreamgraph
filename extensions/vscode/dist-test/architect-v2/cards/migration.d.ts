import { type Card } from './types.js';
export type CardMigrator = (input: unknown) => Card;
/**
 * Map: from-version → migrator that takes a card at version `n` and returns
 * a card at version `n+1`. Slice 5 ships v1 only, so the map is empty.
 */
export declare const MIGRATIONS: ReadonlyMap<number, CardMigrator>;
/**
 * Walks `card.schemaVersion` up to CARD_SCHEMA_VERSION via registered
 * migrators. If already current, returns the input cast.
 *
 * Throws if a required migrator is missing — never silently drops a card.
 */
export declare function migrate(input: unknown): Card;
//# sourceMappingURL=migration.d.ts.map