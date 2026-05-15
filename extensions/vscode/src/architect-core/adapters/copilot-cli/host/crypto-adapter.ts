// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — real `CopilotCliCryptoPort` (Slice 3).
//
// CSPRNG-backed token + run-id generation via `node:crypto`. Tokens
// are emitted as URL-safe base64 (no padding) so they can land in
// environment variables and config files without escaping.

import { randomBytes, randomUUID } from "node:crypto";

import type { CopilotCliCryptoPort } from "../orchestrator-ports.js";

export const HOST_CRYPTO: CopilotCliCryptoPort = Object.freeze({
  randomToken(byteLength: number): string {
    if (!Number.isInteger(byteLength) || byteLength <= 0) {
      throw new Error("randomToken: byteLength must be a positive integer");
    }
    return randomBytes(byteLength)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  },

  randomRunId(): string {
    // `randomUUID` is path-safe (lowercase hex + hyphens) and stable
    // length, which is what the port contract asks for. Prefix tags
    // it as adapter-minted in logs/audit trails.
    return `copilot-cli-${randomUUID()}`;
  },
});
