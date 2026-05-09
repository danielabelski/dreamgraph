# 5. The PluginContext

[← Manifest](04-manifest-and-capabilities.md) · [Next: Tools & Resources →](06-seams-tools-resources.md)

`ctx` is the single object the host hands you. Its shape is fixed — see
[reference / context-api](../plugin-reference/05-context-api.md) for the strict
TypeScript signatures.

## 5.1 The allow surface

```ts
interface PluginContext {
  readonly plugin:   { id: string; version: string };
  readonly instance: { uuid: string };
  readonly logger:   PluginLogger;       // namespaced, mirrored to event bus
  readonly events:   { subscribe; emit };
  readonly tools:          { register };
  readonly resources:      { register };
  readonly ui:             { register };
  readonly policies:       { propose };
  readonly archetypes:     { registerProvider };
  readonly markdownFences: { register };
  readonly signal: AbortSignal;          // aborted on disable / timeout
}
```

Every register / propose / subscribe call returns an `unregister`/`unsubscribe`
function. **You do not need to call it on shutdown** — the host prunes all
contributions automatically when the plugin is disabled or the instance shuts
down. Use the returned functions only when you want a contribution to disappear
*before* deactivation (rare).

## 5.2 The deny list

`ctx` deliberately does **not** expose:

- Raw `fs`, `process`, `require`, dynamic `import()`.
- Any filesystem path (no `dataDir`, no instance root).
- Internal-tier writers (`dream_graph.json`, `validated_edges.json`,
  `tension_log.json`, `event_log.json`).
- Tension mutation (`ctx.tensions.create`, `.resolve`).
- Graph mutation (`ctx.graph.promoteCandidate`, `.editEdge`).
- Other plugins' loggers, configs, or quotas.
- `setInterval` / `setTimeout` helpers — long-running or recurring work must use
  schedule actions (post-M4).
- Network primitives — outbound HTTP goes through the (operator-owned) webhook
  worker, not through `ctx`.

This is an **API boundary**, not a runtime sandbox. M3 plugins run in the
daemon's process and *can* reach Node globals if they want to. Doing so is a
trust violation and grounds for quarantine, not a sandbox escape. See §9 for
the full trust narrative.

## 5.3 The `signal`

`ctx.signal` is an `AbortSignal` the host aborts when:

- the plugin is disabled (`dg plugin disable`),
- the instance shuts down,
- a handler exceeds the timeout budget,
- the plugin is quarantined for any other reason.

Pass it to long-running work that supports cancellation (`fetch(url, { signal })`,
your own loops). You are not required to use it, but ignoring it means your
plugin can keep running for a few extra seconds during shutdown.

## 5.4 Logging

`ctx.logger` is namespaced under `plugin:<id>`. Lines appear in the daemon's log
stream and are mirrored to the event bus as standard log events. Do **not** use
`console.log`/`console.error` — those bypass the bus and the operator may not
see them.

[← Manifest](04-manifest-and-capabilities.md) · [Next: Tools & Resources →](06-seams-tools-resources.md)
