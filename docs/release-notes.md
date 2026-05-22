# DreamGraph Release Notes

## Codex CLI native Architect adapter

The VS Code Architect now includes native `codex-cli` provider support following ADR-201's native CLI adapter constraints. The adapter keeps Codex-specific help probing, isolated `config.toml` generation, login-status validation, process execution, prompt serialization, and ProviderPort projection inside `extensions/vscode/src/architect-core/adapters/codex-cli/`.

User-visible support includes selectable `codex-cli` provider settings, keyless model routing, clickable `codex login` recovery for unauthenticated runs, live DreamGraph MCP tool progress while Codex is running, authoritative final tool-trace reconciliation without duplicate entries, and pending-review reconciliation based on workspace snapshots even when Codex executes tools in-process. Current Codex CLI builds that omit `--ask-for-approval` from `codex exec --help` remain supported; the adapter still pins `--sandbox read-only` and emits `--ask-for-approval never` only when the exec help surface advertises it. Codex JSON stdout events are projected from `item.completed` / `agent_message` final text while non-JSON process output is retained as diagnostics instead of being rendered as assistant content. If Codex reports MCP runtime failures and the audit bridge records no DreamGraph calls, the run now fails closed with `MCP_PROBE_FAILED` rather than accepting ungrounded output without a tool trace.

Verification coverage lives in the Codex adapter/provider/orchestrator tests plus the Slice 5/6 audit tests. Manual smoke expectation: a repository question should first call `dreamgraph:query_resource` or an equivalent DreamGraph MCP grounding tool through the bridge before producing the answer.
