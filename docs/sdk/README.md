# DreamGraph Plugin SDK

This directory documents the shipped DreamGraph plugin SDK and trusted in-process host runtime.

## Scope

`@dreamgraph/sdk` provides plugin authoring types, manifest validation, telemetry vocabulary, reject reasons, declaration helpers, and public seam contracts. `@dreamgraph/host` provides the daemon-owned `PluginContext` runtime boundary. Plugins are discovered through normal instance administration, validated before import, and activated only under the existing trust and engine compatibility rules.

The standalone Architect extension seam is first-class and declarative. Trusted plugins can register host-rendered tab types through `ctx.architect.tabs.register()` and persist namespaced plan state through `ctx.architect.planState`. Browser clients receive validated descriptors and JSON snapshots through versioned daemon routes; they do not load plugin modules or gain repository, plan-file, graph, or filesystem authority.

## Documentation

- [Plugin Developer Guide](plugin-developer-guide/00-index.md)
- [Plugin Reference Manual](plugin-reference/00-index.md)
- [PluginContext overview](plugin-context.md)
- [`examples/hello-events`](../../examples/hello-events/) for the broad SDK seam walkthrough
- [`examples/action-checklist`](../../examples/action-checklist/) for standalone Architect tabs, explicit plan scope, daemon persistence, governed actions, sidebar summaries, and badges

## Trust boundary

Trusted in-process plugin execution is an API trust boundary, not a sandbox. The host mediates supported seams, applies capability and effect gates, emits telemetry, and removes active contributions on unload or reload. Arbitrary browser JavaScript, HTML, remote scripts, iframes, direct DOM callbacks, and direct browser persistence are not Architect SDK surfaces.
