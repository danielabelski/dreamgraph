"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// architect-core/types.ts — Phase 1 strict skeleton (ADR-089).
//
// Concept import from architect-v2/orchestrator/types.ts, re-expressed on
// the v1 type universe. STRICT ISOLATION (ADR-140): this module imports
// nothing from `architect-v2/`. It re-uses v1 types from `architect-llm.ts`
// and `types.ts` so the seam is type-compatible with the production
// chat-panel turn driver.
//
// Phase 1 ships interfaces + types only. No runtime values, no functions,
// no classes. Per the no-empty-stubs rule, an implementation file is not
// added until adapters exist (Phase 2 per ADR-089).
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=types.js.map