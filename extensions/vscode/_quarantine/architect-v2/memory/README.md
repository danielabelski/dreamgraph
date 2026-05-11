# architect-v2/memory/

**Owner slice:** Slice 7 — Verification + 100% completion harness (memory subsystem owned here for reload safety).

**Purpose:** Versioned persistence for chat history, autonomy state, budget snapshot, and stop-context. Every persisted record carries an explicit `schema_version` field; readers migrate older versions on hydrate. v1 persisted only chat + budget (and the budget round-trip was famously fragile per the §9 reload-invariant note); autonomy and stop-context were lost on reload. v2 persists all four with the same versioning discipline so a reload — or even a crash mid-autonomy — can resume cleanly.

**Replaces in v1:** [`chat-memory.ts`](../../chat-memory.ts) (no schema versioning), in-memory state on `ChatPanel` (`_autonomyState`, `_lastStopContext`, `_lastBudgetSnapshot`).

**Inputs:** [plans/ARCHITECT_V2_SLICE1_INVENTORY.md](../../../../../plans/ARCHITECT_V2_SLICE1_INVENTORY.md) §1.7 + §5 risk rows on persistence schema drift + the non-failing task contract principle.

Empty placeholder — Slice 7 fills this.
