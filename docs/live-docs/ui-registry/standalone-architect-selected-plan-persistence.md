# Standalone Architect Selected Plan Persistence

> Restores the last selected standalone Architect plan after daemon or browser restart by persisting selection through a daemon-owned endpoint into engine.env.

**ID:** `standalone_architect_selected_plan_persistence`  
**Category:** navigation  
**Status:** active  

## Data Contract

### Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| selected_plan_id | `string` | ✅ | Safe Architect plan id selected in the browser plan rail. |

### Outputs

| Name | Type | Trigger | Description |
|------|------|---------|-------------|
| engine_env_update | `DREAMGRAPH_ARCHITECT_SELECTED_PLAN_ID` | plan selection changes | Persisted selected plan id written into the active instance engine.env. |

## Interactions

- **select_plan** — Browser loads the selected plan and asks the daemon to persist the selected plan id.
- **restore_selection** — Plan index response exposes the persisted selected plan id so the browser can load it on restart.

## Visual Semantics

- **Role:** plan navigation state
- **Density:** compact
- **Chrome:** embedded

## Layout Semantics

- **Pattern:** split_view
- **Sizing behavior:** fill_parent

### Layout Hierarchy

- **plan rail** — secondary
- **plan detail** — primary

## Platform Implementations

| Platform | Component | Source File | Notes |
|----------|-----------|-------------|-------|
| html | `Standalone Architect plan rail` | src/architect/routes.ts | Uses POST /api/architect/v1/selection and DREAMGRAPH_ARCHITECT_SELECTED_PLAN_ID. |

**Used by features:** standalone-architect

**Tags:** standalone-architect, engine-env, plan-selection, restart-restore
