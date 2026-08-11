# DreamGraph v13.0.0 - Cognitive Maintenance

DreamGraph v13.0.0 turns the graph from a passive scan result into a continuously evaluated architectural model. Scanning, enrichment, Architect reasoning, datastore discovery, Explorer inspection, and targeted dreaming now share an explicit semantic-quality contract: every canonical node should explain its intent, behavior, rationale, evidence, and relationships rather than merely repeat filenames or source counts.

## Highlights

- Made graph-wide LLM enrichment mandatory after every scan and re-scan. Every canonical node type is eligible: features, workflows, data models, capabilities, UI elements, datastores, and auxiliary entities.
- Added multi-hop semantic discovery with a minimum of two hops and a default of three. Enrichment writes evidenced relations and preserves source-backed rationale instead of treating adjacency as meaning.
- Added confidence-aware semantic caching. Enriched neighbors can satisfy overlapping context when their completeness, freshness, confidence, and source/relationship coverage are sufficient; source is read only for uncovered, conflicting, or low-confidence areas.
- Added `graph_health_report`, a read-only architectural-quality assessment covering semantic density, parser-only nodes, hollow descriptions, machine-name leakage, contracts, workflows, datastores, UI metadata, connectivity, tensions, dream promotion, repository drift, and scan/enrichment age.
- Made Architect responsible for explaining graph-quality risk and proposing the smallest approved maintenance operation. The preferred order is enrich before scan and scan before bootstrap unless repository drift requires structural discovery first.
- Added bounded targeted dream stabilization after major graph changes. Schedules carry affected entities, a two-hop focus, and a reason, and equivalent active schedules are reused rather than duplicated.
- Expanded PostgreSQL sensing during project scans. A configured `DATABASE_URL` is introspected before semantic enrichment so table nodes and code-to-datastore ownership links participate in the same reasoning pass.
- Made project scans honor project-root `.gitignore` rules.
- Hardened scan, enrichment, and bootstrap transport behavior with progress notifications, inactivity-aware calls, atomic batch persistence, explicit semantic-coverage receipts, and bounded structural fallback when a deep scan cannot complete.
- Enforced complete UI knowledge: intent, description, data contract, interactions, visual semantics, layout semantics, ownership/composition, and active graph relations.
- Rebuilt the Explorer inspector's shared renderer so every node type displays nested links, enrichment, contracts, and metadata as structured cards, labels, chips, badges, and clickable entity references instead of raw JSON.
- Added `gpt-5.6`, `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` to the VS Code Architect Codex CLI model selections, with GPT-5.6-family runs defaulting to `xhigh` reasoning effort.
- Aligned the daemon, MCP server, dashboard, Architect, CLI, Explorer, VS Code extension, workspace packages, lockfiles, manuals, generated documentation, website, and distribution artifacts on `13.0.0`.

## Graph Maintenance Behavior

`scan_project` now discovers structural evidence, scans configured PostgreSQL state when available, and then runs forced graph-wide semantic enrichment. Deterministic fallback output is explicitly marked incomplete and cannot satisfy the semantic-coverage contract.

For an existing graph whose source topology is current, use the cheaper targeted path:

```bash
dg enrich <instance> --skip-scan --force
```

Use a deep scan when repository structure or datastore configuration changed:

```bash
dg scan <instance> --depth deep
```

Reserve full bootstrap for empty or unrecoverable instances:

```bash
dg bootstrap <instance> --mode full --force
```

Architect can run the same approved maintenance operations directly through DreamGraph MCP.

## Upgrade Guidance

1. Install the v13.0.0 package or run the repository installer.
2. Restart each DreamGraph daemon so the new runtime and MCP contracts are active.
3. Reload VS Code so the v13 extension and Codex CLI model list are active.
4. Hard-refresh any open Explorer tab to replace cached SPA assets.
5. Ask Architect for `graph_health_report`, then approve the smallest recommended operation. Existing graphs with current source structure normally need only forced enrichment.
6. If the project uses PostgreSQL, confirm `DATABASE_URL` is set in the instance's `config/engine.env` before scanning.

No destructive graph migration is required. v13 adds `graph_maintenance.json` to instance data and extends existing enrichment/link metadata while preserving canonical entity IDs and human-authored knowledge.

## Release Artifacts

- `dreamgraph-13.0.0.tgz` — daemon, CLI, dashboard, Architect, Explorer, documentation, and runtime package
- `dreamgraph-host-13.0.0.tgz` — plugin host package
- `dreamgraph-sdk-13.0.0.tgz` — plugin SDK package
- `dreamgraph-token-economy-13.0.0.tgz` — shared Architect token-economy contracts
- `dreamgraph-vscode-13.0.0.vsix` — VS Code architect companion

## Verification

- Full root Vitest suite
- Root TypeScript, daemon/dashboard/Architect, and Explorer production builds
- VS Code extension isolation lint, webview/extension/bridge/vendor builds, and compiled test suite
- Plugin SDK, host, and token-economy builds
- CLI version smoke test
- Package dry-runs and final tarball/VSIX creation
- Repository-wide release-identity audit for stale active version strings
- Website TypeScript and production build

## Operational Notes

The release is published from the `v13.0.0` git tag with the GitHub release title `DreamGraph v13.0.0 - Cognitive Maintenance`. The related website release surfaces and download links use the same title, version, and tag.
