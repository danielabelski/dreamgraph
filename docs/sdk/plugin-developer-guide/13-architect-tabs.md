# 13. Architect tabs

[<- Best practices](12-best-practices.md) · [Reference: Architect tabs](../plugin-reference/10-architect-tabs.md)

Trusted plugins can contribute first-class tabs to the daemon-served standalone Architect surface through `ctx.architect`. The browser boundary is declarative: plugin handlers run in the host process, while browser clients receive validated descriptors and JSON snapshots rendered by host-supported renderer kinds.

The initial renderer is `checklist`. Arbitrary browser JavaScript, HTML, remote scripts, inline scripts, iframes, and direct DOM callbacks are not supported.

## 13.1 Manifest declaration

Declare every tab statically in `plugin.json`:

```json
{
  "capabilities": [
    "architect:register_tab",
    "architect:read_plan",
    "architect:write_plan_state",
    "architect:register_sidebar_summary"
  ],
  "expectedEffects": [
    "render_architect_tab",
    "read_architect_plan_projection",
    "write_architect_plan_state",
    "render_architect_sidebar_summary"
  ],
  "architectTabs": [
    {
      "id": "examples.action-checklist.checklist",
      "renderer": "checklist",
      "planConnectivity": "required"
    }
  ]
}
```

Tab ids MUST start with `<plugin-id>.`. Runtime registration MUST match the manifest declaration.

## 13.2 Registering a tab

Use `defineArchitectTab()` from `@dreamgraph/sdk`, then register the result with `ctx.architect.tabs.register()`. The returned callback unregisters the contribution early; normal disable, unload, and reload paths remove active contributions automatically.

Plan state is daemon-owned and namespaced by instance, plugin id, plan id, tab type id, and key. Read and write it through `ctx.architect.planState`. Writes use revision tokens so stale browser actions fail instead of overwriting newer state.

```js
const stored = await ctx.architect.planState.read("checklist", context);
const next = await ctx.architect.planState.write("checklist", value, {
  ...context,
  revision: stored?.revision ?? null,
});
```

Plan-bound operations require an explicit `planId`. A project-scope view does not silently bind to a selected or first plan.

## 13.3 Browser routes

Standalone Architect clients use versioned daemon routes under `/api/architect/v1/plugin-tabs` to list descriptors, fetch plan snapshots, and dispatch structured actions. Sidebar summaries and badges are projections from the same daemon snapshot. Store paths and plugin modules are never exposed to the browser.

## 13.4 Walkthrough

See [`examples/action-checklist`](../../../examples/action-checklist/) for a complete reference plugin. It seeds Slice A-E checklist state on first load, toggles items through schema-validated actions, projects checklist progress and badges, persists state across reload, and unloads cleanly.

`ctx.ui.register()` remains a separate semantic metadata seam. It does not execute plugin browser code and does not register standalone Architect tabs.

[<- Best practices](12-best-practices.md) · [Reference: Architect tabs](../plugin-reference/10-architect-tabs.md)
