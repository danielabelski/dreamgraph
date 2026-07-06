# DreamGraph Architecture

Version: **12.1.0**
License: **DreamGraph Source-Available Community License v2.0**

## Overview

DreamGraph is an instance-scoped, graph-first cognitive daemon for development environments. Its primary architectural rule is that the knowledge graph is authoritative: features, workflows, data models, ADRs, UI elements, and tensions represent the system at a higher semantic level than any individual source file.

Core architectural surfaces:

- **Daemon runtime** — serves MCP tools, dashboard routes, orchestration, and cognitive workflows
- **Instance subsystem** — isolates projects and runtime state by UUID-scoped instance boundaries
- **Knowledge graph** — captures system structure, behavior, decisions, and unresolved tensions
- **Adaptive Future Engine** — ranks compliant candidate futures with evidence-bounded scoring and compact audit trails
- **CLI (`dg`)** — lifecycle management, status, scanning, and operational commands
- **VS Code extension** — dashboard embedding, chat UX, daemon/MCP client integration, changed-files UX


## Adaptive Future Engine

The Adaptive Future Engine is the v11 advisory preference layer. It compares compliant candidate futures after higher-authority constraints have already been applied: accepted ADRs, workflow/lifecycle rules, API and data-model contracts, graph evidence, and current user intent.

Architecturally it provides:

- deterministic task-class inference for planning-doc, adapter, graph-tool, and cognitive-workflow changes;
- future-fit score factors for evidence coverage, governance compatibility, workflow alignment, blast radius, reversibility, and fallback confidence;
- compact objections for rejected candidates;
- audit metadata that records selected/rejected candidate IDs, score factors, anchors, route/fallback provenance, and validation failures without storing raw prompts or full model responses.

The engine is not an enforcement subsystem and does not add a cognitive lifecycle state. Its output remains advisory and must degrade to deterministic fallback behavior when evidence is insufficient.

## Instance Model

Each DreamGraph instance has its own root directory under the master directory (typically `~/.dreamgraph/<uuid>/`). The instance stores:

- `instance.json` — identity and lifecycle metadata
- `config/` — instance config such as policies and MCP repository bindings
- `data/` — graph and cognitive JSON state
- `runtime/` — locks, temp files, and transient runtime state
- `logs/` — daemon and subsystem logs
- `exports/` — generated outputs and snapshots

The instance scope enforces project and repository boundaries. Repository bindings are security-relevant because they expand the set of filesystem paths considered in-bounds.

## Runtime Surfaces

### Daemon
The daemon hosts:
- MCP tools
- dashboard HTTP routes
- orchestration routes
- cognitive scheduling and dream-cycle execution
- project/graph scanning and enrichment

### CLI
The `dg` CLI is responsible for:
- creating and starting instances
- showing status and daemon metadata
- scanning and operational commands
- user-facing control flow for local installations

### VS Code Extension
The extension integrates DreamGraph into the editor and currently lives under `extensions/vscode/src/`. It surfaces the chat panel, dashboard, the Explorer (interactive graph with curated tension/candidate mutations — selectable 2D Sigma.js view or 3D Three.js view), and changed-files view. The Explorer SPA itself lives under `explorer/src/` and is bundled to `dist/explorer-spa/`, served by the daemon at `/explorer/`.

### Copilot CLI Inheritance Proxy

When the Architect provider is set to `copilot-cli`, the extension spawns the GitHub Copilot CLI as a sub-process and must hand it an MCP server named `dreamgraph` so the CLI can reach the same knowledge graph and guarded host support surface the Architect is reading. Naively spawning a fresh `dreamgraph --transport stdio` child here would be wrong: it bypasses the extension's instance/session scoping, doubles store contention, and hides daemon-reachability failures from the user.

Instead, the extension ships a bundled **inheritance proxy** at `dist/copilot-cli-bridge.js`. The proxy:

1. Acts as a **stdio MCP server** toward Copilot CLI (this is what `mcp-config.json` points at).
2. Opens a **Streamable HTTP MCP client** to the architect's already-running daemon at `<baseUrl>/mcp` (URL is injected via `DREAMGRAPH_HOST_MCP_URL`).
3. Forwards upstream DreamGraph `resources/*` and `prompts/*` requests verbatim, and forwards upstream `tools/list` / `tools/call` while adding bridge-local `run_command` as a guarded DreamGraph MCP tool constrained to `DREAMGRAPH_WORKSPACE_ROOT`.
4. Lets the orchestrator fail closed on the minimum graph/source grounding tools while exposing every live audited catalogue tool, including DreamGraph-native markdown, graph mutation, source-edit, ADR, cognitive, and verification tools. Copilot-native command/edit surfaces such as `cli:powershell`, `cli:write`, and `cli:edit` are advertised only as secondary provider-local fallbacks unless a task specifically requires provider-native execution.
5. Appends one NDJSON record per `tools/call` to `DREAMGRAPH_AUDIT_PATH` or `<DREAMGRAPH_BRIDGE_AUDIT_DIR>/<DREAMGRAPH_RUN_ID>.ndjson` (server, tool, input, result, isError, duration, startedAt) for the Context Inspector trace.
6. **Fails closed before MCP initialize completes** if the upstream cannot be reached or its `tools/list` health probe times out (exit 3, clear stderr) — the orchestrator's `mcp_servers_loaded` failure path then aborts the run instead of letting the model execute against a missing graph.

Path: `extensions/vscode/src/architect-core/adapters/copilot-cli/host/bridge-entry.ts`. Tests: `extensions/vscode/src/test/copilot-cli-bridge-audit.test.ts`.

### Codex CLI Native Adapter

The `codex-cli` Architect provider is implemented as a native adapter that follows the accepted Copilot CLI adapter architecture while keeping Codex-specific invocation, sandbox, approval, help-surface, TOML config, runner, prompt serialization, provider-port projection, event parsing, and host-process handling in its own adapter directory. Authoritative Codex runs are pinned to `codex exec --json --sandbox read-only` and receive prompts through stdin using the positional `-` argument; when the installed `codex exec` help surface advertises `--ask-for-approval`, the adapter also emits `--ask-for-approval never`. DreamGraph MCP remains the only authoritative route for repository grounding, mutation, and verification. The runner validates `codex login status` before non-interactive execution and preserves clickable `codex login` recovery metadata for unauthenticated failures. If the exec transcript reports MCP runtime failures but the bridge audit contains no DreamGraph MCP calls, the runner fails closed with `MCP_PROBE_FAILED` instead of accepting ungrounded provider-inline output without a trace. The provider is selectable through Architect settings/model routing, covers user turns and autonomy continuations, streams live DreamGraph MCP tool progress from the shared audit NDJSON bridge, projects Codex `item.completed` / `agent_message` events into final assistant text while routing non-JSON process output to diagnostics, reconciles final authoritative tool traces without duplicates, and keeps changed-file review reconciliation independent from provider-port tool projection while preserving Copilot CLI behavior.

Path: `extensions/vscode/src/architect-core/adapters/codex-cli/`. Chat integration: `extensions/vscode/src/chat-panel.ts`, `extensions/vscode/src/architect-llm.ts`, `extensions/vscode/package.json`. Tests: `extensions/vscode/src/test/codex-cli-adapter.test.ts`, `extensions/vscode/src/test/codex-cli-orchestrator.test.ts`, `extensions/vscode/src/test/codex-cli-provider-port.test.ts`, `extensions/vscode/src/test/slice5-audit.test.ts`.

Release note: `codex-cli` native Architect adapter support is covered by ADR-201 native-adapter constraints. No new ADR is required because the implementation reuses the accepted native CLI adapter pattern and only adds Codex-specific execution/configuration mechanics behind the adapter boundary.

## Source Layout

This section is generated from the repository source tree. It should list all current files under the primary source roots.

```text
src/
  src/api/routes.ts
  src/architect/cli-bridge.ts
  src/architect/cli-mcp-bridge.ts
  src/architect/desire-ledger.ts
  src/architect/native-tool-loop.ts
  src/architect/onboarding-readiness.ts
  src/architect/onboarding-telemetry.ts
  src/architect/plan-registry.ts
  src/architect/pulse.ts
  src/architect/repo-setup.ts
  src/architect/routes.ts
  src/architect/token-economy/standalone-store.ts
  src/cli/commands/architect.ts
  src/cli/commands/attach.ts
  src/cli/commands/bootstrap.ts
  src/cli/commands/curate.ts
  src/cli/commands/enrich.ts
  src/cli/commands/export.ts
  src/cli/commands/fork.ts
  src/cli/commands/init.ts
  src/cli/commands/instances.ts
  src/cli/commands/lifecycle-ops.ts
  src/cli/commands/migrate.ts
  src/cli/commands/plugin.ts
  src/cli/commands/restart.ts
  src/cli/commands/scan.ts
  src/cli/commands/schedule.ts
  src/cli/commands/start.ts
  src/cli/commands/status.ts
  src/cli/commands/stop.ts
  src/cli/commands/webhook.ts
  src/cli/dg.ts
  src/cli/utils/architect-client.ts
  src/cli/utils/daemon.ts
  src/cli/utils/mcp-call.ts
  src/cli/version.ts
  src/cognitive/adaptive-future-scaffold.ts
  src/cognitive/adversarial.ts
  src/cognitive/bootstrap-driver.ts
  src/cognitive/bootstrap-registry.ts
  src/cognitive/calibration-evaluation.ts
  src/cognitive/causal.ts
  src/cognitive/dreamer.ts
  src/cognitive/engine.ts
  src/cognitive/event-router.ts
  src/cognitive/evidence-ledger.ts
  src/cognitive/federation.ts
  src/cognitive/graph-paths.ts
  src/cognitive/graph-rag.ts
  src/cognitive/intervention.ts
  src/cognitive/lifecycle-visibility.ts
  src/cognitive/llm-readiness.ts
  src/cognitive/llm.ts
  src/cognitive/lucid.ts
  src/cognitive/metacognition.ts
  src/cognitive/narrator.ts
  src/cognitive/normalizer.ts
  src/cognitive/playback.ts
  src/cognitive/register.ts
  src/cognitive/scheduler.ts
  src/cognitive/strategies/_shared.ts
  src/cognitive/strategies/cross-domain-bridging.ts
  src/cognitive/strategies/gap-detection.ts
  src/cognitive/strategies/llm-dream.ts
  src/cognitive/strategies/missing-abstraction.ts
  src/cognitive/strategies/orphan-bridging.ts
  src/cognitive/strategies/pgo-wave.ts
  src/cognitive/strategies/schema-grounding.ts
  src/cognitive/strategies/symmetry-completion.ts
  src/cognitive/strategies/tension-directed.ts
  src/cognitive/strategies/weak-reinforcement.ts
  src/cognitive/temporal.ts
  src/cognitive/tension-clustering.ts
  src/cognitive/trust-state.ts
  src/cognitive/types.ts
  src/config/config.ts
  src/discipline/artifacts.ts
  src/discipline/manifest.ts
  src/discipline/prompts.ts
  src/discipline/protection.ts
  src/discipline/register.ts
  src/discipline/session.ts
  src/discipline/state-machine.ts
  src/discipline/tool-proxy.ts
  src/discipline/tools.ts
  src/discipline/types.ts
  src/explorer/audit.ts
  src/explorer/auth.ts
  src/explorer/events.ts
  src/explorer/heatmap.ts
  src/explorer/mutations.ts
  src/explorer/prefs.ts
  src/explorer/queries.ts
  src/explorer/reason-suggest.ts
  src/explorer/routes.ts
  src/explorer/static.ts
  src/graph/events.ts
  src/graph/metrics.ts
  src/graph/snapshot.ts
  src/graph/store.ts
  src/graph/watcher.ts
  src/index.ts
  src/instance/bootstrap.ts
  src/instance/cli.ts
  src/instance/datastore-bootstrap.ts
  src/instance/index.ts
  src/instance/lifecycle.ts
  src/instance/policies.ts
  src/instance/registry.ts
  src/instance/scope.ts
  src/instance/types.ts
  src/observability/runtime-metrics.ts
  src/plugins/architect-contributions.ts
  src/plugins/architect-plan-state.ts
  src/plugins/closure-stores.ts
  src/plugins/contributions.ts
  src/plugins/manager.ts
  src/resources/register.ts
  src/scanner/extractors/c.ts
  src/scanner/extractors/cpp.ts
  src/scanner/extractors/csharp.ts
  src/scanner/extractors/go.ts
  src/scanner/extractors/gradle.ts
  src/scanner/extractors/java.ts
  src/scanner/extractors/kotlin.ts
  src/scanner/extractors/python.ts
  src/scanner/extractors/rust.ts
  src/scanner/extractors/swift.ts
  src/scanner/ontology.ts
  src/scanner/orchestrator.ts
  src/scanner/parser-bootstrap.ts
  src/scanner/types.ts
  src/semantic-invariants.ts
  src/server/dashboard.ts
  src/server/server.ts
  src/tools/adr-historian.ts
  src/tools/api-surface.ts
  src/tools/auxiliary-classifier.ts
  src/tools/auxiliary-generators.ts
  src/tools/auxiliary-store.ts
  src/tools/bootstrap-instance.ts
  src/tools/code-senses.ts
  src/tools/db-senses.ts
  src/tools/enrich-parser-nodes.ts
  src/tools/enrich-seed-data.ts
  src/tools/get-workflow.ts
  src/tools/git-senses.ts
  src/tools/graph-edge-mutations.ts
  src/tools/graph-integrity.ts
  src/tools/init-graph.ts
  src/tools/living-docs-exporter.ts
  src/tools/native-data-model.ts
  src/tools/native-ui-scanner.ts
  src/tools/plugin-ops.ts
  src/tools/query-resource.ts
  src/tools/register.ts
  src/tools/runtime-senses.ts
  src/tools/sanitize-entity.ts
  src/tools/scan-project.ts
  src/tools/scan-types.ts
  src/tools/scanner-artifact-policy.ts
  src/tools/search-data-model.ts
  src/tools/solidify-insight.ts
  src/tools/structural-generators.ts
  src/tools/ui-registry.ts
  src/tools/visual-architect.ts
  src/tools/web-senses.ts
  src/tools/webhooks.ts
  src/tools/wire-links.ts
  src/types/index.ts
  src/utils/atomic-write.ts
  src/utils/cache.ts
  src/utils/engine-env.ts
  src/utils/errors.ts
  src/utils/json-store.ts
  src/utils/logger.ts
  src/utils/metrics.ts
  src/utils/mutex.ts
  src/utils/paths.ts
  src/utils/read-json.ts
  src/utils/senses.ts
  src/utils/tool-output.ts
  src/utils/ui-index.ts
  src/webhooks/sign.ts
  src/webhooks/store.ts
  src/webhooks/worker.ts
extensions/vscode/src/
  extensions/vscode/src/architect-core/adapters/clock.ts
  extensions/vscode/src/architect-core/adapters/codex-cli/allowlist.ts
  extensions/vscode/src/architect-core/adapters/codex-cli/argv.ts
  extensions/vscode/src/architect-core/adapters/codex-cli/event-stream.ts
  extensions/vscode/src/architect-core/adapters/codex-cli/help-probe.ts
  extensions/vscode/src/architect-core/adapters/codex-cli/host/clock-adapter.ts
  extensions/vscode/src/architect-core/adapters/codex-cli/host/crypto-adapter.ts
  extensions/vscode/src/architect-core/adapters/codex-cli/host/fs-adapter.ts
  extensions/vscode/src/architect-core/adapters/codex-cli/host/index.ts
  extensions/vscode/src/architect-core/adapters/codex-cli/host/process-adapter.ts
  extensions/vscode/src/architect-core/adapters/codex-cli/index.ts
  extensions/vscode/src/architect-core/adapters/codex-cli/mcp-config.ts
  extensions/vscode/src/architect-core/adapters/codex-cli/orchestrator-ports.ts
  extensions/vscode/src/architect-core/adapters/codex-cli/orchestrator.ts
  extensions/vscode/src/architect-core/adapters/codex-cli/prompt-serializer.ts
  extensions/vscode/src/architect-core/adapters/codex-cli/provider-port.ts
  extensions/vscode/src/architect-core/adapters/codex-cli/transcript-classifier.ts
  extensions/vscode/src/architect-core/adapters/codex-cli/transcript.ts
  extensions/vscode/src/architect-core/adapters/codex-cli/types.ts
  extensions/vscode/src/architect-core/adapters/copilot-cli/allowlist.ts
  extensions/vscode/src/architect-core/adapters/copilot-cli/argv.ts
  extensions/vscode/src/architect-core/adapters/copilot-cli/event-stream.ts
  extensions/vscode/src/architect-core/adapters/copilot-cli/help-probe.ts
  extensions/vscode/src/architect-core/adapters/copilot-cli/host/audit-adapter.ts
  extensions/vscode/src/architect-core/adapters/copilot-cli/host/audit-live-adapter.ts
  extensions/vscode/src/architect-core/adapters/copilot-cli/host/bridge-entry.ts
  extensions/vscode/src/architect-core/adapters/copilot-cli/host/clock-adapter.ts
  extensions/vscode/src/architect-core/adapters/copilot-cli/host/crypto-adapter.ts
  extensions/vscode/src/architect-core/adapters/copilot-cli/host/fs-adapter.ts
  extensions/vscode/src/architect-core/adapters/copilot-cli/host/index.ts
  extensions/vscode/src/architect-core/adapters/copilot-cli/host/process-adapter.ts
  extensions/vscode/src/architect-core/adapters/copilot-cli/host/registry-adapter.ts
  extensions/vscode/src/architect-core/adapters/copilot-cli/index.ts
  extensions/vscode/src/architect-core/adapters/copilot-cli/mcp-config.ts
  extensions/vscode/src/architect-core/adapters/copilot-cli/orchestrator-ports.ts
  extensions/vscode/src/architect-core/adapters/copilot-cli/orchestrator.ts
  extensions/vscode/src/architect-core/adapters/copilot-cli/prompt-serializer.ts
  extensions/vscode/src/architect-core/adapters/copilot-cli/provider-port.ts
  extensions/vscode/src/architect-core/adapters/copilot-cli/transcript-classifier.ts
  extensions/vscode/src/architect-core/adapters/copilot-cli/transcript.ts
  extensions/vscode/src/architect-core/adapters/copilot-cli/types.ts
  extensions/vscode/src/architect-core/adapters/host.ts
  extensions/vscode/src/architect-core/adapters/v1.ts
  extensions/vscode/src/architect-core/index.ts
  extensions/vscode/src/architect-core/pass.ts
  extensions/vscode/src/architect-core/ports.ts
  extensions/vscode/src/architect-core/runner.ts
  extensions/vscode/src/architect-core/types.ts
  extensions/vscode/src/architect-lens.ts
  extensions/vscode/src/architect-llm.ts
  extensions/vscode/src/architect-pass-projection.ts
  extensions/vscode/src/architect-pass-schema.ts
  extensions/vscode/src/autonomy-contract.ts
  extensions/vscode/src/autonomy-loop.ts
  extensions/vscode/src/autonomy-structured.ts
  extensions/vscode/src/autonomy.ts
  extensions/vscode/src/budget-coordinator-reader.ts
  extensions/vscode/src/budget-coordinator.ts
  extensions/vscode/src/change-review-service.ts
  extensions/vscode/src/changed-files-view.ts
  extensions/vscode/src/chat-memory.ts
  extensions/vscode/src/chat-panel/helpers.ts
  extensions/vscode/src/chat-panel/timeout.ts
  extensions/vscode/src/chat-panel.ts
  extensions/vscode/src/chat-panel.ts.good
  extensions/vscode/src/command-runner.ts
  extensions/vscode/src/commands.ts
  extensions/vscode/src/context-builder.instrumentation.ts
  extensions/vscode/src/context-builder.ts
  extensions/vscode/src/context-cache.ts
  extensions/vscode/src/context-fetchers/deep-insights.ts
  extensions/vscode/src/context-inspector.ts
  extensions/vscode/src/daemon-client.ts
  extensions/vscode/src/dashboard-view.ts
  extensions/vscode/src/envelope-utils.ts
  extensions/vscode/src/environment-context.ts
  extensions/vscode/src/extension.ts
  extensions/vscode/src/graph-signal.ts
  extensions/vscode/src/health-monitor.ts
  extensions/vscode/src/instance-resolver.ts
  extensions/vscode/src/intent-detector.ts
  extensions/vscode/src/local-tools.ts
  extensions/vscode/src/mcp-client.ts
  extensions/vscode/src/openai-responses-adapter.ts
  extensions/vscode/src/prompts/architect-core.ts
  extensions/vscode/src/prompts/architect-explain.ts
  extensions/vscode/src/prompts/architect-patch.ts
  extensions/vscode/src/prompts/architect-suggest.ts
  extensions/vscode/src/prompts/architect-validate.ts
  extensions/vscode/src/prompts/index.ts
  extensions/vscode/src/reporting.ts
  extensions/vscode/src/request-compaction.ts
  extensions/vscode/src/reviewable-file-filter.ts
  extensions/vscode/src/status-bar.ts
  extensions/vscode/src/task-reporter.ts
  extensions/vscode/src/test/action-card-renderer.test.ts
  extensions/vscode/src/test/adaptive-future-inspector.test.ts
  extensions/vscode/src/test/architect-core-pass.test.ts
  extensions/vscode/src/test/architect-lens.test.ts
  extensions/vscode/src/test/architect-v2-isolation.test.ts
  extensions/vscode/src/test/autonomy-actions.test.ts
  extensions/vscode/src/test/autonomy-budget-exhaustion.test.ts
  extensions/vscode/src/test/autonomy-contract.test.ts
  extensions/vscode/src/test/autonomy-loop.test.ts
  extensions/vscode/src/test/autonomy-mode-switches.test.ts
  extensions/vscode/src/test/autonomy-prompt.test.ts
  extensions/vscode/src/test/autonomy-reporting.test.ts
  extensions/vscode/src/test/autonomy-structured.test.ts
  extensions/vscode/src/test/autonomy-token-economy.test.ts
  extensions/vscode/src/test/autonomy.test.ts
  extensions/vscode/src/test/budget-coordinator.test.ts
  extensions/vscode/src/test/card-renderer.test.ts
  extensions/vscode/src/test/chat-memory.test.ts
  extensions/vscode/src/test/chat-panel-copilot-cli-diff.test.ts
  extensions/vscode/src/test/chat-panel-helpers.test.ts
  extensions/vscode/src/test/codex-cli-adapter.test.ts
  extensions/vscode/src/test/codex-cli-orchestrator.test.ts
  extensions/vscode/src/test/codex-cli-provider-port.test.ts
  extensions/vscode/src/test/context-architecture-contract.test.ts
  extensions/vscode/src/test/context-builder-environment.test.ts
  extensions/vscode/src/test/context-builder-integration.test.ts
  extensions/vscode/src/test/context-builder-pressure.test.ts
  extensions/vscode/src/test/context-cache-invalidation.test.ts
  extensions/vscode/src/test/context-cache-timeout-truncation.test.ts
  extensions/vscode/src/test/context-output-logging.test.ts
  extensions/vscode/src/test/copilot-cli-adapter.test.ts
  extensions/vscode/src/test/copilot-cli-audit-live.test.ts
  extensions/vscode/src/test/copilot-cli-bridge-audit.test.ts
  extensions/vscode/src/test/copilot-cli-event-stream.test.ts
  extensions/vscode/src/test/copilot-cli-host-adapters.test.ts
  extensions/vscode/src/test/copilot-cli-orchestrator.test.ts
  extensions/vscode/src/test/copilot-cli-prompt-serializer.test.ts
  extensions/vscode/src/test/copilot-cli-provider-port.test.ts
  extensions/vscode/src/test/entity-links.test.ts
  extensions/vscode/src/test/envelope-loose.test.ts
  extensions/vscode/src/test/environment-context.test.ts
  extensions/vscode/src/test/openai-responses-adapter.test.ts
  extensions/vscode/src/test/render-markdown.test.ts
  extensions/vscode/src/test/slice4-redaction.test.ts
  extensions/vscode/src/test/slice4-ui.test.ts
  extensions/vscode/src/test/slice4-verify.test.ts
  extensions/vscode/src/test/slice5-actions.test.ts
  extensions/vscode/src/test/slice5-audit.test.ts
  extensions/vscode/src/test/slice5-next-pass.test.ts
  extensions/vscode/src/test/slice5-runtime.test.ts
  extensions/vscode/src/test/slice5-ui.test.ts
  extensions/vscode/src/test/timeout-diagnostics.test.ts
  extensions/vscode/src/test/timeout-recovery.test.ts
  extensions/vscode/src/test/tool-classification.test.ts
  extensions/vscode/src/test/tool-groups-primed.test.ts
  extensions/vscode/src/test/tool-result-compression.test.ts
  extensions/vscode/src/test/webview-bundle.test.ts
  extensions/vscode/src/tool-classification.ts
  extensions/vscode/src/tool-groups.ts
  extensions/vscode/src/tool-result-compression.ts
  extensions/vscode/src/types.ts
  extensions/vscode/src/webview/card-renderer.ts
  extensions/vscode/src/webview/entity-links.ts
  extensions/vscode/src/webview/index.ts
  extensions/vscode/src/webview/protocol.ts
  extensions/vscode/src/webview/render-markdown.ts
  extensions/vscode/src/webview/styles.ts
scripts/
  scripts/_codeql_scan.cjs
  scripts/_codeql_scan.js
  scripts/_fix_alert3.cjs
  scripts/_fix_codeql.cjs
  scripts/_grep_out.txt
  scripts/_grep.cjs
  scripts/_grep2.cjs
  scripts/_insights_out.json
  scripts/_mcp_call.cjs
  scripts/_mcp_init.json
  scripts/_mcp_insights.json
  scripts/_mcp_result.json
  scripts/_mcp_root.txt
  scripts/add-backlinks.mjs
  scripts/audit-nodes.mjs
  scripts/audit-orphans.mjs
  scripts/benchmark-token-economy.mjs
  scripts/build-plugin-docs.ps1
  scripts/enrich-graph.mjs
  scripts/generate-architecture-tree.mjs
  scripts/generate-easy-start-docs.mjs
  scripts/generate-primary-workflow-docs.mjs
  scripts/install.ps1
  scripts/install.sh
  scripts/mcp-call.mjs
  scripts/probe-hello-events.mjs
  scripts/record-adr-v9-release.mjs
  scripts/repair-confidence-inflation.mjs
  scripts/stub-dangling.mjs
  scripts/validate-live-manifest.mjs
  scripts/webhook-test-receiver.mjs
  scripts/wire-links-cli.mjs
```

## Version Semantics

A DreamGraph installation may surface more than one version value:

- **Created With** — the version recorded in an instance identity file when the instance was created
- **Daemon Version** — the version reported by the currently running daemon binary
- **Package Version** — the repository/package version declared in `package.json`

These values can legitimately differ after upgrades or when an older instance continues to run under a newer daemon.

## Licensing

DreamGraph is distributed under the **DreamGraph Source-Available Community License v2.0**. It is source-available and should not be described as OSI-approved open source unless a specific edition is separately released under such a license.

See `LICENSE` for the authoritative license text.
<!-- CONTINUATION TEST SLICE 2 -->
