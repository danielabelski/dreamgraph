# DreamGraph v10.6.0 — Renata

**v10.6.0** continues the Renata line. It introduces the **Codex CLI native architect adapter (beta)** alongside continued **Copilot CLI** maturation, and aligns the CLI, daemon, VS Code extension, dashboard, Explorer, SDK, host package, root documentation, docs, and user guide to one published version line.

No breaking changes are intended for existing v10.x installations.

---

## Headline changes

### 1. Codex CLI native architect adapter (beta) — use your ChatGPT subscription

DreamGraph now ships a **native Codex CLI adapter** for the VS Code Architect. If you already pay for **ChatGPT Plus, Pro, or Team**, you can now lift that same OpenAI subscription into DreamGraph — **no separate OpenAI API key required** — and use GPT-class models as a first-class, graph-grounded architect.

This is the feature hundreds of you have been asking for. It is now real.

What you get:

- **OAuth via your existing ChatGPT account.** Codex CLI authenticates with your ChatGPT subscription. DreamGraph reuses that login. No API billing setup, no separate key management.
- **Native Architect adapter, not a wrapper.** Codex CLI runs inside the same fail-closed Architect contract as Copilot CLI: DreamGraph MCP is authoritative, every tool call is audited, and transcript-only "phantom" tool claims are rejected.
- **Inheritance-proxy MCP bridge.** Codex CLI shares the Architect's live DreamGraph session and authoritative tool registry, with an isolated `config.toml` and read-only sandboxing per run.
- **Graph-grounded reasoning.** The same bounded context, ADR awareness, workflow grounding, and audit reconciliation that powers the Copilot CLI path is applied to Codex CLI runs.
- **Live tool progress.** Codex CLI tool activity is streamed from the shared audit NDJSON, not from provider stdout — so what you see is what actually ran.
- **Honest diagnostics.** Specific failure classes (`CODEX_MODEL_UNSUPPORTED`, usage-limit, policy-denied, not-logged-in) are classified separately and surfaced cleanly instead of being collapsed into a single opaque error.

> **Status: beta.** The architecture, audit boundary, and fail-closed contract are production-grade and match the Copilot CLI adapter. The "beta" label reflects ongoing hardening against Codex CLI provider/runtime drift (model availability, stderr/event shape changes). It works today. Expect continued polish in v10.7.x.

**Pairs perfectly with Copilot CLI.** Many teams will want both adapters available: Copilot CLI for your GitHub Copilot account, Codex CLI for your ChatGPT account. Switch providers per run, keep the same graph, keep the same audit guarantees.

### 2. Copilot CLI architect adapter — per-turn diff view

The Copilot CLI adapter (released in v10.5.0) gains a **per-turn diff view**: after each Architect turn, you can see exactly what files Copilot CLI changed and how, as a normal diff. Per-tool-call diff granularity is postponed to a later release.

This continues the v10.5.0 hardening line (DreamGraph MCP authority, inheritance-proxy bridge, audited `dreamgraph:run_command` routing, idle-output timeout, cause-specific cancellation and retry-success verification).

### 3. Version and documentation alignment

This release aligns all first-party versioned surfaces to **10.6.0**:

- Root daemon/CLI package and package lock.
- `@dreamgraph/sdk` and `@dreamgraph/host` workspace packages.
- Explorer package and package lock.
- VS Code extension package, package lock, runtime MCP client identity, activation-version marker, and extension README.
- CLI version output and MCP client identity (`dg.ts`, `mcp-call.ts`).
- Root README, architecture docs, SDK docs, plugin guide/reference, and user-guide install examples.

---

## Upgrade notes

- **Node 20+ remains required.**
- Re-run the installer (`scripts/install.ps1 -Force` or `bash scripts/install.sh --force`) after pulling this release. This is the primary DreamGraph install path because the product is the daemon, engine, CLI, instance registry, MCP-backed graph services, and companion editor surface together.
- Install or update `dreamgraph-vscode-10.6.0.vsix` only after the local DreamGraph stack is installed. The VSIX is a VS Code companion surface, not a standalone DreamGraph distribution.
- Reload VS Code after installing the companion VSIX.
- Restart running DreamGraph daemons so the v10.6.0 CLI/daemon/runtime strings and adapter behavior are active.
- **To use the Codex CLI adapter:** install Codex CLI separately and sign in with your ChatGPT account (`codex login`). DreamGraph will detect the existing login and use it. No API key required.
- **To use the Copilot CLI adapter:** install Copilot CLI and sign in with your GitHub Copilot account. Same pattern — DreamGraph reuses the existing CLI login.

## Artifacts

This release attaches the generated first-party artifacts for the full DreamGraph system and its companion surfaces:

- `dreamgraph-10.6.0.tgz`
- `dreamgraph-sdk-10.6.0.tgz`
- `dreamgraph-host-10.6.0.tgz`
- `dreamgraph-vscode-10.6.0.vsix` — companion VS Code surface; requires the DreamGraph daemon/engine/CLI stack installed separately

## Commits since v10.5.0

```text
454ba4d (feature): codex-cli release. lift your existing openai plus/pro subscription into new levels of knowledge. codex times 100. perfect partners. still beta but works.
550ed96 Copilot CLI updated to view the per file diff after each turn (per tool call implementation postponed)
```
