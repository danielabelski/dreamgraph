# architect-v2/context/

**Owner slice:** Slice 4 (engine) + later refinement.

**Purpose:** Graph-first context engine. Single budget authority (no parallel BudgetCoordinator + request-compaction constants). Adaptive reserves per model window. Single trimming layer.

**Replaces in v1:** [`context-builder.ts`](../../context-builder.ts), [`context-cache.ts`](../../context-cache.ts), [`context-fetchers/`](../../context-fetchers/), [`context-inspector.ts`](../../context-inspector.ts), [`environment-context.ts`](../../environment-context.ts), [`graph-signal.ts`](../../graph-signal.ts), [`budget-coordinator.ts`](../../budget-coordinator.ts), [`budget-coordinator-reader.ts`](../../budget-coordinator-reader.ts), [`request-compaction.ts`](../../request-compaction.ts), [`tool-result-compression.ts`](../../tool-result-compression.ts).

**Inputs:** [plans/ARCHITECT_V2_SLICE1_INVENTORY.md](../../../../../plans/ARCHITECT_V2_SLICE1_INVENTORY.md) §1.6 + §2 rows 3, 5, 7.

Empty placeholder — Slice 4 fills this.
