# Standalone Architect Dynamic Center Tabs

> Provide a descriptor-driven center workspace tab framework for built-in and dynamic Architect surfaces.

**ID:** `standalone_architect_dynamic_center_tabs`  
**Category:** navigation  
**Status:** active  

## Data Contract

### Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| tab_descriptors | `array<object>` | ✅ | Descriptors with id, title, type, lifecycle, dirty, closeable, and panel bindings. |
| registered_tab_types | `array<object>` | ✅ | Dynamic tab type descriptors available from the creation menu. |

### Outputs

| Name | Type | Trigger | Description |
|------|------|---------|-------------|
| active_tab_change | `string` | on_click | Selected center tab id persisted in browser presentation state. |
| dynamic_tab_created | `object` | on_click | New closeable dynamic tab descriptor and panel. |
| dynamic_tab_closed | `string` | on_click | Closed dynamic tab id. |

## Interactions

- **select_tab** — Switch between Chat, Plan, ADR Editor, and dynamic center tabs.
- **open_creation_menu** — Open the right-aligned tab creation menu.
- **create_terminal_tab** — Create a closeable placeholder Terminal tab registered for Slice 8.
- **close_dynamic_tab** — Close a dynamic tab without affecting built-in tabs.

## Visual Semantics

- **Role:** workspace navigation
- **Emphasis:** secondary
- **Density:** compact
- **Chrome:** minimal

### State Styling

- **selected** — accented tab button
- **dynamic_closeable** — close affordance inside tab button
- **menu_open** — anchored popup menu

## Layout Semantics

- **Pattern:** toolbar
- **Alignment:** distributed
- **Sizing behavior:** fill_parent
- **Responsive behavior:** wrap

### Layout Hierarchy

- **tab_list** — primary
- **creation_menu** — auxiliary
- **tab_panels** — primary

**Used by features:** standalone_architect_chat

**Tags:** standalone-architect, dynamic-tabs, level-3, slice-7
