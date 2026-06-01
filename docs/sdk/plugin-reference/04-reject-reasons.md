# Reject reasons (normative)

[← Index](00-index.md) · Source: [packages/sdk/src/reject-reasons.ts](../../../packages/sdk/src/reject-reasons.ts)

Every `plugin.output.rejected` event carries one of the following `reason`
codes. The set is closed and exported as `PluginRejectReason` from the SDK.

## Per seam

### `tools`

| Reason                    | Meaning                                                          |
| ------------------------- | ---------------------------------------------------------------- |
| `tool_name_unprefixed`    | Tool name does not start with `<plugin-id>.`.                    |
| `tool_name_collision`     | Tool name collides with a built-in or another plugin.            |
| `tool_capability_missing` | `tools:register` not in `manifest.capabilities`.                 |

### `resources`

| Reason                            | Meaning                                                  |
| --------------------------------- | -------------------------------------------------------- |
| `resource_uri_out_of_namespace`   | URI does not start with `plugin://<plugin-id>/`.         |
| `resource_capability_missing`     | `resources:register` not declared.                       |

### `events`

| Reason                          | Meaning                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------- |
| `event_kind_not_declared`       | Subscriber kind not listed in the manifest's declared subscription set.       |
| `event_kind_experimental`       | Subscriber kind is experimental and the plugin lacks `events:read:experimental`. |
| `experimental_events_disabled`  | Instance has not opted into `experimental_plugins: true`.                     |
| `event_capability_missing`      | `events:read` (or `:experimental`) not declared.                              |
| `effect_undeclared`             | Plugin emitted an event whose effect is not in `expectedEffects`.            |
| `effect_forbidden`              | Plugin emitted an event whose effect is in `forbiddenEffects`.                |
| `emit_capability_missing`       | `events:emit` not declared.                                                   |

### `ui`

| Reason                  | Meaning                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `ui_id_unprefixed`      | Element id does not start with `<plugin-id>.`.                     |
| `ui_capability_missing` | `ui:register` not declared.                                        |

### `policy`

| Reason                       | Meaning                                                       |
| ---------------------------- | ------------------------------------------------------------- |
| `policy_weakening_rejected`  | Proposal weakens an existing rule (`weakens: true` or detected). |
| `policy_capability_missing`  | `policy:propose` not declared.                                |

### `archetypes`

| Reason                          | Meaning                                                  |
| ------------------------------- | -------------------------------------------------------- |
| `archetype_schema_invalid`      | Archetype payload fails schema validation.               |
| `archetype_capability_missing`  | `archetypes:provide` not declared.                       |

### `markdown_fences`

| Reason                                | Meaning                                              |
| ------------------------------------- | ---------------------------------------------------- |
| `markdown_fence_capability_missing`   | `markdown:register_fence` not declared.              |
| `markdown_fence_language_collision`   | Another plugin already owns the fence language.      |
| `markdown_fence_language_invalid`     | Language regex fails.                                |

### `schedule` (reserved)

`action_id_collision`, `action_schema_missing`, `schedule_capability_missing`.

### `webhooks` (reserved)

`webhook_unsigned`, `webhook_target_blocked`, `webhook_capability_missing`.

### `llm` (post-M4)

`llm_budget_exceeded`, `llm_disabled`, `llm_capability_missing`.

### `providers` (reserved)

`provider_capability_missing`.

### `architect`

| Reason                                    | Meaning                                                        |
| ----------------------------------------- | -------------------------------------------------------------- |
| `architect_tab_capability_missing`        | `architect:register_tab` not declared.                         |
| `architect_plan_state_capability_missing` | Required Architect plan-state capability not declared.         |
| `architect_tab_id_unprefixed`             | Tab id does not start with `<plugin-id>.`.                     |
| `architect_tab_collision`                 | Another active contribution owns the tab id.                   |
| `architect_tab_undeclared`                | Runtime tab registration does not match `manifest.architectTabs`. |
| `architect_action_unknown`                | Requested action id is not registered for the tab.             |
| `architect_action_schema_invalid`         | Action payload fails the registered JSON schema.               |
| `architect_plan_required`                 | A plan-bound operation omitted its explicit plan id.           |
| `architect_plan_not_found`                | The requested plan does not exist.                             |
| `architect_revision_stale`                | State write revision does not match current daemon state.      |
| `architect_tab_unavailable`               | Tab descriptor or handler is no longer active.                 |

## Host execution boundary

| Reason                            | Meaning                                                                |
| --------------------------------- | ---------------------------------------------------------------------- |
| `in_process_execution_disabled`   | `DG_ALLOW_INPROCESS_PLUGINS` is false **or** plugin not `trusted`.     |
| `plugin_quarantined`              | Plugin previously errored and is held until manual re-enable.          |
| `event_loop_stall`                | Watchdog detected a stall (lag > `DG_EVENT_LOOP_LAG_MS`).              |
| `handler_timeout`                 | Handler did not return within the per-handler timeout.                 |
| `handler_threw`                   | Handler threw or returned a rejected promise.                          |
| `manifest_invalid`                | Manifest failed `PluginManifestSchema` validation.                     |
| `engine_version_mismatch`         | Current engine version is outside `manifest.engine.dreamgraph` range.  |

## Helpers

```ts
import { rejectSeamOf, isPluginRejectReason } from "@dreamgraph/sdk";

rejectSeamOf("tool_name_unprefixed");      // "tools"
isPluginRejectReason("nope");              // false
```
