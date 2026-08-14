# DreamGraph Plugin Developer Guide

**Audience:** Engineers writing third-party plugins against `@dreamgraph/sdk`.
**Engine baseline:** v13.1.0 "Additive Scan" (M0-M6 implemented; graph-health diagnostics, confidence-aware semantic enrichment, targeted dream stabilization, and structured Explorer knowledge inspection are current).
**Companion:** see the [Plugin Reference Manual](../plugin-reference/00-index.md) for strict, normative tables.

This guide is task-oriented. It walks you from "what is a plugin" through a working
example, then explains every seam, the trust model, lifecycle, telemetry, testing,
and the practices DreamGraph expects.

## Table of contents

1. [Introduction](01-introduction.md) — what a plugin is and is not.
2. [Quickstart: Hello Events](02-quickstart.md) — five-minute end-to-end install.
3. [Anatomy of a plugin](03-anatomy.md) — files, packaging, ESM rules.
4. [Manifest and capabilities](04-manifest-and-capabilities.md) — `plugin.json`, intent, effects.
5. [The PluginContext](05-plugin-context.md) — what `ctx` exposes (and what it deliberately does not).
6. [Seams: tools and resources](06-seams-tools-resources.md) — the MCP-facing surface.
7. [Seams: events](07-seams-events.md) — subscribe, emit, stable vs experimental.
8. [Seams: UI, policies, archetypes, markdown fences](08-seams-closure.md) — the M6 closure surface.
9. [Trust and security model](09-trust-and-security.md) — in-process today, worker isolation tomorrow.
10. [Installation and lifecycle](10-lifecycle-and-installation.md) — discovery, trust, restart, hot-disable.
11. [Telemetry, debugging, testing](11-telemetry-debugging-testing.md) — `plugin.*` events and the test harness.
12. [Best practices and pitfalls](12-best-practices.md) — naming, naming, naming. And quotas.
13. [Architect tabs](13-architect-tabs.md) — declarative standalone Architect tabs, explicit plan scope, persistence, and actions.

> **Building this guide locally as HTML/PDF:** run `scripts/build-plugin-docs.ps1`.
> Outputs land under `docs/sdk/site/html/` and `docs/sdk/site/pdf/`.
