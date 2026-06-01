# 4. Manifest and capabilities

[← Anatomy](03-anatomy.md) · [Next: PluginContext →](05-plugin-context.md)

## 4.1 The intent-first manifest

Every plugin ships a `plugin.json` validated against `PluginManifestSchema`
([source](../../../packages/sdk/src/manifest.ts)). The schema is **intent-first**:
it asks not only *what permissions you want* (capabilities) but *what observable
effects you claim you will have* (`expectedEffects`) and *what you guarantee not
to do* (`forbiddenEffects`).

```jsonc
{
  "id": "acme.changelog",
  "version": "0.1.0",
  "displayName": "Acme Changelog",
  "description": "Weekly changelogs from validated edges.",
  "engine": { "dreamgraph": ">=9.0.0" },
  "main": "./dist/index.js",

  "intent": "Summarize validated cognitive changes into weekly changelogs.",
  "expectedEffects": ["read_events", "emit_resource", "emit_tool"],
  "forbiddenEffects": ["write_internal_graph", "modify_tensions"],

  "capabilities": ["events:read", "tools:register", "resources:register"],

  "tools":      [{ "name": "acme.changelog.summarize_week" }],
  "resources":  [{ "uriNamespace": "plugin://acme.changelog/latest" }],
  "ui":         [],
  "policies":   [],
  "archetypeProviders": [],
  "markdownFences":     [],

  "policy": { "phasePermissions": ["analysis"], "writableFiles": [] }
}
```

## 4.2 Why three orthogonal axes (capability, effect, intent)?

| Axis              | Question it answers              | Enforced where                    |
| ----------------- | -------------------------------- | --------------------------------- |
| `capabilities`    | *Are you allowed to use the API?*| At seam call time (gate function) |
| `expectedEffects` | *What do you say you will do?*   | At every host-mediated effect     |
| `forbiddenEffects`| *What do you guarantee NOT to do?*| Hard stop, even if capability allows |
| `intent`          | *Why are you doing it?*          | Operator review + telemetry       |

A plugin that performs an effect outside `expectedEffects` emits
`plugin.output.rejected{ reason: "effect_undeclared" }` and is auto-quarantined.
A plugin that hits a `forbiddenEffects` entry is refused even if the matching
capability would otherwise allow it.

## 4.3 The capability vocabulary

Locked for v1 — see [reference / capabilities](../plugin-reference/02-capabilities.md):

| Capability                     | Allows                                              |
| ------------------------------ | --------------------------------------------------- |
| `events:read`                  | subscribe to **stable** event kinds                 |
| `events:read:experimental`     | subscribe to experimental kinds (instance opt-in)   |
| `events:emit`                  | publish via `ctx.events.emit()`                     |
| `tools:register`               | `defineTool` registration                           |
| `resources:register`           | `defineResource` registration                       |
| `resources:read`               | (reserved) read other plugins' resources            |
| `ui:register`                  | metadata-only UI element registration               |
| `policy:propose`               | append discipline rules tagged `plugin:<id>`        |
| `schedule:register_action`     | (reserved, M4) custom schedule actions              |
| `webhooks:emit`                | (reserved, post-MVP) plugin-driven outbound HTTP    |
| `archetypes:provide`           | register a federation archetype provider            |
| `providers:register`           | (reserved, post-1.0) provider adapter seam          |
| `markdown:register_fence`      | register a webview markdown fence language          |
| `architect:register_tab`       | register a manifest-declared standalone Architect tab |
| `architect:read_plan`          | read explicit plan-bound Architect state            |
| `architect:write_plan_state`   | persist daemon-owned namespaced Architect state     |
| `architect:register_sidebar_summary` | project Architect sidebar summary and badges   |

A capability not present in the manifest's `capabilities` array means the
matching seam call returns `*_capability_missing` and is dropped.

## 4.4 The effect vocabulary

| Effect                       | Meaning                                                              |
| ---------------------------- | -------------------------------------------------------------------- |
| `read_events`                | subscribe to the bus                                                 |
| `read_internal_graph`        | read internal-tier files (graph, validated edges, tensions)          |
| `read_external_state`        | read external-tier files (features, archetypes, ADRs, UI registry)  |
| `write_internal_graph`       | mutate the graph                                                     |
| `modify_tensions`            | create/resolve tensions                                              |
| `emit_resource`              | register/update an MCP resource                                      |
| `emit_tool`                  | register an MCP tool                                                 |
| `emit_event`                 | publish events                                                       |
| `emit_webhook`               | (reserved) outbound HTTP via webhook worker                          |
| `register_schedule_action`   | (reserved) custom schedule action                                    |
| `invoke_llm`                 | call the host LLM proxy                                              |
| `mutate_ui_registry`         | register/update UI elements                                          |
| `propose_policy`             | append discipline rules                                              |
| `provide_archetypes`         | feed federation archetypes                                           |
| `render_markdown_fence`      | declare a webview markdown fence                                     |
| `register_provider_adapter`  | (reserved) provider adapter                                          |
| `render_architect_tab`       | project a host-rendered standalone Architect tab                     |
| `read_architect_plan_projection` | load an explicit plan-bound Architect snapshot                  |
| `write_architect_plan_state` | persist daemon-owned namespaced Architect state                      |
| `render_architect_sidebar_summary` | project sidebar summary and badge data                         |

## 4.5 Naming rules — both ids and tool names

| Surface             | Pattern                                          | Reject reason                |
| ------------------- | ------------------------------------------------ | ---------------------------- |
| `id`                | `^[a-z0-9][a-z0-9.-]*[a-z0-9]$` (DNS-like)       | `manifest_invalid`           |
| Tool `name`         | `<plugin-id>.<tool_name>` (lowercase, dot-prefixed) | `tool_name_unprefixed`    |
| Resource `uri`      | `plugin://<plugin-id>/...`                       | `resource_uri_out_of_namespace` |
| UI element `id`     | starts with `<plugin-id>.`                       | `ui_id_unprefixed`           |
| Policy proposal id  | lowercase `[a-z0-9._-]+`                          | `manifest_invalid`           |
| Markdown fence lang | lowercase `[a-z0-9._-]+`, no collision           | `markdown_fence_language_invalid` / `_collision` |
| Architect tab `id`  | starts with `<plugin-id>.`; runtime declaration matches manifest | `architect_tab_id_unprefixed` / `architect_tab_undeclared` |

**Per ADR-128**, tool names must carry primary semantics: a model should be able
to infer the dominant action and target from the name alone, without reading the
description. Prefer `summarize_week` over `process_data`.

## 4.6 Engine version range

`engine.dreamgraph` is a semver range. The host refuses to load plugins whose
range excludes the current engine version (`engine_version_mismatch`). Ship the
narrowest range that actually works — `>=9.0.0` is appropriate for v1 plugins.

[← Anatomy](03-anatomy.md) · [Next: PluginContext →](05-plugin-context.md)
