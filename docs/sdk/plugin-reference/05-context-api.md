# PluginContext API (normative)

[← Index](00-index.md) · Source: [packages/host/src/context.ts](../../../packages/host/src/context.ts)

## Top-level

```ts
interface PluginContext {
  readonly plugin:         { id: string; version: string };
  readonly instance:       { uuid: string };
  readonly logger:         PluginLogger;
  readonly events:         PluginEventEmitSurface;
  readonly tools:          PluginToolsSurface;
  readonly resources:      PluginResourcesSurface;
  readonly ui:             PluginUiSurface;
  readonly policies:       PluginPoliciesSurface;
  readonly archetypes:     PluginArchetypesSurface;
  readonly markdownFences: PluginMarkdownFencesSurface;
  readonly architect:      PluginArchitectSurface;
  readonly signal:         AbortSignal;
}
```

## Surfaces

```ts
interface PluginLogger {
  debug(message: string, meta?: object): void;
  info(message: string, meta?: object): void;
  warn(message: string, meta?: object): void;
  error(message: string, meta?: object): void;
}

interface PluginEventEnvelope {
  readonly kind:    string;
  readonly payload: unknown;
}
type PluginEventHandler = (e: PluginEventEnvelope) => void | Promise<void>;

interface PluginEventEmitSurface {
  emit(kind: string, payload: unknown): void;
  subscribe(kind: string, handler: PluginEventHandler): () => void;
}

interface PluginToolsSurface          { register(d: ToolDefinition):              () => void; }
interface PluginResourcesSurface      { register(d: ResourceDefinition):          () => void; }
interface PluginUiSurface             { register(d: UiElementDefinition):         () => void; }
interface PluginPoliciesSurface       { propose (p: PolicyProposal):              () => void; }
interface PluginArchetypesSurface     { registerProvider(d: ArchetypeProviderDefinition): () => void; }
interface PluginMarkdownFencesSurface { register(d: MarkdownFenceDefinition):     () => void; }
interface PluginArchitectSurface {
  tabs: { register(d: ArchitectTabTypeDefinition): () => void };
  planState: {
    read<T>(key: string, context: ArchitectPlanContext): Promise<ArchitectStoredState<T> | null>;
    write<T>(key: string, value: T, context: ArchitectPlanWriteContext): Promise<ArchitectStoredState<T>>;
  };
}
```

The complete Architect tab definition, lifecycle, route, capability, and effect contract is in [Architect tabs](10-architect-tabs.md).

## Seam definition shapes

### `ToolDefinition`

```ts
interface ToolDefinition<Input = unknown, Output = unknown> {
  name:             string;          // <plugin-id>.<tool>
  description:      string;
  inputSchema:      JsonSchema;      // converted to Zod by host
  expectedEffects:  PluginEffect[];  // must include "emit_tool"
  forbiddenEffects?: PluginEffect[];
  handler: (input: Input, ctx: { pluginId: string; signal?: AbortSignal })
    => Output | Promise<Output>;
}
```

### `ResourceDefinition`

```ts
interface ResourceDefinition<Params = Record<string, unknown>, Output = unknown> {
  uriNamespace:     string;          // plugin://<plugin-id>/...
  name:             string;
  description?:     string;
  outputSchema?:    JsonSchema;
  expectedEffects:  PluginEffect[];  // must include "emit_resource"
  forbiddenEffects?: PluginEffect[];
  handler: (req: { uri: string; params?: Params },
            ctx: { pluginId: string; signal?: AbortSignal })
    => Output | Promise<Output>;
}
```

### `UiElementDefinition`

```ts
type UiElementCategory =
  | "data_display" | "data_input" | "navigation"
  | "feedback"     | "layout"     | "action" | "composite";

interface UiElementDefinition {
  id:           string;              // starts with <plugin-id>.
  name:         string;
  purpose:      string;
  category:     UiElementCategory;
  inputs:       UiElementInput[];
  outputs:      UiElementOutput[];
  interactions: UiElementInteraction[];
  children?:    string[];
  implementations?: UiElementImplementation[];
  used_by?:     string[];
  tags?:        string[];
  expectedEffects?: PluginEffect[];  // typically ["mutate_ui_registry"]
}
```

### `PolicyProposal`

```ts
interface PolicyProposal {
  id:         string;
  title:      string;
  rationale:  string;
  applies_to: string[];
  phases:     PhasePermission[];
  severity:   "block" | "warn" | "info";
  weakens?:   false;     // MUST be false; reserved
}
```

### `ArchetypeProviderDefinition`

```ts
interface ArchetypeRecord {
  id:       string;
  name:     string;
  summary:  string;
  tags?:    string[];
  payload?: unknown;
}

interface ArchetypePayload {
  source:     string;
  version:    string;
  archetypes: ArchetypeRecord[];
}

interface ArchetypeProviderDefinition {
  id:       string;
  name:     string;
  url?:     string;            // reserved for remote polling
  poll_interval_s?: number;
  inline?:  ArchetypePayload;
  fetch?:   () => Promise<ArchetypePayload>;
}
```

### `MarkdownFenceDefinition`

```ts
interface MarkdownFenceDefinition {
  language:    string;         // /^[a-z0-9][a-z0-9._-]*$/
  label:       string;
  description: string;
  platforms?:  Array<"webview" | "cli" | "web">;
}
```

## Identity helpers

The SDK ships these zero-cost factories purely for IDE inference:

```ts
import {
  defineTool, defineResource, defineUiElement,
  definePolicyProposal, defineArchetypeProvider, defineMarkdownFence,
  definePlugin,
} from "@dreamgraph/sdk";
```

Each `define*` simply returns its argument with the matching type.
