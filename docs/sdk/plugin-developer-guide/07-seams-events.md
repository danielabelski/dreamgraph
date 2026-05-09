# 7. Seams: events

[← Tools & Resources](06-seams-tools-resources.md) · [Next: Closure seams →](08-seams-closure.md)

Events are the cognitive heartbeat. The SDK exposes two operations: subscribe to
host-emitted events, and emit your own.

## 7.1 Subscribe — `ctx.events.subscribe`

```js
const off = ctx.events.subscribe("snapshot.changed", (evt) => {
  ctx.logger.info(`observed ${evt.kind}`, evt.payload);
});
```

### Stable vs experimental

| Set            | Capability                  | Import from                                 |
| -------------- | --------------------------- | ------------------------------------------- |
| Stable kinds   | `events:read`               | `@dreamgraph/sdk`                           |
| Experimental   | `events:read:experimental`  | `@dreamgraph/sdk/events/experimental`       |

The split is **type-enforced** in the SDK: the default `defineEventHandler`
factory is generic over `StableEventKind`. To subscribe to an experimental kind
you must use `defineExperimentalEventHandler` and the host must have
`experimental_plugins: true` in `instance.json`. Subscribing to an experimental
kind without the capability returns `event_kind_experimental`; subscribing to a
kind not declared in the manifest returns `event_kind_not_declared`.

### Bus model

The DreamGraph event bus is **synchronous**: the producer call site does not
await your handler. The host wraps your handler in a deferred queue so a slow
subscriber cannot stall cognition. Therefore:

- Your handler MAY be async; the queue runner awaits it.
- Your handler MUST tolerate handler-level timeouts (default 5 s). A timeout
  emits `handler_timeout` and quarantines the plugin.
- Your handler runs in the daemon's heap. Long synchronous CPU work will be
  detected by the event-loop watchdog (`event_loop_stall`, see §9).

## 7.2 Emit — `ctx.events.emit`

```js
ctx.events.emit("examples.hello-events.activated", {
  at: new Date().toISOString(),
});
```

### Rules

- The kind name MUST NOT collide with a built-in `GraphEventKind`. Conventional
  practice is `<plugin-id>.<event_name>` (matches the tool/resource pattern).
- Emitting a kind requires the `events:emit` capability **and** `emit_event` in
  `expectedEffects`. Missing either → `effect_undeclared` or
  `emit_capability_missing`.
- The payload is JSON-serialized and broadcast on the bus + SSE stream
  (`/explorer/api/events`) + matching webhook subscriptions.

### Replay window

The SSE stream maintains a 500-event ring buffer; the file-backed
`event_log.json` is the long-term record. Plugins should treat the bus as
**at-most-once**: if your subscriber missed an event because your plugin was
disabled or the daemon restarted, the SSE replay window does not extend back
indefinitely. Critical state must be reconstructed from a resource read or by
reading the event log.

[← Tools & Resources](06-seams-tools-resources.md) · [Next: Closure seams →](08-seams-closure.md)
