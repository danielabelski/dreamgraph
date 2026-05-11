// SPDX-License-Identifier: AGPL-3.0-or-later
//
// architect-core/adapters/clock.ts — Phase 2 (ADR-089).
//
// Real, complete `ClockPort` implementation. Pure wrapper around
// `Date.now()` so the runPass driver never reads the wall clock
// directly. Tests inject a fake clock that returns a deterministic
// counter.

import type { ClockPort } from "../ports.js";

export const SYSTEM_CLOCK: ClockPort = Object.freeze({
  nowEpochMs: () => Date.now(),
});
