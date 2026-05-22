"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Codex CLI adapter - real clock port (Slice 3).
Object.defineProperty(exports, "__esModule", { value: true });
exports.HOST_CLOCK = void 0;
exports.HOST_CLOCK = Object.freeze({
    nowMs() {
        return Date.now();
    },
});
//# sourceMappingURL=clock-adapter.js.map