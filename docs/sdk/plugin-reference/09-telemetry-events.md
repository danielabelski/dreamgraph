# Telemetry events (normative)

[<- Index](00-index.md) · Source: [packages/sdk/src/telemetry.ts](../../../packages/sdk/src/telemetry.ts)

The host emits a stable `plugin.*` stream. Every payload includes `plugin_id`, `plugin_version`, and ISO-8601 `occurred_at`.

## Event kinds

| Kind | Purpose |
| --- | --- |
| `plugin.loaded` | Successful activation, runtime, trust state, and capabilities. |
| `plugin.unloaded` | Shutdown, disable, reload, or quarantine cleanup. |
| `plugin.errored` | Host boundary or handler failure. |
| `plugin.handler.started` | Timed handler invocation start. |
| `plugin.handler.completed` | Timed handler invocation completion with `ok`. |
| `plugin.output.accepted` | Host accepted a mediated effect. |
| `plugin.output.rejected` | Host refused a mediated effect or registration. |

## Handler seams

`plugin.handler.started` and `plugin.handler.completed` use:

```ts
type PluginHandlerSeam =
  | "tool"
  | "resource"
  | "event"
  | "schedule_action"
  | "architect_tab"
  | "architect_plan_state";
```

Both carry `correlation_id`, `seam`, and `target`. Completion also carries `duration_ms` and `ok`.

## Accepted output seams

```ts
type PluginAcceptedOutputSeam =
  | "tool"
  | "resource"
  | "event"
  | "schedule_action"
  | "webhook"
  | "ui"
  | "archetype"
  | "policy"
  | "markdown_fence"
  | "architect_tab"
  | "architect_plan_state";
```

Accepted output carries `correlation_id`, `effect`, `seam`, and optional `target`.

## Rejected output seams

Rejected output supports the accepted output seams plus `host`. It carries `reason: PluginRejectReason`, optional `correlation_id`, optional `target`, and optional human-readable `detail`.

Architect tab registration, plan-state access, snapshot loading, and action dispatch therefore use the normal host-owned telemetry stream. They do not create a browser-only audit channel.

## Stability

The seven event kinds above are stable SDK contracts. Payloads may grow additively within a major SDK version.
