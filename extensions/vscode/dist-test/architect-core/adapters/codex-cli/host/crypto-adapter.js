"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Codex CLI adapter - real crypto port (Slice 3).
Object.defineProperty(exports, "__esModule", { value: true });
exports.HOST_CRYPTO = void 0;
const node_crypto_1 = require("node:crypto");
exports.HOST_CRYPTO = Object.freeze({
    randomToken(byteLength) {
        if (!Number.isInteger(byteLength) || byteLength <= 0) {
            throw new Error("randomToken: byteLength must be a positive integer");
        }
        return (0, node_crypto_1.randomBytes)(byteLength)
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");
    },
    randomRunId() {
        return `codex-cli-${(0, node_crypto_1.randomUUID)()}`;
    },
});
//# sourceMappingURL=crypto-adapter.js.map