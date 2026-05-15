"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copilot CLI adapter — orchestrator IO ports (Slice 2).
//
// The orchestrator owns six effectful steps: probe `--help`, validate
// the live MCP tool registry, materialize a per-run `COPILOT_HOME`,
// spawn the CLI, capture stdout/stderr, and read back the audit log
// of MCP tool calls served by the in-process DreamGraph server.
//
// Every effect is hidden behind a port so the orchestrator stays
// unit-testable with `node:test` (no `child_process`, no real `fs`,
// no `node:crypto` randomness in the test paths). Real implementations
// of these ports ship in the host wiring slice.
//
// Hard rules (binding):
//  - Interfaces only in this file. No factories, no const objects.
//  - Every port method is async, even when an implementation could
//    be sync, so the orchestrator never has to special-case the wire.
//  - No port returns `void`; either a typed result or `Promise<void>`
//    explicitly.
//  - Provider-agnostic: nothing here names Anthropic/OpenAI/etc.
//    Only Copilot CLI's spawn shape, because that is what this adapter
//    exists to translate.
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=orchestrator-ports.js.map