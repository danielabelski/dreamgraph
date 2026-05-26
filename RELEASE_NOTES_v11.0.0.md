# DreamGraph v11.0.0 — Adaptive Future Engine

Release date: 2026-05-26

v11.0.0 ships the Adaptive Future Engine release line. This release promotes candidate-future ranking, bounded future-fit scoring, and compact audit trails from the v11 plan into the released DreamGraph distribution.

## Headline Changes

### 1. Adaptive Future Engine

- Adds the shared Adaptive Future scaffold in `src/cognitive/adaptive-future-scaffold.ts`.
- Classifies planning-doc, adapter, graph-tool, and cognitive-workflow task classes.
- Records selected and rejected candidate IDs, score factors, evidence anchors, objections, route/fallback provenance, and validation failures as compact audit metadata.
- Keeps all Adaptive Future output advisory and subordinate to accepted ADRs, workflows, API surface, data-model contracts, graph evidence, and explicit user intent.

### 2. Runtime Consumers

- `enrich_parser_nodes` now emits Adaptive Future audit metadata for graph-tool enrichment work.
- `solidify_cognitive_insight` now carries Adaptive Future audit metadata through cognitive-workflow planning metadata.
- Focused tests cover the scaffold, graph-tool audit consumer, and cognitive-workflow audit consumer.

### 3. Documentation And Release Alignment

- Adds dedicated Adaptive Future Engine documentation in `docs/adaptive-future-engine.md`.
- Adds a user-guide page in `guide/14-adaptive-future-engine.md`.
- Updates package versions, SDK docs, install guide references, VS Code extension metadata, root docs, and release notes to the v11.0.0 release line.

## Upgrade Notes

- No instance migration is required for v11.0.0.
- Existing deterministic behavior remains available; Adaptive Future metadata is advisory context, not a hard enforcement mechanism.
- Consumers that do not inspect `adaptive_future_audit` continue to behave as before.

## Artifacts

Expected release artifacts:

- `dreamgraph-11.0.0.tgz`
- `dreamgraph-sdk-11.0.0.tgz`
- `dreamgraph-host-11.0.0.tgz`
- `dreamgraph-vscode-11.0.0.vsix`

## Verification

Release verification for this cut should include:

- focused Adaptive Future tests;
- full `npm test` where practical;
- `npm run build`;
- package artifact creation with `npm pack` for root, SDK, and host packages;
- VS Code extension packaging with `npm --prefix extensions/vscode run package`.
