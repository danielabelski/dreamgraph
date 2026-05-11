"use strict";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// architect-core/adapters/host.ts — Phase 3a (ADR-089).
//
// `ChatPanelHost` is the narrow accessor surface that the v1 adapters
// require from `ChatPanel`. The adapter factories take a `ChatPanelHost`
// instead of importing `chat-panel.ts` directly so the seam can be
// instantiated, tested, and (eventually) reused outside the panel without
// dragging the full webview lifecycle in.
//
// STRICT v1: no `architect-v2/` imports.
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=host.js.map