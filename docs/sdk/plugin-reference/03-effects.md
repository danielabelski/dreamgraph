# Effects (normative)

[← Index](00-index.md) · Source: [packages/sdk/src/manifest.ts](../../../packages/sdk/src/manifest.ts) `PluginEffectSchema`

An **effect** describes an observable cognitive impact a plugin claims it will
have (`expectedEffects`) or guarantees it will not have (`forbiddenEffects`).
The host enforces both at every host-mediated effect call:

- An effect not in `expectedEffects` → `plugin.output.rejected{ effect_undeclared }`.
- An effect in `forbiddenEffects` → `plugin.output.rejected{ effect_forbidden }`,
  even if the matching capability would otherwise allow it.

| Effect                       | Meaning                                                                  | Required capability         |
| ---------------------------- | ------------------------------------------------------------------------ | --------------------------- |
| `read_events`                | Subscribe to the bus (any kind).                                         | `events:read` (or `:experimental`) |
| `read_internal_graph`        | Read internal-tier files (graph, validated edges, tensions).             | (host-mediated, no plugin write API) |
| `read_external_state`        | Read external-tier files (features, archetypes, ADRs, UI registry).      | (host-mediated)             |
| `write_internal_graph`       | Mutate the graph (promote candidates, edit edges).                       | **always forbidden**        |
| `modify_tensions`            | Create or resolve tensions.                                              | **always forbidden**        |
| `emit_resource`              | Register or update an MCP resource.                                      | `resources:register`        |
| `emit_tool`                  | Register an MCP tool.                                                    | `tools:register`            |
| `emit_event`                 | Publish events onto the bus.                                             | `events:emit`               |
| `emit_webhook`               | (reserved) outbound HTTP via webhook worker.                             | `webhooks:emit`             |
| `register_schedule_action`   | (reserved) custom schedule action.                                        | `schedule:register_action`  |
| `invoke_llm`                 | Call the host LLM proxy.                                                  | (post-M4)                   |
| `mutate_ui_registry`         | Register/update UI elements.                                              | `ui:register`               |
| `propose_policy`             | Append discipline rules.                                                  | `policy:propose`            |
| `provide_archetypes`         | Feed federation archetypes.                                               | `archetypes:provide`        |
| `render_markdown_fence`      | Declare a webview markdown fence.                                         | `markdown:register_fence`   |
| `register_provider_adapter`  | (reserved, post-1.0) provider adapter.                                    | `providers:register`        |

## Always-forbidden effects

`write_internal_graph` and `modify_tensions` are not exposed by `ctx` at all.
A plugin that lists them in `expectedEffects` will fail manifest validation
because the matching capability does not exist. They are listed here for
completeness so plugin authors know to put them in `forbiddenEffects` as
defensive intent.

## Effect-to-seam matrix

| Seam call                                         | Effect required in `expectedEffects` |
| ------------------------------------------------- | ------------------------------------ |
| `ctx.tools.register`                              | `emit_tool`                          |
| `ctx.resources.register`                          | `emit_resource`                      |
| `ctx.events.subscribe`                            | `read_events`                        |
| `ctx.events.emit`                                 | `emit_event`                         |
| `ctx.ui.register`                                 | `mutate_ui_registry`                 |
| `ctx.policies.propose`                            | `propose_policy`                     |
| `ctx.archetypes.registerProvider`                 | `provide_archetypes`                 |
| `ctx.markdownFences.register`                     | `render_markdown_fence`              |
