# Standalone Architect Browser Runtime Bootstrap

> Replace initial loading placeholders with daemon-provided project scope, model routing, plan index status, and instance binding metadata as soon as the browser shell starts.

**ID:** `standalone_architect_browser_runtime_bootstrap`  
**Category:** feedback  
**Status:** active  

## Data Contract

### Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| initialRuntimePayload | `object` | ✅ | Daemon-rendered runtime payload containing project_scope and architect_llm. |
| plansResponse | `object` | ❌ | Plan index payload from /api/architect/v1/plans. |

### Outputs

| Name | Type | Trigger | Description |
|------|------|---------|-------------|
| runtimeText | `dom_text` | on_bootstrap | Project scope, Architect LLM, and instance binding text rendered into the shell. |

## Interactions

- **render_runtime** — Applies daemon project_scope and architect_llm fields to visible runtime pills and binding strip.
- **load_project_plans** — Starts project plan loading after the initial runtime binding has rendered.

## Visual Semantics

- **Role:** status_binding
- **Emphasis:** info
- **Density:** compact
- **Chrome:** minimal

### State Styling

- **unbound** — warn when daemon_bound is false
- **bound** — compact selectable runtime metadata

## Layout Semantics

- **Pattern:** shell
- **Alignment:** leading
- **Sizing behavior:** fluid
- **Responsive behavior:** wrap, scroll

### Layout Hierarchy

- **runtime-strip** — secondary
- **chat-instance-binding** — auxiliary

**Tags:** standalone-architect, instance-binding, runtime-bootstrap
