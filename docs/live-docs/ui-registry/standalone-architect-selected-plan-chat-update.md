# Standalone Architect Selected Plan Chat Update

> Allows chat text entered while a plan is selected to become a governed plan markdown update when the active execution route cannot produce a model-backed edit.

**ID:** `standalone_architect_selected_plan_chat_update`  
**Category:** composite  
**Status:** active  

## Data Contract

### Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| message | `string` | ✅ | POST body chat text that appears to be a selected-plan addition or change request. |
| planId | `string` | ✅ | Selected Architect plan id loaded from the left plan rail. |
| runtime | `ActiveArchitectSessionRuntime` | ✅ | Daemon-owned runtime metadata attached to the chat request and audit entry. |

### Outputs

| Name | Type | Trigger | Description |
|------|------|---------|-------------|
| plan_update | `object` | on_chat_submit | Result metadata for selected plan markdown mutation, implementation-log audit, and UI refresh. |

## Interactions

- **submit_plan_update** — User submits plan-like chat text while a plan is selected; daemon writes the plan artifact and audit log if the model route is metadata-only or unavailable.
- **refresh_selected_plan** — Browser reloads the selected plan detail after a successful plan_update result.

## Visual Semantics

- **Role:** chat-mediated plan editor
- **Emphasis:** primary
- **Density:** compact
- **Chrome:** embedded

## Layout Semantics

- **Pattern:** split_view
- **Alignment:** leading
- **Sizing behavior:** fill_parent
- **Responsive behavior:** collapse, scroll

### Layout Hierarchy

- **plan rail** — secondary
- **chat panel** — primary
- **plan detail** — auxiliary

**Tags:** standalone-architect, plan-editing, chat, daemon-governed, implementation-log, metadata-fallback
