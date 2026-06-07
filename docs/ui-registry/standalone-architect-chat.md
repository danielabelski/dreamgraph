# Standalone Architect Chat

> Browser-based Architect chat surface for project-bound DreamGraph work through daemon-owned APIs.

**ID:** `standalone_architect_chat`  
**Category:** composite  
**Status:** active  

## Data Contract

### Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| message | `string` | ✅ | User prompt submitted by POST /api/architect/v1/chat. |
| planId | `string | null` | ❌ | Optional active plan binding for chat context. |

### Outputs

| Name | Type | Trigger | Description |
|------|------|---------|-------------|
| assistant_response | `object` | chat_submit | Assistant content with route metadata, tool_trace, provenance, and token_economy metadata. |
| budget_status | `object | null` | chat_finalize / architect.chat.status | Daemon-owned read-only budget balance: turn, actual/expected tokens, debt or credit, pressure label, model id, and top component contributors. |

## Interactions

- **submit_message** — Posts a chat request to the daemon Architect endpoint.
- **inspect_tool_trace** — Shows MCP tool execution trace and provenance in the browser event log/status surface.
- **read_budget_balance** — Renders the daemon-sourced token economy balance pill from chat JSON or SSE/event payloads; browser state is display-only and never budget authority.

## Visual Semantics

- **Role:** shell
- **Emphasis:** primary
- **Density:** compact
- **Chrome:** full_shell

### State Styling

- **tool_trace_present** — Expose compact trace/provenance entries in the event log and status text.
- **budget_status_present** — Show actual/expected tokens, debt or credit, and context pressure in the compact token economy pill.

## Layout Semantics

- **Pattern:** shell
- **Alignment:** leading
- **Sizing behavior:** fill_parent
- **Responsive behavior:** scroll, collapse

### Layout Hierarchy

- **chat** — primary
- **event_log** — secondary

**Used by features:** standalone-architect

**Tags:** standalone-architect, chat, mcp, tool-trace, provenance, token-economy, budget-status
