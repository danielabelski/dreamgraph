# architect-v2/execution/

**Owner slice:** Slice 4 — MCP-first execution policy.

**Purpose:** Single tool registry + dispatcher. Enforces the strict 5-tier execution priority defined in **ADR-144**: MCP entity/API/graph → MCP file mutation → MCP verification + runtime senses → VS Code editor APIs (only when MCP genuinely inappropriate or absent) → generic shell. Tool selection achieves the 99.999999% reliability target — no spurious "tool unavailable" aborts. Selection rationale is machine-readable, not a debug string.

**Replaces in v1:** [`tool-groups.ts`](../../tool-groups.ts), [`local-tools.ts`](../../local-tools.ts), [`mcp-client.ts`](../../mcp-client.ts), [`intent-detector.ts`](../../intent-detector.ts), [`command-runner.ts`](../../command-runner.ts), [`tool-result-compression.ts`](../../tool-result-compression.ts).

**Kept-by-design exceptions** (local, not MCP): clipboard access, `run_command` shell execution.

**Inputs:** [plans/ARCHITECT_V2_SLICE1_INVENTORY.md](../../../../../plans/ARCHITECT_V2_SLICE1_INVENTORY.md) §1.5 + §4 (entire MCP-bypass table).

Empty placeholder — Slice 4 fills this.
