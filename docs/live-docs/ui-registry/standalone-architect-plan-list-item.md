# Standalone Architect Plan List Item

> Let users select a standalone Architect plan from the left rail using a compact content-sized card that exposes the plan title and supporting metadata without clipping.

**ID:** `standalone_architect_plan_list_item`  
**Category:** navigation  
**Status:** active  

## Data Contract

### Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| plan | `object` | ✅ | Plan summary with id, title, active phase, slice count, checkpoint count, current slice, and task-memory binding status. |

### Outputs

| Name | Type | Trigger | Description |
|------|------|---------|-------------|
| selectedPlanId | `string` | on_click | The selected plan id passed to the standalone Architect plan loader. |

## Interactions

- **select** — Clicking anywhere on the expanded card loads the plan and marks the item active.

## Visual Semantics

- **Role:** card
- **Emphasis:** secondary
- **Density:** compact
- **Chrome:** embedded

### State Styling

- **hover** — Adjust border and background without changing card dimensions.
- **active** — Use selected border/background without changing card dimensions.

## Layout Semantics

- **Pattern:** stack
- **Alignment:** leading
- **Sizing behavior:** content_sized
- **Responsive behavior:** wrap, scroll

### Layout Hierarchy

- **title** — primary
- **metadata** — secondary

**Used by features:** standalone-architect

**Tags:** standalone-architect, plan-list, left-sidebar, navigation, content-sized
