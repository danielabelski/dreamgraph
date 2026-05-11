# architect-v2/webview/

**Owner slice:** Slice 5 — Cards vNext (presentation half).

**Purpose:** Rebuilt UI surface that consumes **typed events only** from `architect-v2/cards/` and `architect-v2/orchestrator/`. Per **ADR-143**, the webview never re-parses LLM envelopes — that prohibition is what kills the v1 "summaries render as JSON and autonomy stops working" failure class. Owns layout, expand/collapse, streaming progress, animation, per-instance presentation preferences. Modular CSS (no more 1 200-LOC monolith). Copilot-style polished cards with DreamGraph pills (certainty, mode, provider, graph-bound, autonomy).

**Replaces in v1:** all of [`webview/`](../../webview/) — `card-renderer.ts` (third parallel envelope parser), `entity-links.ts`, `render-markdown.ts`, `styles.ts` (1 200-LOC CSS monolith), `protocol.ts`, `index.ts`.

**Inputs:** [plans/ARCHITECT_V2_SLICE1_INVENTORY.md](../../../../../plans/ARCHITECT_V2_SLICE1_INVENTORY.md) §1.9 + §3 (Copilot-parity gaps: card visual quality, streaming smoothness) + ADR-143.

Empty placeholder — Slice 5 fills this.
