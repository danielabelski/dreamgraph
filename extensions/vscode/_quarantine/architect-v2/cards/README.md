# architect-v2/cards/

**Owner slice:** Slice 5 — Cards vNext (split persistence).

**Purpose:** The **single canonical envelope extractor** for the entire extension. Per **ADR-143**, cards are split by responsibility: DreamGraph persists task-state records (decisions, blockers, verification evidence, graph-linked context summaries, autonomy outcomes, provider+model used); the webview owns rendered UI state (layout, expand/collapse, streaming, transient presentation). Cards are **views** over persisted task records, not graph entities themselves. The webview consumes typed events emitted from here — it never re-parses LLM text. Copilot-style polished visuals + DreamGraph pills (certainty, mode, provider, graph-bound, autonomy). 100% reliable rendering across providers, streaming states, and partial responses.

**Replaces in v1:** [`autonomy-contract.ts`](../../autonomy-contract.ts) (envelope extraction half), [`autonomy-structured.ts`](../../autonomy-structured.ts) (extraction + bullet parsing), [`envelope-utils.ts`](../../envelope-utils.ts), [`task-reporter.ts`](../../task-reporter.ts), [`reporting.ts`](../../reporting.ts), and the parallel parsing inside [`webview/card-renderer.ts`](../../webview/card-renderer.ts).

**Inputs:** [plans/ARCHITECT_V2_SLICE1_INVENTORY.md](../../../../../plans/ARCHITECT_V2_SLICE1_INVENTORY.md) §1.2 + §2 row 1 + foundational decision §0.4 + ADR-143.

Empty placeholder — Slice 5 fills this.
