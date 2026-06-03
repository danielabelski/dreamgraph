# Standalone Architect Model Route Selector

> Lets the operator choose the standalone Architect adapter, API provider, and model while keeping the daemon runtime route and per-instance engine.env configuration synchronized.

**ID:** `standalone_architect_model_route_selector`  
**Category:** data_input  
**Status:** active  

## Data Contract

### Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| adapter | `ArchitectAdapterType` | ✅ | Selected execution adapter such as native_api_tool_loop, codex-cli, copilot-cli, or deterministic_fallback. |
| provider | `LlmProviderType` | ✅ | Selected native API provider when the adapter is native_api_tool_loop; non-native adapters persist provider as none. |
| model | `string` | ✅ | Selected model name for the active Architect route. |

### Outputs

| Name | Type | Trigger | Description |
|------|------|---------|-------------|
| architect_config_update | `POST /api/architect/v1/config` | on_change | Persists the selected route to engine.env when an active instance scope exposes an engine_env_path and refreshes the daemon runtime payload. |

## Interactions

- **select_adapter** — Switches between native API tool loop, CLI adapters, and deterministic fallback.
- **select_provider** — Changes the native API provider and repopulates the model menu.
- **select_model** — Changes the model and persists the route selection through the daemon.

## Visual Semantics

- **Role:** control_group
- **Emphasis:** secondary
- **Density:** compact
- **Chrome:** embedded

### State Styling

- **saved** — status text confirms engine.env persistence when available
- **in_memory_only** — status text reports that no active engine.env path was available

## Layout Semantics

- **Pattern:** toolbar
- **Alignment:** leading
- **Sizing behavior:** content_sized
- **Responsive behavior:** wrap

### Layout Hierarchy

- **runtime-controls** — primary
- **runtime-strip** — secondary

## Platform Implementations

| Platform | Component | Source File | Notes |
|----------|-----------|-------------|-------|
| html | `select#architect-adapter-select + select#architect-provider-select + select#architect-model-input` | src/architect/routes.ts | Browser controls POST route changes to daemon-owned /api/architect/v1/config instead of relying on localStorage as runtime authority. |

**Used by features:** standalone-architect

**Tags:** standalone-architect, model-routing, engine-env, provider-selector, adapter-selector
