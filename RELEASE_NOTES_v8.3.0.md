# DreamGraph v8.3.0 — Bedrock

The "never-fail budget & debt" release. This iteration replaces the Architect's hard request limits with an adaptive, coordinator-owned token economy, ships a multi-tool toolkit for safer large-file edits and graph navigation, and includes a sweep of stability fixes across the daemon, scheduler, and Explorer.

## Headline changes

### Adaptive context budget & debt coordinator (NEVER_FAIL plan, Phases 1–5)

A new `BudgetCoordinator` becomes the single source of truth for per-turn context spend, debt carry-over, and pressure decisions. The Architect's three context tiers (envelope environment, deep-insights, tool-result) now query and report through it instead of running on hard-coded limits.

- **`extensions/vscode/src/budget-coordinator.ts`** — in-memory coordinator + persisted `BudgetSnapshot` (`debtTokens`, `expectedTokens`, `lastActualTokens`, `modelId`, per-component history). `recordComponentActual`, `recordCompression`, and `flagGraphSliceEmergencyTrim` provide an audit trail. Pressure is exposed as a coarse `low | normal | high` label and a numeric `getPressure()` in `[-1, +1]`.
- **`extensions/vscode/src/budget-coordinator-reader.ts`** — pure, vscode-free reader interface (`BudgetCoordinatorReader`) plus the `shouldFetchDeepInsight()` policy helper, so the context tier and tests can consume the contract without pulling in `vscode`.
- **`extensions/vscode/src/tool-result-compression.ts`** — new `compressToolResult(content, coordinator, toolName)` with four tiers driven entirely by coordinator pressure: `verbatim` (low), `envelope-preserved` (server-side truncation marker detected), `expected` (mild head/tail), `debt-repay` (aggressive, with floor + remaining-target awareness). Replaces the deprecated `truncateToolResult` and `dreamgraph.architect.maxToolResultChars` setting.
- **`ContextBuilder.buildEnvelope` / `buildReasoningPacket`** — adaptive trim of `environmentEntries` and deep-insights MCP fetches under `'high'` pressure. Deep-insight gating (`shouldFetchDeepInsight`) preserves anything in `requiredEvidence`. Component actuals (`context:env`, `context:graph`, `context:evidence`, `context:deep`) reported back to the coordinator.
- **ADR-097 emergency trim** — `flagGraphSliceEmergencyTrim()` now has a real production trigger: when pressure is `'high'` and `getRemainingTargetTokens()` falls below the planned graph reserve, the builder drops the reserve for the turn and records the breach in snapshot history.
- **Per-turn budget pill (debug, opt-in)** — new `dreamgraph.architect.budgetPillEnabled` setting (default `false`). When on, the chat header renders a compact pill showing pressure, actual/expected tokens, debt, and the top component contributors for the just-finalized turn.
- **`pressureSignalEnabled` reasoning-packet signal** — Architect can read `context_pressure` from the reasoning packet (default on) as an advisory; the coordinator owns all enforcement.

### Tool-description trimming on the legacy OpenAI Chat Completions path

The `_callOpenAIWithTools` path (used by `gpt-5.4` and other legacy OpenAI Chat Completions models) was passing `tool.description` and `tool.inputSchema` through verbatim, while the Anthropic and OpenAI Responses paths were already minifying them. This caused the `tools` section to balloon up to ~14k chars on tool-heavy turns. Fixed: descriptions now capped at 240 chars and `description` / `$comment` / `examples` / `default` stripped from the JSON schema, identical to the other paths.

### Soft context-builder limit + centralized large-output clipping

- **Soft 16k-token target** for the Architect request envelope. Previously hard-truncated; now the request-compaction layer aims at the soft target and only stretches when the harder ceiling demands it.
- **Centralized clipping util** (`src/utils/tool-output.ts`) extended and applied across server tool registration (`src/cognitive/register.ts`, `src/resources/register.ts`, `src/server/server.ts`, `src/tools/query-resource.ts`, `src/tools/visual-architect.ts`, `src/tools/code-senses.ts`) so every tool returns inside a consistent ceiling without per-tool ad-hoc trimming.

### New Architect-side editing + navigation tools

- **`patch_file`, `append_to_file`, `edit_markdown_section`** — unblock the Architect on edits to large files where a full rewrite would bust the request envelope. Surfaced through `extensions/vscode/src/local-tools.ts`.
- **`shortest_path`** — new graph-navigation MCP tool (`src/cognitive/graph-paths.ts`) exposing weighted shortest-path queries between nodes; registered in `src/cognitive/register.ts` and surfaced in the discipline manifest. Documented in `docs/tools-reference.md` and `guide/10-daily-workflow.md`.

### Architect output rendering + autonomy

- **JSON-as-text rendering bug fixed** — Architect output that arrived as a top-level JSON string is now rendered correctly instead of stalling the autonomy loop with raw JSON in the chat bubble. Touches `extensions/vscode/src/{autonomy-contract,envelope-utils,chat-panel,webview/card-renderer,local-tools}.ts` and ships with a regression suite in `extensions/vscode/src/test/envelope-loose.test.ts`.

### Daemon & Explorer stability

- **Scheduler locking fix** — eliminates a race where two concurrent dream cycles could double-claim the same schedule.
- **Cognitive timeline + discipline + atomic writes** — durability pass for cognitive event/log writes (atomic file replace) plus refreshed timeline + discipline UIs and a new Python analytics suite under `python/analytics/`.
- **Explorer** — refresh-snapshot button added and live-events stream now lets users suppress / show cache events.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `dreamgraph.architect.pressureSignalEnabled` | `true` | Expose `context_pressure` (low/normal/high) to the Architect as a read-only advisory signal. |
| `dreamgraph.architect.budgetPillEnabled` | `false` | Phase 5 (debug, opt-in): render a per-turn budget pill in the chat header with debt, actual/expected tokens, pressure, and the top component contributors. |
| `dreamgraph.architect.debtCarryFraction` | `1.0` | Fraction of overspend that rolls into next turn's debt (`0` = forget, `1` = full carry). |
| `dreamgraph.architect.expectedTokensPerTurn` | `16000` | Soft per-turn target the pipeline aims for. |

The deprecated `dreamgraph.architect.maxToolResultChars` setting has been removed; tool-result sizing is now coordinator-driven.

## Tests

- 36 / 36 pass in the budget + context-builder + chat-memory suite.
- Existing root vitest suite continues to pass.
- New tests:
  - `extensions/vscode/src/test/budget-coordinator.test.ts` — coordinator math, debt carry, emergency-trim flagging, model-id rescaling.
  - `extensions/vscode/src/test/context-builder-pressure.test.ts` — `shouldFetchDeepInsight` policy.
  - `extensions/vscode/src/test/tool-result-compression.test.ts` — 8 tests covering verbatim / envelope-preserved / expected / debt-repay tiers, throw-resilience, and tier monotonicity.
  - `extensions/vscode/src/test/envelope-loose.test.ts` — JSON-as-text envelope parsing regression.

## What changed (versions)

- Core package (`package.json`) → `8.3.0`
- VS Code extension (`extensions/vscode/package.json`) → `8.3.0`
- Explorer (`explorer/package.json`) → `8.3.0`
- CLI banner (`src/cli/dg.ts`) → `DreamGraph CLI v8.3.0 (Bedrock)`
- CLI ↔ daemon MCP client ID (`src/cli/utils/mcp-call.ts`) → `8.3.0`
- VS Code ↔ daemon MCP client ID (`extensions/vscode/src/mcp-client.ts`) → `8.3.0`
- Architect core prompt (`extensions/vscode/src/prompts/architect-core.ts` + `extensions/vscode/prompts/architect_core.md`) → `v8.3.0 Bedrock`
- VS Code activation `currentVersion` reset key → `8.3.0` (resets the sidebar view location once on first activation after upgrade)
- `INSTALL.md` and `guide/02-installation.md` headers and `dg --version` example → `v8.3.0`

## Upgrade notes

- Run `.\scripts\install.ps1 -Force` (or `./scripts/install.sh`) to refresh CLI, daemon, Explorer, and extension assets. Verify with `dg --version` → `DreamGraph CLI v8.3.0 (Bedrock)`.
- Restart running daemons: `dg restart <instance>`.
- Reload VS Code windows after the extension update so the new `BudgetCoordinator` and `compressToolResult` paths take effect.
- The first chat turn after upgrade migrates any persisted `BudgetSnapshot` from prior versions transparently; coordinators created without a saved snapshot start at zero debt.
- If you previously relied on `dreamgraph.architect.maxToolResultChars`, remove it from your settings — the coordinator now sizes tool results based on per-turn pressure.

## Architecture decisions

- **NEVER_FAIL_BUDGET_DEBT_PLAN** (`plans/NEVER_FAIL_BUDGET_DEBT_PLAN.md`) — Phases 1–5 marked complete in this release. ADR-097 (curated graph-evidence reserve) and ADR-129 (adaptive targets, no hard limits) remain in force; Phase 4 / 5 add the first production callers of their emergency-trim and per-turn-debt audit hooks.

## Version

- Release: `v8.3.0 — Bedrock`
