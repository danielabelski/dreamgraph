"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — real `CopilotCliCryptoPort` (Slice 3).
//
// CSPRNG-backed token + run-id generation via `node:crypto`. Tokens
// are emitted as URL-safe base64 (no padding) so they can land in
// environment variables and config files without escaping.
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
        // `randomUUID` is path-safe (lowercase hex + hyphens) and stable
        // length, which is what the port contract asks for. Prefix tags
        // it as adapter-minted in logs/audit trails.
        return `copilot-cli-${(0, node_crypto_1.randomUUID)()}`;
    },
});
//# sourceMappingURL=crypto-adapter.js.map