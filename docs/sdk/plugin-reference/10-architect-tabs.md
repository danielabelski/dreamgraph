# Architect tabs (normative)

[<- Index](00-index.md) · Sources: [packages/sdk/src/seams/architect.ts](../../../packages/sdk/src/seams/architect.ts), [packages/host/src/context.ts](../../../packages/host/src/context.ts)

Architect tabs are trusted host-side plugin contributions projected into the daemon-served standalone Architect browser surface. Browser clients MUST receive declarative descriptors and JSON snapshots only. They MUST NOT load plugin modules or receive raw state-store paths.

## Manifest declaration

```ts
interface PluginManifestArchitectTab {
  id: string; // MUST start with <plugin-id>.
  renderer: "checklist";
  planConnectivity: "required" | "optional" | "none";
}
```

A manifest with any `architectTabs` entry MUST declare `architect:register_tab`, `architect:read_plan`, `render_architect_tab`, and `read_architect_plan_projection`. Runtime registration MUST match a manifest declaration.

## Context API

```ts
interface PluginArchitectSurface {
  tabs: { register(definition: ArchitectTabTypeDefinition): () => void };
  planState: {
    read<T>(key: string, context: ArchitectPlanContext): Promise<ArchitectStoredState<T> | null>;
    write<T>(key: string, value: T, context: ArchitectPlanWriteContext): Promise<ArchitectStoredState<T>>;
  };
}
```

`planState` is daemon-owned and namespaced by instance, plugin id, plan id, tab type id, and key. Writes MUST include the expected revision or `null` for initial creation. Stale revisions are rejected.

## Tab definition

```ts
interface ArchitectTabTypeDefinition<TState = unknown, TAction = unknown> {
  id: string;
  title: string;
  icon?: string;
  renderer: "checklist";
  planConnectivity: "required" | "optional" | "none";
  stateSchema: Record<string, unknown>;
  actions: readonly { id: string; inputSchema: Record<string, unknown> }[];
  sidebarSummary?: { kind: "checklist-progress" };
  badges?: readonly { id: string; kind: "count" | "status" }[];
  loadState(context: ArchitectPlanContext): Promise<TState> | TState;
  handleAction?(action: TAction, context: ArchitectPlanActionContext): Promise<TState> | TState;
}
```

## Capabilities and effects

| Capability | Purpose |
| --- | --- |
| `architect:register_tab` | Register a manifest-declared Architect tab type. |
| `architect:read_plan` | Read explicit plan-bound state and projection context. |
| `architect:write_plan_state` | Persist daemon-owned namespaced plan state. |
| `architect:register_sidebar_summary` | Project a sidebar summary from the tab snapshot. |

| Effect | Purpose |
| --- | --- |
| `render_architect_tab` | Project a host-rendered Architect tab. |
| `read_architect_plan_projection` | Load explicit plan-bound snapshot state. |
| `write_architect_plan_state` | Persist namespaced plan state. |
| `render_architect_sidebar_summary` | Project sidebar summary and badge data. |

## Lifecycle and telemetry

Unload, disable, and reload remove active descriptors and handlers while retaining persisted plan state. Registration and invocation use the normal `plugin.output.accepted`, `plugin.output.rejected`, `plugin.handler.started`, and `plugin.handler.completed` telemetry contracts with `architect_tab` or `architect_plan_state` seams.

## Browser contract

Versioned routes live under `/api/architect/v1/plugin-tabs`. Actions are structured daemon commands. The daemon validates plugin availability, explicit plan scope, action schema, and revision before returning a new snapshot.

`ctx.ui.register()` is metadata-only and is not an executable browser UI escape hatch.
