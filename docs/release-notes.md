# DreamGraph Release Notes

## v13.0.0 - Cognitive Maintenance

DreamGraph v13.0.0 makes graph health a first-class architectural responsibility. Scans now force graph-wide multi-hop semantic enrichment, enriched neighborhoods serve as confidence-aware caches, Architect diagnoses and proposes approved self-healing operations, configured PostgreSQL tables participate in ownership discovery, major changes schedule targeted stabilizing dreams, and Explorer renders nested knowledge consistently across every node type.

This release follows the governed seven-stage `release_workflow`: version alignment, documentation refresh, artifact packaging, release notes, commit/tag/push, GitHub release publication, and website update each require completion evidence before `v13.0.0` is treated as released.

See [`../RELEASE_NOTES_v13.0.0.md`](../RELEASE_NOTES_v13.0.0.md) for the full distribution notes.

## v12.6.0 - Hippodamus

DreamGraph v12.6.0 keeps the v12 major release title as Hippodamus and ships scheduler lifecycle evidence, CLI adapter provenance cleanup, Bash 3 compatible installer packaging, and release-wide version alignment across the daemon, MCP server, dashboard, CLI, Explorer, VS Code extension, packages, guide, README, documentation, and release artifacts.

This release preserves the governed seven-stage `release_workflow`: version alignment, documentation refresh, artifact packaging, release notes, commit/tag/push, GitHub release publication, and website update must each have real completion evidence before `v12.6.0` is treated as released.

See [`../RELEASE_NOTES_v12.6.0.md`](../RELEASE_NOTES_v12.6.0.md) for the full distribution notes.

## v12.4.0 - Hippodamus

DreamGraph v12.4.0 keeps the v12 major release title as Hippodamus and aligns the daemon, MCP server, dashboard, CLI, Explorer, VS Code extension, packages, guide, README, documentation, and release artifacts on the current v12 release line.

This release preserves the governed seven-stage `release_workflow`: version alignment, documentation refresh, artifact packaging, release notes, commit/tag/push, GitHub release publication, and website update must each have real completion evidence before `v12.4.0` is treated as released.

See [`../RELEASE_NOTES_v12.4.0.md`](../RELEASE_NOTES_v12.4.0.md) for the full distribution notes.

## v12.3.1 - Strict Policy Inheritance and Release Discipline

DreamGraph v12.3.1 fixes ENVOY-reproduced strict-policy drift so automatic normalization inherits the active instance policy unless a caller explicitly overrides it. Effective-policy receipts now report the runtime gates that were actually applied, including bootstrap-adjusted thresholds, and weak insufficient-evidence rejections no longer become durable tension inventory by default.

This release also documents the `dg architect` terminal-native Architect CLI: status, plans, plan lifecycle, runtime config, chat, task controls, ADR/graph/scheduler/Adaptive Future inspection, JSON automation, and dependency-free log-mode TUI projection over daemon-owned contracts. Ink is recorded as the selected future rich TUI renderer, but no unused renderer dependency is shipped in this pass.

This release also keeps closure bound to the authoritative seven-stage `release_workflow`: version alignment, documentation refresh, artifact packaging, release notes, commit/tag/push, GitHub release publication, and website update must each have real completion evidence before `v12.3.1` is treated as released.

See [`../RELEASE_NOTES_v12.3.1.md`](../RELEASE_NOTES_v12.3.1.md) for the full distribution notes.

## v12.2.0 - Trust Calibration and Reviewable Cognition

DreamGraph v12.2.0 adds trust-state labeling, evidence ledgers, tension precision categories, cognitive lifecycle transition visibility, and calibration evaluation for Architect and cognitive projections. The release keeps dream output advisory until backed by source, ADRs, workflow/test/runtime evidence, governed daemon validation, or explicit human review.

New operator-facing contracts distinguish accepted facts, validated insights, advisory candidates, latent/speculative links, rejected links, expired artifacts, and human-reviewed decisions. Rejected, retired, expired, and superseded artifacts remain inspectable as historical context instead of disappearing from the project story.

See [`../RELEASE_NOTES_v12.2.0.md`](../RELEASE_NOTES_v12.2.0.md) for the full distribution notes.

## v12.1.0 - Living DreamGraph

DreamGraph v12.1.0 adds daemon-governed Architect Pulse, read-only dream playback, tension clustering, desire-ledger projections, and living-plan state for the standalone browser architect.

See [`../RELEASE_NOTES_v12.1.0.md`](../RELEASE_NOTES_v12.1.0.md) for the full distribution notes.

## v12.0.0 - Hippodamus

DreamGraph v12.0.0 ships the Hippodamus release line and marks the standalone browser-based **architect** as beta. The release focuses on architect beta as the daemon-served project work surface with selected-plan scope, runtime provenance, model/adapter route visibility, governed DreamGraph MCP tool use, and auditable tool traces. The editor-integrated chat surface is now documented as the **VS Code architect**.

See [`../RELEASE_NOTES_v12.0.0.md`](../RELEASE_NOTES_v12.0.0.md) for the full distribution notes.


## v11.0.0 - Adaptive Future Engine

DreamGraph v11.0.0 ships the Adaptive Future Engine release line: advisory candidate-future ranking, future-fit scoring, compact objections, route/fallback provenance, and bounded audit metadata for graph-tool and cognitive-workflow consumers.

See [`../RELEASE_NOTES_v11.0.0.md`](../RELEASE_NOTES_v11.0.0.md) for the full distribution notes.

## Codex CLI native Architect adapter

The VS Code Architect now includes native `codex-cli` provider support following ADR-201's native CLI adapter constraints. The adapter keeps Codex-specific help probing, isolated `config.toml` generation, login-status validation, process execution, prompt serialization, and ProviderPort projection inside `extensions/vscode/src/architect-core/adapters/codex-cli/`.

User-visible support includes selectable `codex-cli` provider settings, keyless model routing, clickable `codex login` recovery for unauthenticated runs, live DreamGraph MCP tool progress while Codex is running, authoritative final tool-trace reconciliation without duplicate entries, and pending-review reconciliation based on workspace snapshots even when Codex executes tools in-process. Current Codex CLI builds that omit `--ask-for-approval` from `codex exec --help` remain supported; the adapter still pins `--sandbox read-only` and emits `--ask-for-approval never` only when the exec help surface advertises it. Codex JSON stdout events are projected from `item.completed` / `agent_message` final text while non-JSON process output is retained as diagnostics instead of being rendered as assistant content. If Codex reports MCP runtime failures and the audit bridge records no DreamGraph calls, the run now fails closed with `MCP_PROBE_FAILED` rather than accepting ungrounded output without a tool trace.

Verification coverage lives in the Codex adapter/provider/orchestrator tests plus the Slice 5/6 audit tests. Manual smoke expectation: a repository question should first call `dreamgraph:query_resource` or an equivalent DreamGraph MCP grounding tool through the bridge before producing the answer.
<!-- CONTINUATION TEST SLICE 12 -->
