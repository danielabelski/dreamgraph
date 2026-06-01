# Capabilities (normative)

[← Index](00-index.md) · Source: [packages/sdk/src/manifest.ts](../../../packages/sdk/src/manifest.ts) `PluginCapabilitySchema`

A capability is a coarse permission a plugin MUST declare to use a seam. The
host validates the manifest against this enum at load time, then re-checks at
each seam call site.

| Capability                    | Allows (positive)                                                  | Denies (with reason)                                                                                  | Status |
| ----------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------ |
| `events:read`                 | `ctx.events.subscribe(stable_kind, fn)`                            | subscribing to experimental kind → `event_kind_experimental`; kind not in declared subscription list → `event_kind_not_declared` | live |
| `events:read:experimental`    | `defineExperimentalEventHandler(...)`                              | unless `instance.json:experimental_plugins: true` → `experimental_events_disabled`                    | live |
| `events:emit`                 | `ctx.events.emit(kind, payload)`                                   | `emit_event` not in `expectedEffects` → `effect_undeclared`; missing capability → `emit_capability_missing` | live |
| `tools:register`              | `ctx.tools.register({ name: "<plugin-id>.<x>", ... })`             | name without `<plugin-id>.` prefix → `tool_name_unprefixed`; collision with built-in or other plugin → `tool_name_collision` | live |
| `resources:register`          | `ctx.resources.register({ uriNamespace: "plugin://<id>/...", ... })` | URI not in namespace → `resource_uri_out_of_namespace`                                              | live |
| `resources:read`              | (reserved) read another plugin's resource                          | always denied today                                                                                    | reserved |
| `ui:register`                 | `ctx.ui.register({ id: "<plugin-id>.<x>", ... })`                  | id not prefixed → `ui_id_unprefixed`                                                                   | live |
| `policy:propose`              | `ctx.policies.propose({ id, ... })` (tagged `source: plugin:<id>`)| proposal admits `weakens: true` or weakens an existing rule → `policy_weakening_rejected`              | live |
| `archetypes:provide`          | `ctx.archetypes.registerProvider({ id, inline | url | fetch })`    | payload fails archetype schema → `archetype_schema_invalid`                                            | live |
| `markdown:register_fence`     | `ctx.markdownFences.register({ language, ... })`                   | language regex fails → `markdown_fence_language_invalid`; collision → `markdown_fence_language_collision` | live |
| `schedule:register_action`    | (reserved, M4) `defineScheduleAction(...)`                         | always denied today                                                                                    | reserved |
| `webhooks:emit`               | (reserved, post-MVP) `ctx.webhooks.dispatch(...)`                  | always denied today (use core webhook subscriptions instead)                                           | reserved |
| `providers:register`          | (reserved, post-1.0) provider adapter seam                         | always denied today                                                                                    | reserved |
| `architect:register_tab`      | `ctx.architect.tabs.register(definition)`                          | missing capability -> `architect_tab_capability_missing`; undeclared tab -> `architect_tab_undeclared` | live |
| `architect:read_plan`         | `ctx.architect.planState.read(key, context)`                       | missing explicit plan -> `architect_plan_required`; missing plan -> `architect_plan_not_found`          | live |
| `architect:write_plan_state`  | `ctx.architect.planState.write(key, value, context)`               | missing capability -> `architect_plan_state_capability_missing`; stale revision -> `architect_revision_stale` | live |
| `architect:register_sidebar_summary` | project sidebar summary and badges from a tab snapshot       | undeclared effect -> `effect_undeclared`                                                                | live |

A capability not present in `manifest.capabilities` MUST cause the matching seam
call to be refused with `<seam>_capability_missing`. The host MUST NOT silently
drop the call.
