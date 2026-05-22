// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Codex CLI adapter - real crypto port (Slice 3).

import { randomBytes, randomUUID } from "node:crypto";

import type { CodexCliCryptoPort } from "../orchestrator-ports.js";

export const HOST_CRYPTO: CodexCliCryptoPort = Object.freeze({
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
    return `codex-cli-${randomUUID()}`;
  },
});
