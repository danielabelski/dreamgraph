"use strict";
// Slice 8A.5 / M7 — Typed messages exchanged between the v2 ChatPanel
// extension host and its webview.
//
// STRICT ISOLATION (ADR-140 + ADR-171): no v1 imports.
//
// The webview NEVER sees provider output directly. It receives only:
//   - rendered markdown (from renderPass({cards, trailingNote}))
//   - high-level state transitions (idle / running / error / waiting)
//   - explicit user actions echoed back for confirmation
//
// All extension-side state (TaskState, PassResult, raw provider
// responses) stays on the host side of this seam. Cards are pre-rendered
// to deterministic markdown (see cards/render.ts) before crossing.
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=messages.js.map