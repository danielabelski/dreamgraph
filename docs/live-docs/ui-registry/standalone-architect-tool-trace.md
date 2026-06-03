# Standalone Architect Tool Trace

> Shows daemon-executed tool calls with status, duration, runtime provenance, and compact structured result summaries without exposing raw JSON payloads by default.

**ID:** `standalone_architect_tool_trace`  
**Category:** feedback  
**Status:** active  

## Data Contract

### Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| tool_trace | `array<object>` | ✅ | Tool call trace entries including tool name, status, duration, and optional result preview. |
| runtime_provenance | `object` | ❌ | Active Architect session runtime and provenance metadata attached to tool execution. |

### Outputs

| Name | Type | Trigger | Description |
|------|------|---------|-------------|
| trace_summary_visible | `ui_event` | render | A compact readable summary of each tool call is shown in chat. |

## Interactions

- **expand_result_preview** — Expands a compact structured preview with key fields and named items, not raw serialized JSON.

## Visual Semantics

- **Role:** trace
- **Emphasis:** muted
- **Density:** compact
- **Chrome:** embedded

### State Styling

- **completed** — status pill with compact result summary
- **failed** — status pill with readable fallback preview

## Layout Semantics

- **Pattern:** stack
- **Alignment:** leading
- **Sizing behavior:** content_sized
- **Responsive behavior:** wrap

### Layout Hierarchy

- **tool name and status** — primary
- **result summary** — secondary

## Platform Implementations

| Platform | Component | Source File | Notes |
|----------|-----------|-------------|-------|
| html | `appendToolTraceMessage` | src/architect/routes.ts | Uses generated browser script helpers to parse JSON previews, summarize known fields, and collapse fallback whitespace without template-string regex corruption. |

**Tags:** standalone-architect, tool-trace, provenance, compact-preview
