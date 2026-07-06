# DreamGraph User Guide

Welcome. This guide is the friendly, hand-written companion to DreamGraph. It is intended for **humans who want to use the system**, not for the system documenting itself.

This same guide is also published on the website: **[dreamgraph.nofs.ai](https://dreamgraph.nofs.ai/guide/overview)** — same content, nicer reading experience.

If you are looking for the auto-generated reference (every tool, every parameter, every schema), that lives in [`docs/`](../docs/). This guide is the part you read first.

For the shortest route from install to a working browser setup, start with **[DreamGraph Easy Start](00-easy-start.md)**.

Current release: **v12.6.0 - Hippodamus**.

---

## Who this guide is for

- **First-time users** who installed DreamGraph and are now staring at a CLI prompt
- **Developers** who want to understand the mental model before writing code against it
- **Architects** who want to know what DreamGraph actually *does* with your repository
- **People who tried it once, got confused, and bounced** — we want you back

You do **not** need to read the guide top-to-bottom. Jump to whichever page matches your current question.

---

## Read in order (recommended for first-timers)

| # | Page | What you'll learn |
|---|------|-------------------|
| 0 | [DreamGraph Easy Start](00-easy-start.md) | The shortest setup path for a new project, existing repo, multi-repo system, Codex CLI, or Anthropic API. |
| 1 | [What is DreamGraph?](01-what-is-dreamgraph.md) | The mental model. Graph + dreams + cognitive engine, in plain language. |
| 2 | [Installation](02-installation.md) | One-command install, prerequisites, common install gotchas. |
| 3 | [Your first instance](03-first-instance.md) | `dg init`, attaching a repo, starting the daemon. |
| 4 | [LLM setup](04-llm-setup.md) | Connecting Ollama, LM Studio, OpenAI, or Anthropic. Choosing a model. |
| 5 | [Bootstrapping the graph](05-bootstrapping-the-graph.md) | What `dg scan` actually does. Where your data lives. |
| 6 | [The VS Code extension](06-vs-code-extension.md) | A tour of the sidebar: Architect chat, dashboard, Explorer, changed files. |
| 7 | [The Explorer](07-the-explorer.md) | Browsing the graph, inspector, tensions, candidates, search. |
| 8 | [Dreams and cycles](08-dreams-and-cycles.md) | What dreaming means, when to do it, what to expect. |
| 9 | [Curating the graph](09-curating-the-graph.md) | Reviewing tensions, promoting/rejecting candidates, recording ADRs. |
| 10 | [A typical daily workflow](10-daily-workflow.md) | A sustainable loop. What to do in the morning, what to leave running. |
| 11 | [Multi-repo and monorepo setups](11-multi-repo.md) | Attaching more than one repository, including large monorepos. |
| 12 | [Troubleshooting & FAQ](12-troubleshooting-faq.md) | Diagnosing daemon, graph, model, extension, and workflow issues. |
| 13 | [Glossary](13-glossary.md) | Plain-language definitions for DreamGraph terms. |
| 14 | [Adaptive Future Engine](14-adaptive-future-engine.md) | What AFE is, where it runs, how it is deployed, and how to read its audit trails. |
| 15 | [Architect beta](15-architect-beta.md) | The standalone browser-based architect beta introduced in v12.0.0 Hippodamus. |
| 16 | [Architect For Dummies](architect-for-dummies.md) | Task-first onboarding, screen tour, recipes, slash commands, and authority limits. |

## Topical reference (read as needed)

| Page | When to read it |
|------|-----------------|
| [Multi-repo and monorepo setups](11-multi-repo.md) | You have more than one repository, or one big monorepo. |
| [Troubleshooting & FAQ](12-troubleshooting-faq.md) | Something is wrong and you want a quick checklist. |
| [Glossary](13-glossary.md) | "Wait, what's a *latent candidate* again?" |
| [Adaptive Future Engine](14-adaptive-future-engine.md) | You want to understand candidate-future ranking and audit trails. |
| [Architect beta](15-architect-beta.md) | You want the standalone browser architect surface rather than the VS Code architect. |
| [Architect For Dummies](architect-for-dummies.md) | You want the shortest task-first walkthrough of the current Architect controls. |

---

## How DreamGraph fits into your day

You install DreamGraph once. Then it runs as a background daemon you barely think about. You interact with it through four surfaces:

1. **The `dg` CLI** — for setup, daemon control, and one-off maintenance.
2. **Architect** — the standalone browser-based Architect beta introduced in v12.0.0 Hippodamus.
3. **The VS Code extension** — for the VS Code architect, dashboard, Explorer, and changed-files context.
4. **MCP tools** — automatically available to any MCP-aware AI agent once the daemon is running.

Most days you will never type `dg` after starting the daemon. You'll talk to architect or the VS Code architect and browse the Explorer.

---

## A few promises this guide makes

- **No surprise jargon.** Every cognitive-engine term is defined the first time it appears, and again in the [glossary](13-glossary.md).
- **Concrete commands.** Every page that tells you to do something shows you the exact command.
- **Honest about rough edges.** If something is finicky or experimental, this guide says so.
- **No marketing.** This guide does not try to sell you DreamGraph. You already installed it.

---

## When you get stuck

1. Check the [Troubleshooting & FAQ](12-troubleshooting-faq.md) page first.
2. Run `dg status <instance>` — most problems show up there.
3. Check the daemon logs at `~/.dreamgraph/<instance-uuid>/logs/`.
4. File an issue at <https://github.com/mmethodz/dreamgraph/issues> with the output of `dg status` and the relevant log snippet.

---

Ready? Start with **[DreamGraph Easy Start](00-easy-start.md)**
