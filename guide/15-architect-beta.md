# 15. Architect Beta

> **TL;DR** - In v12.0.0 Hippodamus, **architect** means the standalone browser-based DreamGraph Architect. The editor-integrated surface is now called the **VS Code architect**.

The architect beta is the standalone browser surface for doing repository work through the DreamGraph daemon. It is not a separate product and it is not a static documentation page. It is the daemon-served Architect experience: project-aware chat, graph grounding, plan awareness, tool traces, runtime provenance, and governed source/graph mutation through DreamGraph MCP authority.

Use architect when you want the full DreamGraph working surface outside VS Code, or when the repository workflow should be browser-first while still staying attached to the same instance, graph, ADRs, plans, and daemon tools.

---

## Naming in v12

From v12.0.0 onward:

| Name | Meaning |
|------|---------|
| **architect** | The standalone browser-based Architect beta. |
| **VS Code architect** | The Architect chat surface inside the VS Code extension. |
| **DreamGraph daemon** | The instance runtime that serves MCP tools, HTTP APIs, dashboard data, graph state, and architect sessions. |
| **Explorer** | The interactive graph browser, available through DreamGraph surfaces. |

Older docs may say "Standalone Architect" while describing this beta. Treat that as the same surface now called **architect**.

---

## What architect is for

Architect is for project-bound engineering work where DreamGraph is the authority. It is best for:

- Asking repository and architecture questions that should be grounded in graph facts, ADRs, workflows, data models, and source evidence.
- Running multi-step implementation work where tool use, changed files, and runtime provenance should remain visible.
- Working with selected plans without relying on hidden chat context.
- Reviewing tool traces and pass state while an autonomous or semi-autonomous task is running.
- Switching between project-level chat and plan-scoped chat while keeping the daemon as the source of truth.
- Inspecting the model/provider/adapter route that produced a response.

Architect is beta because the browser shell is now usable as the primary DreamGraph Architect surface, but the UX and some workflows are still being hardened. The daemon, graph, ADR, source-inspection, and mutation authority remain the same governed DreamGraph systems used by the rest of the project.

---

## Prerequisites

Before opening architect, you need:

- DreamGraph v12.0.0 Hippodamus installed.
- A DreamGraph instance created with `dg init`.
- A project attached to that instance, either during `dg init` or later with `dg attach`.
- The daemon running in HTTP mode.
- At least one configured Architect provider or CLI adapter, such as OpenAI, Anthropic, Ollama, LM Studio, Copilot CLI, or Codex CLI.

For setup details, read [Installation](02-installation.md), [Your first instance](03-first-instance.md), and [LLM setup](04-llm-setup.md).

---

## Start the daemon for architect

Architect is served by the DreamGraph daemon, so start the instance in HTTP mode:

```bash
dg start my-project --http
```

Then check the active endpoint:

```bash
dg status my-project
```

`dg status` shows the daemon host, port, instance identity, attached project path, and running version. Open the HTTP URL shown for the instance in your browser. If your installer or local workflow exposes a direct architect link, use that link; it resolves to the same daemon-served surface.

---

## First launch checklist

On first launch, verify these signals:

1. The page identifies the current instance and attached project.
2. The chat header shows the active adapter/provider/model route.
3. The scope indicator shows whether you are in project chat or selected-plan chat.
4. Tool traces appear when architect uses DreamGraph MCP tools.
5. File and graph mutations are routed through DreamGraph-governed tools, not through untracked browser state.

If the page opens but has no instance context, start with `dg status my-project` and confirm the daemon is running in HTTP mode for the instance you expected.

---

## Project chat vs selected-plan chat

Architect supports two practical scopes:

| Scope | Use it when |
|-------|-------------|
| **Project chat** | You want repository-wide answers, release work, graph inspection, documentation, or implementation tasks that are not bound to a specific plan. |
| **Selected-plan chat** | You are actively working a plan and want responses grounded in that plan's lifecycle, artifacts, and implementation context. |

The selected-plan state is explicit. Do not assume a plan is selected just because a previous conversation mentioned one. Architect should show the current scope so you can tell whether a request is project-bound or plan-bound.

---

## Tool traces and runtime provenance

Architect beta is designed to make agent work inspectable. During a pass, you should be able to see:

- Adapter and execution route, such as `codex-cli` or another configured provider route.
- Provider and model, when applicable.
- Autonomy mode and pass state.
- DreamGraph MCP tool calls and results.
- Local command/build/test verification when a task requires it.
- Changed files and release artifacts produced by the pass.

This matters because DreamGraph work should be auditable. A repository-specific answer should be traceable to graph queries, source reads, ADR checks, commands, or generated artifacts.

---

## Safe mutation model

Architect does not make the browser the source of truth. For repository work, it uses DreamGraph-governed authority:

- Source reads use DreamGraph source-inspection tools.
- File edits use DreamGraph patch/create/mutation tools.
- Build, test, packaging, git, and release verification run through the DreamGraph command bridge.
- Knowledge-graph changes use graph tools such as ADR recording, UI registry registration, feature/workflow/data-model enrichment, and living-doc export.

If a request conflicts with accepted ADRs, UI-registry contracts, or daemon authority, architect should stop and explain the conflict rather than inventing a browser-only workaround.

---

## Common workflows

| Workflow | Typical request |
|----------|-----------------|
| Architecture question | "What workflows touch billing and which ADRs constrain them?" |
| Implementation | "Add this endpoint, update tests, and verify the build." |
| Documentation | "Update the user guide and release notes for this feature." |
| Release work | "Bump versions, package artifacts, tag the release, and draft the GitHub release." |
| Graph curation | "Record this decision as an ADR and link it to the affected workflow." |
| Plan work | "Continue the selected plan and show the changed files before finalizing." |

For broad repair requests, architect should establish project health first, then inspect, patch, verify, and report the result.

---

## Beta expectations

Architect beta is intended for real project work, but you should still expect some rough edges:

- Browser layout and controls may change during the beta line.
- Some workflows may still expose historical labels such as "Standalone Architect".
- Long autonomous passes depend on adapter and CLI behavior outside the browser shell.
- If a provider route loses authentication, you may need to recover the provider login and rerun the pass.

The important invariant is that the daemon remains authoritative. The browser can improve quickly without changing the underlying graph, ADR, MCP, and source-mutation governance model.

---

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Architect cannot connect | Run `dg status my-project`; confirm the daemon is running in HTTP mode. |
| Wrong project appears | Confirm the instance's attached project path with `dg status` and `dg attach`. |
| No model response | Check provider settings and credentials in [LLM setup](04-llm-setup.md). |
| No tool trace for a repo-specific answer | Treat the answer as ungrounded and ask architect to verify through DreamGraph MCP tools. |
| Changes do not appear | Check changed files with git status and confirm the pass completed rather than stopping on an adapter error. |

---

## Next

If you work primarily in VS Code, read [The VS Code extension](06-vs-code-extension.md). If you want to understand the graph view behind architect, read [The Explorer](07-the-explorer.md).
