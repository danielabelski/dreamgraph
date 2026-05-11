"use strict";
// STRICT ISOLATION (ADR-140): no import from v1.
// Slice 8A.1 — Orchestrator port interfaces.
//
// The orchestrator loop is pure (no I/O). Every effect is an injected
// port. Sub-slices 8A.2-8A.5 implement these ports against real systems
// (provider HTTP, MCP client, vscode.ExtensionContext storage, webview
// postMessage). Tests inject in-memory fakes.
//
// Hard rules:
//  - Ports are interfaces (or readonly object types); no classes here.
//  - Every method is async (even when the implementation is sync) so the
//    orchestrator never has to special-case the wire.
//  - No port returns `void`; either a typed result or `Promise<void>`
//    explicitly. Silent ports hide bugs.
//  - No port mutates its arguments. The orchestrator owns the TaskState.
Object.defineProperty(exports, "__esModule", { value: true });
exports.SYSTEM_CLOCK = void 0;
exports.SYSTEM_CLOCK = Object.freeze({
    nowEpochMs: () => Date.now(),
});
//# sourceMappingURL=ports.js.map