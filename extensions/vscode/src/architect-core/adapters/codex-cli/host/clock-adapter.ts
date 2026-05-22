// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Codex CLI adapter - real clock port (Slice 3).

import type { CodexCliClockPort } from "../orchestrator-ports.js";

export const HOST_CLOCK: CodexCliClockPort = Object.freeze({
  nowMs(): number {
    return Date.now();
  },
});
