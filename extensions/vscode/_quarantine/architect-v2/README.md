# Architect v2 — Skeleton

This folder is the **parallel rebuild** of the DreamGraph VS Code Architect, targeting v10.0.0.

**Status:** Slice 1 — empty skeleton. No runtime behavior yet.

**Inventory:** [plans/ARCHITECT_V2_SLICE1_INVENTORY.md](../../../../plans/ARCHITECT_V2_SLICE1_INVENTORY.md)

**Governing ADRs:**

| ADR | Subject |
|-----|---------|
| ADR-140 | Parallel-folder layout; main shippable until v10.0.0 cutover |
| ADR-141 | v10.0.0 cutover; intermediate slices ship as v9.x behind feature flag |
| ADR-142 | Dual-format docs: every slice ships a Markdown plan AND ADR mirror(s) |
| ADR-143 | Cards split: graph persists task state, webview owns UI state |
| ADR-144 | 5-tier execution priority: MCP graph → MCP mutation → MCP verification → VS Code → shell |
| ADR-145 | Local provider flagships locked: LM Studio = `gpt-oss-120b` high-context, Ollama = `qwen2.5-coder:32b` |
| ADR-146 | Slice 1 demolition baseline (umbrella) |

## Folder layout

```
architect-v2/
  index.ts              Public surface (exposed to extension.ts when feature flag on)
  types.ts              Shared types (envelope, task record, profile, …)
  README.md             This file

  orchestrator/         Turn lifecycle, autonomy loop driver         [Slice 3]
  providers/            One folder per provider; ProviderProfile     [Slice 2]
  autonomy/             State machine, pass budget, continuation     [Slice 3]
  context/              Graph-first context engine + token budget    [Slice 4-ish]
  execution/            MCP-first tool registry, dispatcher, comp.   [Slice 4]
  cards/                Canonical envelope, task records, events     [Slice 5]
  prompts/              Composable prompt fragments + golden tests   [Slice 6]
  memory/               Versioned chat + autonomy + budget persist   [Slice 7]
  webview/              Rebuilt UI; consumes typed events only       [Slice 5+]
```

## Hard rules (do not violate without an ADR amendment)

1. **No imports from v1.** This folder is isolated until cutover (ADR-140).
2. **No long-lived branch.** All v2 work lands on `main` inside this folder (ADR-140).
3. **Feature flag default OFF** in every v9.x release (ADR-141).
4. **Every slice ships both** a Markdown plan under `plans/` AND ADR mirror(s) (ADR-142).
5. **Webview never re-parses LLM envelopes** — it consumes typed events only (ADR-143).
6. **Tool execution honors the 5-tier priority** in ADR-144. Any deviation requires explicit per-call justification logged in the execution trace.
7. **Provider defaults match ADR-145.** Settings may override; defaults may not.

## Cutover deletion manifest

The v10.0.0 cutover commit deletes the v1 Architect surface. Manifest is in `plans/ARCHITECT_V2_SLICE1_INVENTORY.md` §6.
