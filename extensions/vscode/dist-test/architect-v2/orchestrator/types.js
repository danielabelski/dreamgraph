"use strict";
// STRICT ISOLATION (ADR-140): no import from v1.
// Slice 8A.1 — Orchestrator placeholder types.
//
// These types are the *contract surface* the runtime sub-slices (8A.2-8A.5)
// must satisfy. Concrete shapes for ContextEnvelope and PromptParts are
// defined here as opaque carriers; their internal structure is owned by
// the `context/` and `prompts/` sub-slices respectively. The orchestrator
// only threads them between ports.
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=types.js.map