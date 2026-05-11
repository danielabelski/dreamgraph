"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// architect-core/adapters/clock.ts — Phase 2 (ADR-089).
//
// Real, complete `ClockPort` implementation. Pure wrapper around
// `Date.now()` so the runPass driver never reads the wall clock
// directly. Tests inject a fake clock that returns a deterministic
// counter.
Object.defineProperty(exports, "__esModule", { value: true });
exports.SYSTEM_CLOCK = void 0;
exports.SYSTEM_CLOCK = Object.freeze({
    nowEpochMs: () => Date.now(),
});
//# sourceMappingURL=clock.js.map