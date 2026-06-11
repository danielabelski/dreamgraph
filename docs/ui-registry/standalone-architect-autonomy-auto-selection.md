# Standalone Architect Autonomy Auto Selection State

> Mark the selected continuation option as running while the next bounded pass request is being submitted.

**ID:** `standalone_architect_autonomy_auto_selection`  
**Category:** feedback  
**Status:** active  

## Data Contract

### Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| selected_action_id | `string` | ✅ | Stable id of the selected continuation action. |
| continuation.status | `continue|wait|stopped` | ✅ | Continuation decision status that explains whether a next pass may run. |

### Outputs

| Name | Type | Trigger | Description |
|------|------|---------|-------------|
| running_visual_state | `DOM button state` | continuation pill dispatch | Running state on the selected continuation pill. |

## Interactions

- **state_change** — Adds a running state to the selected continuation pill before dispatching the follow-up pass.

## Visual Semantics

- **Role:** selected continuation feedback
- **Emphasis:** success
- **Density:** compact
- **Chrome:** minimal

## Layout Semantics

- **Pattern:** flow
- **Alignment:** leading
- **Sizing behavior:** content_sized

## Platform Implementations

| Platform | Component | Source File | Notes |
|----------|-----------|-------------|-------|
| standalone-web | `renderArchitectContinuationPills` | src/architect/routes.ts | - |

**Used by features:** architect-continuation

**Tags:** architect, continuation, autonomy, slice-4
