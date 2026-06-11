# Standalone Architect Chat Tool Trace Timeline

> Render tool-using Architect chat turns in execution order: initial intent/status message, visible tool trace panel, then final assistant report.

**ID:** `standalone_architect_chat_tool_trace_timeline`  
**Category:** chat-ui  
**Status:** active  

## Data Contract

### Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| result.tool_trace | `ArchitectToolTraceEntry[]` | ❌ | Tool trace entries returned by /api/architect/v1/chat. |
| result.content | `string` | ❌ | Final assistant report content returned by the chat result. |
| runtime.narrative_density | `ArchitectNarrativeDensity` | ❌ | Runtime density metadata used for trace visibility state, without expanding per-tool details. |

### Outputs

| Name | Type | Trigger | Description |
|------|------|---------|-------------|
| intent_message | `chat-message assistant` | sendChatMessage starts a chat request. | Initial assistant status message shown before tool trace rendering. |
| tool_trace_panel | `chat-message tool` | Chat result contains one or more tool_trace entries. | Visible tool trace panel for non-empty tool_trace results. |
| final_report_message | `chat-message assistant` | After appendToolTraceMessage completes for a tool-using result. | Final assistant answer appended after the tool trace panel. |

## Interactions

- **toggle_trace_panel** — The user can collapse or expand the overall trace panel; it is open by default when tool calls exist.
- **toggle_tool_detail** — The user can expand an individual tool row Details disclosure; rows are collapsed by default.

## Visual Semantics

- **Role:** execution timeline
- **Emphasis:** info
- **Density:** compact
- **Chrome:** embedded

## Layout Semantics

- **Pattern:** flow
- **Alignment:** leading
- **Sizing behavior:** fluid

## Platform Implementations

| Platform | Component | Source File | Notes |
|----------|-----------|-------------|-------|
| standalone-browser | `src/architect/routes.ts` | - | - |
| vitest | `tests/standalone-architect-routes.test.ts` | - | - |

**Used by features:** /architect, /api/architect/v1/chat

**Tags:** standalone-architect, chat-ui, tool-trace, timeline, ADR-233, ADR-234, verified
