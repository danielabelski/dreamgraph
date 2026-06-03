# Standalone Architect Chat Instance Binding

> Show the operator which daemon instance and instance home directory the browser chat is bound to, so prompt-bearing actions are visibly scoped to the running local daemon instance.

**ID:** `standalone_architect_chat_instance_binding`  
**Category:** feedback  
**Status:** active  

## Data Contract

### Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| project_scope | `object` | ✅ | Runtime payload containing instance_id, home_dir, config_dir, runtime_dir, project_root, and plans_root. |

### Outputs

| Name | Type | Trigger | Description |
|------|------|---------|-------------|
| instance_binding_text | `text` | runtime_payload_rendered | Small selectable text below chat showing instance uuid and home/config/runtime directories. |

## Interactions

- **inspect** — Operator reads or selects the instance UUID and home directory below the chat controls.

## Visual Semantics

- **Role:** binding-metadata
- **Emphasis:** muted
- **Density:** compact
- **Chrome:** minimal

## Layout Semantics

- **Pattern:** stack
- **Alignment:** leading
- **Sizing behavior:** fluid

### Layout Hierarchy

- **chat-panel** — primary
- **instance-binding** — secondary

## Platform Implementations

| Platform | Component | Source File | Notes |
|----------|-----------|-------------|-------|
| html | `p#instance-binding` | src/architect/routes.ts | Rendered below the Architect chat form in small technical text. |

**Tags:** standalone-architect, instance-binding, security
