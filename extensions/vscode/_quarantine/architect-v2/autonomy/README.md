# architect-v2/autonomy/

**Owner slice:** Slice 3 — Autonomy engine rewrite.

**Purpose:** Single canonical state machine. Modes (cautious / conscientious / eager / autonomous) preserved from v1 by name and default. Internals rebuilt: pass-budgeted, visible counters, explicit `completed | in_progress | blocked | failed_verification` states. State persisted alongside chat memory (no more lost-on-reload).

**Replaces in v1:** [`autonomy.ts`](../../autonomy.ts), [`autonomy-loop.ts`](../../autonomy-loop.ts), [`autonomy-contract.ts`](../../autonomy-contract.ts), [`autonomy-structured.ts`](../../autonomy-structured.ts).

**Inputs:** [plans/ARCHITECT_V2_SLICE1_INVENTORY.md](../../../../../plans/ARCHITECT_V2_SLICE1_INVENTORY.md) §1.3 + §2 rows 1–2 + §5 row "Autonomy state lost on reload".

Empty placeholder — Slice 3 fills this.
