# Standalone Architect compact tool trace panel

> Shows live daemon-emitted tool execution state for the current assistant turn as one compact collapsible trace panel instead of separate raw tool cards.

**ID:** `standalone_architect_compact_tool_trace_panel`  
**Category:** feedback  
**Status:** active  

## Data Contract

### Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| architect.tool_result event | `ArchitectToolTraceEntry` | ✅ | Typed daemon/orchestrator tool trace event with trace_id, tool, args_summary, status, duration_ms, and result_preview. |

### Outputs

| Name | Type | Trigger | Description |
|------|------|---------|-------------|
| trace rows | `DOM update` | architect.tool_result | Upserts a compact row in the active assistant turn trace panel. |

## Interactions

- **expand_details** — User expands a tool row details block to inspect compact raw argument/result payloads.
- **collapse_trace** — User collapses the single trace panel for the assistant turn.

## Visual Semantics

- **Role:** feedback
- **Emphasis:** info
- **Density:** compact
- **Chrome:** embedded

### State Styling

- **running** — compact warning-tinted status pill
- **completed** — compact success-tinted status pill
- **failed** — compact danger-tinted status pill

## Layout Semantics

- **Pattern:** stack
- **Alignment:** leading
- **Sizing behavior:** fluid

### Layout Hierarchy

- **trace summary** — primary
- **tool rows** — secondary
- **collapsed details** — auxiliary

**Used by features:** standalone-architect-cli-bridge

**Tags:** standalone-architect, tool-trace, live-progress, codex-cli, copilot-cli, browser
