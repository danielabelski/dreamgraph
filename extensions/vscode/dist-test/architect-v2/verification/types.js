"use strict";
// STRICT ISOLATION (ADR-140): no import from v1.
// Slice 7 — Verification harness types.
//
// Mirrors plans/ARCHITECT_V2_SLICE7_VERIFICATION.md §2-§5.
// Uses Slice 3 `VerificationKind` and `Blocker` and Slice 4
// `VerificationEvidence` so there is one canonical set of names.
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertNeverStatus = assertNeverStatus;
function assertNeverStatus(s) {
    throw new Error(`Unhandled CompletionStatus kind: ${JSON.stringify(s)}`);
}
//# sourceMappingURL=types.js.map