"use strict";
// STRICT ISOLATION (ADR-140): no import from v1.
// Slice 5 — Schema migration registry per ADR-162.
// v1 only at Slice 5; future bumps append one entry each.
Object.defineProperty(exports, "__esModule", { value: true });
exports.MIGRATIONS = void 0;
exports.migrate = migrate;
const types_js_1 = require("./types.js");
/**
 * Map: from-version → migrator that takes a card at version `n` and returns
 * a card at version `n+1`. Slice 5 ships v1 only, so the map is empty.
 */
exports.MIGRATIONS = new Map();
/**
 * Walks `card.schemaVersion` up to CARD_SCHEMA_VERSION via registered
 * migrators. If already current, returns the input cast.
 *
 * Throws if a required migrator is missing — never silently drops a card.
 */
function migrate(input) {
    const obj = input;
    const v = obj.schemaVersion;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
        throw new Error(`Cannot migrate card: invalid schemaVersion ${JSON.stringify(v)}`);
    }
    if (v > types_js_1.CARD_SCHEMA_VERSION) {
        throw new Error(`Cannot migrate card from future version ${v} (current ${types_js_1.CARD_SCHEMA_VERSION}).`);
    }
    let current = input;
    let version = v;
    while (version < types_js_1.CARD_SCHEMA_VERSION) {
        const fn = exports.MIGRATIONS.get(version);
        if (!fn) {
            throw new Error(`Missing card migrator for v${version} → v${version + 1}.`);
        }
        current = fn(current);
        version += 1;
    }
    return current;
}
//# sourceMappingURL=migration.js.map