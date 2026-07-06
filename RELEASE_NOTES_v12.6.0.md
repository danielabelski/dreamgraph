# DreamGraph v12.6.0 - Hippodamus

DreamGraph v12.6.0 keeps the v12 major release title as Hippodamus and ships the 12.6.0 fix line for scheduler evidence, CLI adapter provenance, installer compatibility, and release-wide version alignment.

## Highlights

- Fixed interval scheduler execution so due claimed schedules are awaited, skip reasons are recorded, and operator-visible lifecycle events are emitted for skipped and claimed schedules.
- Added Explorer event-stream support for schedule lifecycle visibility, including skipped, claimed, executed, timed out, and paused schedule events.
- Centralized CLI release metadata so `dg --version`, usage text, and MCP client identity share the same `12.6.0` version source.
- Clarified CLI-adapter Architect runtime provenance with `daemon_synthesized_cli_pass_report` metadata for Codex CLI and Copilot CLI routes where no provider envelope is expected.
- Updated the global installer path for macOS Bash 3 compatibility and included `@dreamgraph/token-economy` alongside `@dreamgraph/sdk` and `@dreamgraph/host` in vendored workspace tarball rewrites.
- Bumped the daemon, MCP server, dashboard, CLI, Explorer, VS Code extension, root package, workspace packages, generated lockfiles, documentation, guide references, and README release surface to `12.6.0` / `v12.6.0`.

## Release-Bearing Surfaces

- Root daemon/package manifest and package lock
- MCP client/version strings used by CLI calls
- `dg` CLI visible version output and usage banner
- Explorer dashboard package manifest, lockfile, and schedule event presentation
- VS Code extension package manifest and lockfile
- Workspace packages: `@dreamgraph/host`, `@dreamgraph/sdk`, and `@dreamgraph/token-economy`
- Global installer workspace package vendoring logic
- Root README, release-note index, and guide-facing release documentation

## Verification

- `npm run build:server`
- `npx vitest run tests/standalone-architect-routes.test.ts tests/architect-cli.test.ts`
- `npx vitest run tests/cognitive-producers.test.ts tests/explorer-events.test.ts`
- Static release metadata check for remaining committed `"version": "12.4.0"` values
- Static installer compatibility check for removed Bash associative arrays
- Release artifact packaging for root package, workspace packages, token-economy package, and VS Code extension

## Operational Notes

This release should be published from the `v12.6.0` git tag with the GitHub release title `DreamGraph v12.6.0 - Hippodamus`. Website release content must use the same title and link to the published tag.

Direct `bash -n scripts/install.sh` verification on this Windows checkout is still limited by CRLF parsing in Bash; the installer change was verified through static source checks and artifact packaging in this release pass.
