"use strict";
// STRICT ISOLATION (ADR-140): no import from v1.
// Slice 5 — Split persistence (DG-heavy) per ADR-159.
// Pure shape + pure mappers. NO I/O. Slice 7 wires durable to MCP entities.
Object.defineProperty(exports, "__esModule", { value: true });
exports.splitForPersistence = splitForPersistence;
exports.createEmptyEphemeralState = createEmptyEphemeralState;
/** Pure split — no I/O, no mutation. */
function splitForPersistence(card, ephemeral) {
    return Object.freeze({
        durable: Object.freeze({ card }),
        ephemeral: freezeEphemeral(ephemeral),
    });
}
function createEmptyEphemeralState() {
    return freezeEphemeral({
        collapsedCardIds: new Set(),
        scrollPosition: 0,
        focusedCardId: null,
    });
}
function freezeEphemeral(s) {
    return Object.freeze({
        collapsedCardIds: s.collapsedCardIds,
        scrollPosition: s.scrollPosition,
        focusedCardId: s.focusedCardId,
    });
}
//# sourceMappingURL=persistence.js.map