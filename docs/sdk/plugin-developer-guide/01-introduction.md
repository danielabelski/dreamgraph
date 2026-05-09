# 1. Introduction

[← Index](00-index.md) · [Next: Quickstart →](02-quickstart.md)

## 1.1 What is a DreamGraph plugin?

A **plugin** is a declarative + code package that extends a single DreamGraph instance
through one or more **seams** — typed extension points exposed by the host. A plugin
ships at minimum:

- a `plugin.json` manifest validated against the SDK schema, and
- an ESM entry module exporting a default `activate(ctx)` function.

When the host loads the plugin (in-process, see §9), it calls `activate(ctx)` once.
Inside that function the plugin uses the `ctx.*` surfaces to register tools,
resources, UI elements, policy proposals, archetype providers, markdown fences, and
to subscribe to or emit events.

## 1.2 What a plugin is *not*

DreamGraph deliberately keeps the plugin contract narrow. A plugin **cannot**:

- reach the filesystem, network, or other instances directly through `ctx`;
- mutate the internal cognitive graph (`dream_graph.json`, `validated_edges.json`,
  `tension_log.json`, `event_log.json`);
- create or resolve tensions;
- subscribe to the host event bus from outside `ctx`;
- discover or interact with other plugins;
- invoke arbitrary `setInterval` / `setTimeout` schedulers (use schedule actions
  once M4 ships);
- run as a sandboxed process (M3 model is **trusted in-process**; see §9).

The full deny list lives in [docs/sdk/plugin-context.md](../plugin-context.md) and
in §5 of this guide.

## 1.3 Seams shipped through M6

| Seam              | Capability                | Effect                  | Milestone |
| ----------------- | ------------------------- | ----------------------- | --------- |
| `tools`           | `tools:register`          | `emit_tool`             | M3/M4     |
| `resources`       | `resources:register`      | `emit_resource`         | M3/M4     |
| `events.subscribe`| `events:read`             | `read_events` (implicit)| M3        |
| `events.emit`     | `events:emit`             | `emit_event`            | M3        |
| `ui`              | `ui:register`             | `mutate_ui_registry`    | M6        |
| `policies`        | `policy:propose`          | `propose_policy`        | M6        |
| `archetypes`      | `archetypes:provide`      | `provide_archetypes`    | M6        |
| `markdownFences`  | `markdown:register_fence` | `render_markdown_fence` | M6        |

**Out of scope (post-M6):**

- `webhooks:emit` — webhooks ship in M5 as a *core* subsystem, not a plugin seam.
  Plugins can register subscriptions only via the host CLI/MCP tools.
- `schedule:register_action` — the SDK type exists, but the host registry refactor
  (M4) is deferred. `defineScheduleAction` is reserved.
- `providers:register` — provider adapter seam is post-1.0.
- Executable iframe UI — the M6 builder is metadata-only.

## 1.4 Trust posture in one paragraph

Plugins run **in-process** inside the daemon. They share its heap and its Node
permissions. The host can refuse to load a plugin (manifest invalid, capability
not declared, host switch off, plugin not trusted), but it cannot prevent a
malicious plugin from reaching `process` or `fs` through Node globals. **Treat
installing a plugin like editing your `~/.bashrc`.** The full trust model is in §9.

[← Index](00-index.md) · [Next: Quickstart →](02-quickstart.md)
