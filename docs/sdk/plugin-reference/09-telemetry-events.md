# Telemetry events (normative)

[← Index](00-index.md) · Source: [packages/host/src/telemetry-emitter.ts](../../../packages/host/src/telemetry-emitter.ts)

The host emits a uniform `plugin.*` stream on the cognitive event bus. Every
event carries a common base envelope plus per-kind extras.

## Common base

```ts
interface PluginTelemetryBase {
  plugin_id:      string;
  plugin_version: string;
  ts:             string;            // ISO-8601
  correlation_id?: string;           // matches handler.started/completed
  seam?:          "tools" | "resources" | "events" | "ui"
                 | "policy" | "archetypes" | "markdown_fences" | "host";
}
```

## Per kind

### `plugin.loaded`

Emitted after manifest acceptance and successful `activate(ctx)`.

```ts
interface PluginLoadedPayload extends PluginTelemetryBase {
  runtime:           "in-process";   // "worker" reserved for M8
  declared_effects:  PluginEffect[];
  declared_capabilities: PluginCapability[];
}
```

### `plugin.unloaded`

Emitted on graceful disable / shutdown.

```ts
interface PluginUnloadedPayload extends PluginTelemetryBase {
  reason: "disable" | "shutdown" | "reload";
}
```

### `plugin.errored`

Emitted on manifest rejection, unhandled throw, watchdog stall, or any
quarantine path.

```ts
interface PluginErroredPayload extends PluginTelemetryBase {
  reason:  PluginRejectReason;       // see reference §4
  message: string;                   // human-readable
  stack?:  string;
  measured_lag_ms?: number;          // present iff reason === "event_loop_stall"
}
```

### `plugin.handler.started`

Emitted just before a tool handler / resource handler / event subscriber runs.

```ts
interface PluginHandlerStartedPayload extends PluginTelemetryBase {
  correlation_id: string;
  surface:        "tool" | "resource" | "event_handler";
  surface_id:     string;            // tool name / uri / event kind
}
```

### `plugin.handler.completed`

Emitted on handler success.

```ts
interface PluginHandlerCompletedPayload extends PluginTelemetryBase {
  correlation_id: string;
  surface:        "tool" | "resource" | "event_handler";
  surface_id:     string;
  duration_ms:    number;
}
```

### `plugin.output.accepted`

Emitted when the host successfully forwarded / wrote / dispatched the plugin's
output.

```ts
interface PluginOutputAcceptedPayload extends PluginTelemetryBase {
  surface:        "tool" | "resource" | "event_emit"
                | "ui_register" | "policy_propose"
                | "archetype_register" | "markdown_fence_register";
  surface_id:     string;
  effect:         PluginEffect;
}
```

### `plugin.output.rejected`

Emitted when the host refused output (capability missing, effect undeclared,
forbidden, schema invalid, namespace violation, quota exceeded, etc.).

```ts
interface PluginOutputRejectedPayload extends PluginTelemetryBase {
  surface:        "tool" | "resource" | "event_emit"
                | "ui_register" | "policy_propose"
                | "archetype_register" | "markdown_fence_register";
  surface_id:     string;
  reason:         PluginRejectReason;
  message:        string;
  attempted_effect?: PluginEffect;
}
```

## Stability

`plugin.loaded`, `plugin.unloaded`, `plugin.errored`, `plugin.handler.*`,
`plugin.output.accepted`, and `plugin.output.rejected` are part of the **stable**
event surface for v1. Their payload shapes will only grow additively within a
major SDK version.
