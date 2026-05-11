# architect-v2/prompts/

**Owner slice:** Slice 6 — Copilot-plus capability matrix (prompt composition is the lever).

**Purpose:** Composable prompt fragments. Continuation prompts must declare the conceptual capabilities needed for the next pass (token-economy invariant). Golden-file tests cover every fragment from day one — no more silent prompt regressions. Task inference is no longer a hardcoded `task === 'patch'` branch; reasoning packets are available to any task that needs them.

**Replaces in v1:** [`prompts/index.ts`](../../prompts/index.ts), [`prompts/architect-core.ts`](../../prompts/architect-core.ts), [`prompts/architect-patch.ts`](../../prompts/architect-patch.ts), [`prompts/architect-explain.ts`](../../prompts/architect-explain.ts), [`prompts/architect-validate.ts`](../../prompts/architect-validate.ts), [`prompts/architect-suggest.ts`](../../prompts/architect-suggest.ts), and the prompt-emitting halves of [`autonomy-contract.ts`](../../autonomy-contract.ts) and [`reporting.ts`](../../reporting.ts).

**Inputs:** [plans/ARCHITECT_V2_SLICE1_INVENTORY.md](../../../../../plans/ARCHITECT_V2_SLICE1_INVENTORY.md) §1.8 + §3 (Copilot-parity gaps).

Empty placeholder — Slice 6 fills this.
