# DreamGraph v13.2.0 - Continuation Boundaries

DreamGraph v13.2.0 corrects Architect continuation ownership and autonomous completion semantics while preserving the v13.1 additive-scan and MCP transport work.

## Highlights

- CLI adapters are direct execution adapters. Codex CLI and Copilot CLI no longer require, parse, construct, persist, or expose Architect continuation envelopes or tokens.
- Native API/controller code retains API continuation-token and continuation-envelope behavior.
- Controller-derived needs cross the CLI boundary only as concrete required/preferred DreamGraph MCP tool names.
- Normal CLI results are normalized above the adapter layer before Architect evaluates whether the user-requested target is complete.
- Autonomous execution distinguishes requested-target completion from intermediate checkpoint completion, locally actionable remaining work, genuine blockers, required user input, and explicit resource-policy stops.
- A completed slice, verification checkpoint, or status summary no longer terminates autonomous work while the requested target remains incomplete and locally actionable.
- External maintenance timeouts are retained as evidence but do not terminate unrelated locally actionable implementation work.

## Architecture

ADR-240 records the durable boundary:

> Continuation-envelope semantics belong to the native API adapter/controller boundary and are not part of the CLI adapter contract.

It also records the autonomous completion rule:

> Intermediate slice/checkpoint completion does not terminate autonomous execution while the user-requested completion target remains locally actionable.

CLI process/session identifiers remain transport metadata; they are not Architect continuation tokens.

## Verification

Before the version bump:

- Root DreamGraph Vitest suite passed.
- Full VS Code extension suite passed: 471/471 tests.
- Focused continuation/CLI bridge suite passed: 17/17 tests.
- Focused adapter/autonomy suite passed: 77/77 tests.
- Scan/MCP release verification passed: 123/123 tests, deterministic four-route benchmark, TypeScript build, and Explorer production build.
- Codex/Copilot adapter, native continuation, route/controller, timeout/cancellation, audit, provenance, mutation non-replay, and stdout-purity coverage remained green.
- Final `git diff --check`, version-alignment audit, generated documentation, package metadata, and release artifact verification passed before publication.

## Upgrade and compatibility

No graph-state migration is required. Existing native API continuation tokens remain controller-owned and route-compatible. CLI callers continue to receive normalized execution content, provenance, tool traces, timeout/cancellation outcomes, and session metadata without an envelope requirement.

## Artifacts

The governed release workflow produces and verifies:

- `dreamgraph-13.2.0.tgz`
- `dreamgraph-host-13.2.0.tgz`
- `dreamgraph-sdk-13.2.0.tgz`
- `dreamgraph-token-economy-13.2.0.tgz`
- `dreamgraph-vscode-13.2.0.vsix`

The release is published from tag `v13.2.0` with title `DreamGraph v13.2.0 - Continuation Boundaries`.
