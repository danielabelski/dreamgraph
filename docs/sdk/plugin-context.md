# Plugin Context

`PluginContext` is the shipped trusted in-process runtime surface handed to loaded plugins. It is an API boundary, not a sandbox.

## Allow surface

The host exposes namespaced identity, logging, events, tools, resources, semantic UI metadata, discipline proposals, archetype providers, markdown fences, declarative Architect tabs, daemon-owned Architect plan state, and an unload-aware `AbortSignal`.

Architect plugins use:

```ts
ctx.architect.tabs.register(definition);
await ctx.architect.planState.read(key, context);
await ctx.architect.planState.write(key, value, { ...context, revision });
```

Architect state is namespaced by instance, plugin id, plan id, tab type id, and key. Plan-bound operations require an explicit `planId`; project scope does not silently bind to a selected or first plan. Browser clients receive validated snapshots through `/api/architect/v1/plugin-tabs`, never raw store paths or plugin modules.

## Deny list

`PluginContext` deliberately does not expose raw filesystem paths, internal graph writers, tension or graph mutation, arbitrary network primitives, process helpers, browser DOM access, plugin browser JavaScript, iframes, or browser-local authoritative state.

Trusted plugin code runs in the daemon process and can reach Node globals if it deliberately bypasses `ctx`. Doing so is a trust violation and grounds for quarantine, not a sandbox escape. Supported workflows must stay on host-mediated seams so capability checks, effect checks, telemetry, lifecycle cleanup, and persistence rules remain enforceable.

See the [PluginContext API reference](plugin-reference/05-context-api.md) and [Architect tabs guide](plugin-developer-guide/13-architect-tabs.md).
