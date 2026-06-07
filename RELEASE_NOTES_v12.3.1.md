# DreamGraph v12.3.1 - Strict Policy Inheritance and Release Discipline

DreamGraph v12.3.1 fixes the ENVOY-reproduced normalization drift where an instance configured as strict could still normalize in non-strict mode, report a mixed receipt, and convert weak rejected dreams into durable tension inventory.

## Highlights

- Normalization now inherits the active instance policy by default unless a caller explicitly overrides strictness.
- Effective-policy receipts now report the strictness and runtime thresholds that were actually applied, including bootstrap-adjusted promotion gates.
- Weak insufficient-evidence rejected dreams no longer auto-create persistent `weak_connection` tensions by default.
- Automatic dream-cycle and scheduler-triggered normalization now share the same governed strictness resolution and rejected-dream tension gating.
- The release pass remains bound to the authoritative seven-stage `release_workflow`; `v12.3.1` is not considered released until version alignment, documentation refresh, artifact packaging, release notes, commit/tag/push, GitHub release publication, and website update each have real completion evidence.
- `dg architect` now has a documented terminal-native Architect CLI surface for daemon-owned status, plans, runtime config, chat, task controls, ADR/graph/scheduler/Adaptive Future inspection, JSON automation, and dependency-free log-mode TUI projection.
- The rich interactive TUI dependency decision is recorded separately: Ink is the selected future renderer for a keyboard pane UI, while the current release avoids unused renderer dependencies until that implementation slice lands.

## Runtime and Verification Impact

- Active-profile strictness is now the default normalization mode across tool, scheduler, and dream-cycle paths.
- Receipts distinguish requested override state from the effective gates actually enforced at runtime.
- Rejected-dream handling now separates low-signal insufficient evidence from truly interesting contradiction or recurrence signals.
- Architect CLI remains a thin daemon/MCP client; terminal output is local presentation, not repository fact or mutation authority.

## Verification

- `npx vitest run tests/cognitive-producers.test.ts`
- `npx vitest run tests/architect-cli.test.ts`
- `npm run build`
- `npm run build:server`

## Operational Notes

Stages 1 through 4 of the governed release workflow are repository-local and can be evidenced from this repo. Stages 5 through 7 require authoritative completion evidence from source control publication, GitHub release creation, and the related `../dreamgraph-website/` repository before `v12.3.1` can be truthfully marked released.
