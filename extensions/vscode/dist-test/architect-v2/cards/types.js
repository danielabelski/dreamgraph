"use strict";
// STRICT ISOLATION (ADR-140): no import from v1.
// Slice 5 — Cards vNext. Closed taxonomy of 11 card kinds, schemaVersion: 1.
Object.defineProperty(exports, "__esModule", { value: true });
exports.CARD_SCHEMA_VERSION = void 0;
exports.assertNeverCard = assertNeverCard;
/** Current card schema version. Bumping requires a new migration entry. */
exports.CARD_SCHEMA_VERSION = 1;
/** Exhaustiveness helper — every consumer-side switch must use this. */
function assertNeverCard(c) {
    throw new Error(`Unknown card kind: ${JSON.stringify(c)}`);
}
//# sourceMappingURL=types.js.map