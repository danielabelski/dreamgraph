# DreamGraph v12.0.0 - Hippodamus

**v12.0.0 Hippodamus** marks the standalone browser-based **architect** as beta and aligns the first-party DreamGraph release line to 12.0.0. From this release onward, **architect** refers to the standalone browser surface; the editor-integrated chat surface is the **VS Code architect**.

## Release focus: architect beta

Architect beta is the daemon-served browser surface for project-bound DreamGraph work. It brings the core Architect workflow out of the editor while keeping DreamGraph daemon authority intact:

- Project chat grounded in DreamGraph MCP tools, graph facts, ADRs, workflows, data models, UI registry entries, and source evidence.
- Selected-plan chat with explicit scope, so plan-bound work does not depend on hidden conversation state.
- Runtime provenance that shows adapter, provider, model, route, autonomy state, pass state, and session identity.
- Auditable tool traces for DreamGraph MCP calls, command verification, source inspection, graph reads, graph mutations, and release work.
- Browser-first access to the same governed source, graph, ADR, documentation, and release workflows used by the rest of DreamGraph.

The beta label is intentional. The browser shell is now positioned as the primary standalone Architect surface, but layout, controls, and some long-running workflow ergonomics will continue to harden across the v12 line.

## Naming change

- **architect**: standalone browser-based Architect beta.
- **VS Code architect**: Architect chat inside the VS Code extension.
- Historical references to "Standalone Architect" describe the same beta surface now called architect.

## Version alignment

This release aligns the first-party versioned surfaces to **12.0.0**:

- `dreamgraph`
- `@dreamgraph/sdk`
- `@dreamgraph/host`
- `dreamgraph-explorer`
- `dreamgraph-vscode`
- root and nested lockfiles
- runtime/client version strings used by the VS Code architect integration
- user guide, installation docs, root README, architecture docs, extension README, and release-note index

## Documentation

- Added `guide/15-architect-beta.md`, a comprehensive user guide for the standalone architect beta.
- Updated `guide/README.md` to include architect beta in the recommended reading path and daily-use surface model.
- Updated the VS Code extension guide to consistently call the editor-integrated chat the **VS Code architect**.
- Updated the root README to introduce the v12 architect beta as the release headline.
- Updated installation and troubleshooting examples for `dreamgraph-vscode-12.0.0.vsix`.

## Release artifacts

Expected local distribution artifacts for this release:

- `dreamgraph-12.0.0.tgz`
- `dreamgraph-sdk-12.0.0.tgz`
- `dreamgraph-host-12.0.0.tgz`
- `dreamgraph-vscode-12.0.0.vsix`

## Upgrade notes

After installing v12.0.0:

1. Restart running DreamGraph daemons so the v12 runtime and daemon-served architect beta are active.
2. Reload VS Code windows so the v12 VS Code architect and extension metadata are in memory.
3. Use `dg status <instance>` to confirm daemon version and HTTP endpoint.
4. Open architect from the daemon-served browser surface and verify the instance, project, scope, and runtime route shown in the UI.

## Verification

Release verification should include:

- root TypeScript/build verification
- Explorer build
- VS Code extension build/package verification
- package artifact creation for root, SDK, host, and VS Code extension
- `v12.0.0` git tag on the release commit
- GitHub release titled `DreamGraph v12.0.0 - Hippodamus`
