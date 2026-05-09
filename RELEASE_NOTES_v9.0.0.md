# DreamGraph v9.0.0 — Lattice

The **Plugin SDK** release. v9.0.0 is the first DreamGraph version that ships a complete, documented, end-to-end plugin developer story: stable seams, a reference plugin, outbound webhooks as a first-class core subsystem, in-process tool/resource registration, the UI/closure seams, and a full developer-facing manual published as Markdown, a multi-file HTML site, and a single-file PDF.

This is the version every external plugin author should target.

## Headline changes

### Plugin SDK milestones M0 → M6 (complete)

The `@dreamgraph/sdk` + `@dreamgraph/host` surfaces are now stable across the M0–M6 milestones agreed in the SDK plan. Plugins that pin `engine.dreamgraph: ">=9.0.0"` have an explicitly supported contract for:

- **M0 — Manifest & host loader.** `plugin.json` schema + validator, lifecycle (`activate`/`deactivate`), capability and effect gates, and the in-process trust banner.
- **M1 — `dg plugin` CLI.** `list`, `inspect`, `register`, `enable`, `disable`, `trust`, `untrust`, `reload`, `unload` against any running instance.
- **M2 — Telemetry & observability.** Plugin telemetry bridge into the daemon's `cognitive_event_log`, surfaced through `system://plugins`.
- **M3 / M3.5 — Hot reload & enriched introspection.** Live disable / re-enable / reload, plus enriched `system://plugins` reporting (activation state, subscriptions, contributed tools and resources).
- **M4 — Plugin-contributed tools & resources.** `ctx.tools.register` and `ctx.resources.register` gated by `tools:register` / `resources:register` capabilities, with naming and namespace-prefix rules enforced at registration. Tools and resources from plugins are first-class MCP citizens.
- **M5 — Outbound webhooks (core, not a plugin seam).** `dg webhook add | list | remove | enable | disable | test | dead-letter | replay`. HMAC-SHA256 signature with `secret`, JSON delivery, configurable event filter (`--events "*"` or comma-separated event names), automatic retry with persistent dead-letter, and replay for failed deliveries. The `webhooks:emit` SDK capability remains *reserved* — webhooks are emitted by the host, not by plugin code.
- **M6 — UI / closure seams.** Plugins can contribute archetypes, policies, markdown fences, and UI hooks through the new closure-seam APIs in `@dreamgraph/sdk`. Each seam ships a focused vitest suite (`tests/plugins/{archetypes,policies,markdown-fences,ui}-seam.test.ts`) so the contracts are pinned by tests.

The reference plugin lives at [`examples/hello-events/`](examples/hello-events/) and is exercised end-to-end by `tests/plugins/hello-events-e2e.test.ts`.

### Plugin Developer Guide & Reference Manual

A complete, version-controlled, three-format publication of the SDK lives under [`docs/sdk/`](docs/sdk/):

- **Source:** 13-chapter [Plugin Developer Guide](docs/sdk/plugin-developer-guide/) and 10-chapter [Plugin Reference Manual](docs/sdk/plugin-reference/) in Markdown.
- **HTML site:** multi-file site at `docs/sdk/site/html/` with cross-document links (`.md` → `.html` rewritten by a Lua filter), shared dark-mode-aware stylesheet, and per-chapter navigation.
- **PDF:** single-file `docs/sdk/site/pdf/dreamgraph-plugin-developer-manual.pdf`, rendered through pandoc + Chromium headless.
- **Build:** `scripts/build-plugin-docs.ps1` produces all three artifacts deterministically. Output is now BOM-stamped UTF-8 across both per-chapter HTML and the combined PDF input, fixing a Windows mojibake regression where Chromium headless `--print-to-pdf` ignored `<meta charset="utf-8">` over `file://` and fell back to the system codepage.

### MCP argument forwarding fix

The plugin-side `ctx.tools.register` path previously dropped tool arguments when the JSON Schema was registered without an explicit Zod shape. v9.0.0 forwards arguments correctly in all paths and adds a regression test. Plugin authors who saw "tool args arrive empty" on engines `< 9.0.0` should upgrade and pin `engine.dreamgraph: ">=9.0.0"`.

### `engine.env` templates document plugin flags

All three engine templates (`templates/{default,ollama,lmstudio}/config/engine.env`) now document the plugin flags users need to opt into the in-process plugin runtime:

- `DG_ALLOW_INPROCESS_PLUGINS=true` — required to load any plugin (off by default; trusted plugins still also need `trusted: true` in `instance.json`).
- `DG_FETCH_PLUGIN_BLACKLIST=false` — reserved forward-compatible flag for an optional, read-only HTTPS fetch of a signed denylist of known-malicious plugins from `nofs.ai`. The endpoint is not yet implemented — the flag is documented now so future engines can honor it without a new env var.

### Documentation tooling

- New build script: `scripts/build-plugin-docs.ps1` — clean `docs/sdk/site/`, render HTML site + combined PDF, BOM-stamp outputs, detect any installed PDF engine (wkhtmltopdf → xelatex → pdflatex → Chromium/Edge fallback), and exit cleanly even when Chromium prints harmless GPU warnings to stderr.
- Lua filter `docs/sdk/site/rewrite-md-links.lua` rewrites in-doc `.md` references to `.html` for the multi-file site without touching external URLs.

## What changed (versions)

- Core package (`package.json`) → `9.0.0`
- VS Code extension (`extensions/vscode/package.json`) → `9.0.0`
- Explorer (`explorer/package.json`) → `9.0.0`
- CLI banner (`src/cli/dg.ts`) → `DreamGraph CLI v9.0.0 (Lattice)`
- CLI ↔ daemon MCP client ID (`src/cli/utils/mcp-call.ts`) → `9.0.0` (both call sites)
- VS Code ↔ daemon MCP client ID (`extensions/vscode/src/mcp-client.ts`) → `9.0.0`
- Architect core prompt (`extensions/vscode/src/prompts/architect-core.ts` + `extensions/vscode/prompts/architect_core.md`) → `v9.0.0 Lattice`
- VS Code activation `currentVersion` reset key → `9.0.0` (resets the sidebar view location once on first activation after upgrade)
- `INSTALL.md` and `guide/02-installation.md` headers and `dg --version` example → `v9.0.0`
- Plugin SDK engine baseline → `>=9.0.0` across `examples/hello-events/plugin.json`, `tests/sdk/manifest-fixtures/*.json`, `tests/sdk/host-loader.test.ts`, `tests/plugins/*.test.ts`, and the SDK developer guide / reference manual.
- Lock files (`package-lock.json`, `explorer/package-lock.json`, `extensions/vscode/package-lock.json`) → `9.0.0` (root packages only; transitive dependencies untouched).

## Tests

- Full root vitest suite passes.
- M5 webhook smoke flow (`dg webhook add → test → dead-letter → replay`) verified locally against `scripts/webhook-test-receiver.mjs`.
- M6 closure-seam suites pass: `tests/plugins/{archetypes,policies,markdown-fences,ui}-seam.test.ts`.
- `tests/plugins/hello-events-e2e.test.ts` exercises the reference plugin end-to-end.
- `tests/plugins/manager.test.ts` exercises lifecycle, hot reload, trust transitions.

## Upgrade notes

- Run `.\scripts\install.ps1 -Force` (or `./scripts/install.sh`) to refresh CLI, daemon, Explorer, and extension assets. Verify with `dg --version` → `DreamGraph CLI v9.0.0 (Lattice)`.
- Restart running daemons: `dg restart <instance>`.
- Reload VS Code windows after the extension update so the new MCP client ID and `currentVersion` reset key take effect.
- **Plugin authors:** bump `engine.dreamgraph` to `">=9.0.0"` in your `plugin.json`. Earlier engines did not have the M4 argument-forwarding fix or the M6 closure seams.
- **Webhook subscribers:** existing subscriptions persist; no migration needed. New subscriptions can use `--events "*"` to receive all event types or a comma-separated list of specific events.
- The reserved `DG_FETCH_PLUGIN_BLACKLIST` flag has no runtime effect in v9.0.0. It is documented now in the templates so future engines can honor it without users needing to add a new variable.

## Known carry-overs (deferred to a later release)

- **M4 schedule actions** are not part of this release. The M4 milestone delivered tool and resource registration; declarative schedule contributions remain on the roadmap.
- **Multi-engine datastore roadmap (v8.3.0 → v8.9.0 line items)** continues independently. The version line in the README sponsor block intentionally still references the old milestone numbers; that re-versioning happens in a follow-up release.

## Architecture decisions

- The plugin SDK contract (M0–M6) is now considered stable. Future breaking changes to `@dreamgraph/sdk` or `@dreamgraph/host` will be a major version bump.
- Webhooks are intentionally a *core* subsystem rather than a plugin seam, so trust, signing, dead-letter persistence, and retry semantics are owned by the host and not negotiable per plugin.

## Version

- Release: `v9.0.0 — Lattice`
