// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — real `CopilotCliClockPort` (Slice 3).
//
// Wall-clock time source for the orchestrator. Wraps `Date.now()` so
// tests can substitute a deterministic clock without monkey-patching
// the global.

import type { CopilotCliClockPort } from "../orchestrator-ports.js";

export const HOST_CLOCK: CopilotCliClockPort = Object.freeze({
  nowMs(): number {
    return Date.now();
  },
});
