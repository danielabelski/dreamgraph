# DreamGraph v12.4.0 - Hippodamus

DreamGraph v12.4.0 keeps the v12 major release title as Hippodamus and aligns every release-bearing surface on the current v12 line.

## Highlights

- Bumped the daemon, MCP server, dashboard, CLI, Explorer, VS Code extension, root package, workspace packages, generated lockfiles, documentation, guide references, and README release surface to `12.4.0` / `v12.4.0`.
- Preserved the major-line title rule: the v12 release line remains Hippodamus, so this release is titled `v12.4.0 - Hippodamus`.
- Refreshed the root README and release-note index so users see the current release first.
- Kept the release pass bound to the authoritative seven-stage `release_workflow`; the release is complete only after version alignment, documentation refresh, artifact packaging, release notes, commit/tag/push, GitHub release publication, and website update each have completion evidence.

## Release-Bearing Surfaces

- Root daemon/package manifest and package lock
- MCP client/version strings used by CLI calls
- `dg` CLI visible version output
- Explorer dashboard package manifest and lockfile
- VS Code extension package manifest and lockfile
- Workspace packages: `@dreamgraph/host`, `@dreamgraph/sdk`, and `@dreamgraph/token-economy`
- Root README, release-note index, and guide-facing release documentation

## Verification

- `npm run build:server`
- `npm run build`
- Release artifact packaging for root package, workspace packages, and VS Code extension

## Operational Notes

This release should be published from the `v12.4.0` git tag with the GitHub release title `DreamGraph v12.4.0 - Hippodamus`. Website release content must use the same title and link to the published tag.
