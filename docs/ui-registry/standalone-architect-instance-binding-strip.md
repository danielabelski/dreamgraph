# Standalone Architect Instance Binding Strip

> Shows the daemon instance UUID, instance home, config directory, engine.env path, runtime directory, and binding status below the Architect chat so operators can verify the browser is attached to the intended local daemon instance.

**ID:** `standalone_architect_instance_binding_strip`  
**Category:** data_display  
**Status:** active  

## Data Contract

### Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| project_scope | `object` | ✅ | Runtime metadata from buildProjectScopePayload including instance_id, home_dir, config_dir, engine_env_path, runtime_dir, and binding_status. |

### Outputs

| Name | Type | Trigger | Description |
|------|------|---------|-------------|
| binding_text | `string` | render | Selectable text containing instance and engine.env binding details. |

## Interactions

- **inspect_binding** — Read/copy the daemon instance UUID and config paths for verification.

## Visual Semantics

- **Role:** status_text
- **Emphasis:** muted
- **Density:** compact
- **Chrome:** minimal

### State Styling

- **unbound** — warning text color

## Layout Semantics

- **Pattern:** stack
- **Alignment:** leading
- **Sizing behavior:** fluid
- **Responsive behavior:** wrap

### Layout Hierarchy

- **chat_panel_footer** — auxiliary

## Platform Implementations

| Platform | Component | Source File | Notes |
|----------|-----------|-------------|-------|
| html | `p#instance-binding.instance-binding` | src/architect/routes.ts | Rendered from initialRuntimePayload immediately and refreshed from API/chat payloads. |

**Used by features:** standalone-architect-instance-config-binding

**Tags:** standalone-architect, instance-binding, engine-env, runtime-metadata
