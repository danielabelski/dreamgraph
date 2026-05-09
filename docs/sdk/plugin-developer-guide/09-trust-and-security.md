# 9. Trust and security model

[← Closure seams](08-seams-closure.md) · [Next: Lifecycle →](10-lifecycle-and-installation.md)

DreamGraph v1 ships the **trusted in-process plugin model**. This section is
required reading before you publish or install a plugin.

## 9.1 The execution boundary

Plugins run **inside the daemon's Node process**. They share its heap, its file
descriptors, and its operating-system permissions. The host:

- Enforces the manifest schema and capability gates at the API boundary;
- Mediates every host-owned effect (tool registration, resource registration,
  UI/policy/archetype/fence writes, event emission);
- Refuses to load anything not under `<instance>/plugins/` or
  `instance.json:plugins[]`;
- Refuses to load anything unless `DG_ALLOW_INPROCESS_PLUGINS=true` AND the
  plugin is explicitly `trusted: true`.

The host **cannot** prevent malicious plugin code from reaching `process`,
`fs`, `child_process`, or any other Node global. Reaching around `ctx` is a
trust violation and grounds for quarantine, not a sandbox escape.

> **Mental model:** installing a DreamGraph plugin is closer to editing your
> `~/.bashrc` than to installing a browser extension. Only install plugins from
> sources you trust as much as you trust the daemon itself.

## 9.2 The two safety switches

| Switch                          | Where                                  | Default | Purpose                                                |
| ------------------------------- | -------------------------------------- | ------- | ------------------------------------------------------ |
| `DG_ALLOW_INPROCESS_PLUGINS`    | engine.env / process env               | `false` | Operator-wide kill switch. While off, no plugin loads. |
| `instance.json:plugins[].trusted` | per-plugin entry in `instance.json`   | `false` | Per-plugin opt-in. Set with `dg plugin trust <id>`.   |

Loading occurs **only** when both are true. The host emits
`in_process_execution_disabled` and refuses the plugin otherwise.

## 9.3 The trust banner

Every successful in-process load prints exactly one line to the daemon log:

```
plugin <id>@<ver> loaded with FULL HOST TRUST (in-process)
```

If you do not see this line for your plugin, it did not load. Check the log
for the matching `plugin.errored` or capability-rejection event.

## 9.4 The event-loop watchdog

A `setImmediate` heartbeat samples Node event-loop lag. If the lag exceeds
`DG_EVENT_LOOP_LAG_MS` (default 250 ms) while a plugin handler is on the call
stack, the host:

1. Marks the handler `event_loop_stall`;
2. Waits for the event loop to become responsive;
3. Quarantines the plugin and emits `plugin.errored{ reason: "event_loop_stall" }`
   with the measured lag.

This is detection, not preemption — the watchdog cannot interrupt synchronous
CPU-bound code. It exists to make stalls visible *after* they happen so
operators can disable the offending plugin.

## 9.5 What "quarantine" means

A quarantined plugin:

- Has all its registrations pruned (tools, resources, UI, policies, archetypes,
  fences).
- Stops receiving subscribed events.
- Remains visible in `system://plugins` with `status: "quarantined"` and the
  reason code.
- Cannot be reloaded until the operator runs `dg plugin enable <id>` (which
  re-trusts and re-attempts activation).

## 9.6 Coming in M8

Worker-thread isolation is planned for M8. Plugins declaring `runtime: "worker"`
will be loaded into a `worker_threads.Worker`; the `PluginContext` is marshalled
across `MessagePort`. Worker threads improve fault and event-loop isolation but
are not, by themselves, a complete sandbox for untrusted marketplace code. The
trusted in-process model is the only published contract until M8 ships.

[← Closure seams](08-seams-closure.md) · [Next: Lifecycle →](10-lifecycle-and-installation.md)
