## DreamGraph v8.2.5 — Bedrock

Maintenance + cognitive-discipline release on top of v8.2.1. Adds the tension resolution lifecycle (Slice 4B), extended scanning of MCP tools / tests / config / scripts (Slice 5B), the architect lens for the VS Code extension (Slice 5A), an LLM-readiness gated bootstrap, and a fully expanded `export_living_docs` exporter.

### Cognitive engine

- **Tension resolution lifecycle (Slice 4B)** — new heuristic resolution proposer assigns each open tension a strategy (`merge | mediator | split | reframe | wont_fix`) with a validation window. Pipeline stats surfaced in `cognitive_status` (`resolution_pipeline.pending_candidates`, `by_strategy`, `awaiting_validation`).
- **Tension log schema** extended with `attempted` and `resolution_candidate.{strategy, rationale, proposed_at, validation_window, source}` fields.
- **LLM readiness state machine** — new `bootstrap-driver`, `bootstrap-registry`, and `llm-readiness` modules gate cognitive cycles behind a verified provider/model fingerprint; `cognitive_status.llm_readiness` and `bootstrap_history` exposed.
- **Bootstrap CLI command** (`src/cli/commands/bootstrap.ts`) and `bootstrap_instance` MCP tool for one-shot bootstrap orchestration.

### Scanning & extended entities (Slice 5B)

- **Auxiliary entity store** (`auxiliary_entities.json`) — `scan_project` Phase 2.5 classifies and persists four new entity kinds:
  - `mcp_tool` (registered MCP tools)
  - `test_suite` (vitest / node test files)
  - `configuration` (config files: `.env*`, `*.config.{ts,js,json}`, `tsconfig.json`, etc.)
  - `automation_script` (bin / scripts / package.json scripts)
- New modules: `src/tools/auxiliary-classifier.ts`, `src/tools/auxiliary-generators.ts`, `src/tools/auxiliary-store.ts`, `src/tools/scan-types.ts`.
- `scan_project` returns an `auxiliary` block with per-kind counts; `system://index` lists the four kinds.
- Classification priority is fixed (mcp_tool → test_suite → configuration → automation_script).

### Architect lens (Slice 5A)

- New `extensions/vscode/src/architect-lens.ts` plus regression suite `architect-lens.test.ts`.
- Architect prompt and context builder updated to surface lens-derived signals; chat-panel and inspector refresh accordingly.
- VS Code extension `types.ts` extended with lens-related shapes.

### Living docs exporter

- `export_living_docs` `sections` now accepts: `features, data_model, datastores, auxiliary, tensions, workflows, architecture, ui_registry, cognitive_status, api_reference, all` (3 new section identifiers).
- New generators emit:
  - `datastores/_index.md` + per-datastore page (kind, repos, introspected `tables[]` schema, last-scanned).
  - `auxiliary/_index.md` + one page per kind (mcp_tool / test_suite / configuration / automation_script).
  - `tensions/_index.md` with open-by-type counts, top-25 by urgency, and the Slice 4B **Pending Resolution Candidates** table (strategy, source, validation window, rationale).
- `all` expansion includes the three new sections; `cognitive_status` remains opt-in via `include_cognitive`.
- Locked behind **ADR-120** (5 guard rails covering section identifiers, pure JSON-to-Markdown generators, opt-in cognitive_status, graceful empty-load behavior, and a forward rule for any future entity store).

### API & dashboard

- `src/api/routes.ts` extended (+384 lines) with new endpoints supporting bootstrap orchestration, LLM-readiness, and lens data.
- Dashboard banner version bumped to v8.2.5.

### Documentation

- `docs/cognitive-engine.md` — new "Tension Resolution Lifecycle" subsection with strategy heuristic table.
- `docs/data-model.md` — Tension Log + Auxiliary Entities sections.
- `docs/tools-reference.md` — `dream_cycle` resolver hook, `scan_project` Phase 2.5, `system://index` four kinds, `export_living_docs` parameter table extended with `datastores / auxiliary / tensions` and v8.2 coverage notes.
- `docs/architecture.md` — source layout updated with `auxiliary-classifier.ts`, `auxiliary-generators.ts`, `auxiliary-store.ts`, `scan-types.ts`; version banner.

### Tests

- `tests/auxiliary-entities.test.ts` — Slice 5B regression coverage.
- `tests/tension-resolution.test.ts` — Slice 4B regression coverage.
- Full suite: 188 passed / 2 skipped (vitest).

### What changed (versions)

- Core package version updated to `8.2.5`
- CLI/daemon package metadata updated to `8.2.5`
- VS Code extension package metadata updated to `8.2.5`
- Explorer package metadata updated to `8.2.5`
- Root README and architecture docs updated for **v8.2.5 — Bedrock**

### Upgrade notes

- Run `.\scripts\install.ps1 -Force` to refresh CLI, daemon, Explorer, and extension assets.
- Restart running daemons: `dg restart <instance>`.
- Reload VS Code windows after the extension update.
- Existing `tension_log.json` will be migrated transparently — `attempted` defaults to `false` and `resolution_candidate` is added on the next dream cycle.
- Existing instances will populate `auxiliary_entities.json` on the next `scan_project` run.

### Architecture decisions

- **ADR-120** — `export_living_docs covers datastores, auxiliary entities, and tensions` (recorded this release).

### Version

- Release: `v8.2.5 — Bedrock`
