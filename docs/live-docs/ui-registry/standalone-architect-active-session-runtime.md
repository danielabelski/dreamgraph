# Standalone Architect Active Session Runtime

> Expose the daemon-owned Architect runtime identity so selectors, top-bar status, chat context, trace rows, and provenance share one model/provider/adapter source of truth.

**ID:** `standalone_architect_active_session_runtime`  
**Category:** data_display  
**Status:** active  

## Data Contract

### Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| runtime | `object` | ✅ | Active daemon-owned runtime containing adapter, provider, model, autonomy_mode, pass_state, execution_route, and session_id. |
| selector_changes | `object` | ❌ | Provider, adapter, model, and autonomy changes submitted through POST /api/architect/v1/config. |

### Outputs

| Name | Type | Trigger | Description |
|------|------|---------|-------------|
| runtime_status | `object` | config_change | Updated runtime object returned in daemon payloads and rendered in the top status area. |
| runtime_provenance | `object` | chat_response | Runtime metadata attached to chat route, provenance, and tool trace payloads. |

## Interactions

- **inspect_runtime** — Users and the assistant can inspect the current adapter/provider/model/autonomy/session metadata.
- **mutate_runtime** — Selector changes mutate the daemon-owned runtime through the config endpoint and persist to engine.env.

## Visual Semantics

- **Role:** runtime status strip
- **Emphasis:** secondary
- **Density:** compact
- **Chrome:** minimal

### State Styling

- **configured** — Shows selected runtime identity without changing layout height.
- **running** — Shows pass state and execution route while preserving selector state.

## Layout Semantics

- **Pattern:** toolbar
- **Alignment:** leading
- **Sizing behavior:** fluid
- **Responsive behavior:** wrap

**Used by features:** standalone-architect

**Tags:** standalone-architect, runtime, model-governance, provenance, session-state
