"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// architect-core/ports.ts — Phase 1 strict skeleton (ADR-089).
//
// Port interfaces for the v1 architect-core seam. These are the only
// effects the future `runPass()` driver will perform; every effect is
// injected so the driver itself stays pure (no I/O, no globals, no
// `vscode.*` imports).
//
// STRICT ISOLATION (ADR-140): no imports from `architect-v2/`. Concept
// imported from `architect-v2/orchestrator/ports.ts`; types are v1-native.
//
// Hard rules (ADR-089):
//  - Interfaces only in this file. No classes, no const objects, no
//    factory functions. Implementations ship with their adapters in
//    Phase 2.
//  - Every method is async even when an implementation could be sync,
//    so the driver never has to special-case the wire.
//  - No port returns `void`; either a typed result or `Promise<void>`
//    explicitly. Silent ports hide bugs.
//  - Provider-agnostic: no method signature names a provider; per-
//    provider serialization stays in `architect-llm.ts`.
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=ports.js.map