"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — real `CopilotCliClockPort` (Slice 3).
//
// Wall-clock time source for the orchestrator. Wraps `Date.now()` so
// tests can substitute a deterministic clock without monkey-patching
// the global.
Object.defineProperty(exports, "__esModule", { value: true });
exports.HOST_CLOCK = void 0;
exports.HOST_CLOCK = Object.freeze({
    nowMs() {
        return Date.now();
    },
});
//# sourceMappingURL=clock-adapter.js.map