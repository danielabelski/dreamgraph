# Standalone Architect Slash Command Runtime

> Provide user-facing slash command affordances that dispatch through daemon-governed Architect command capabilities and render structured chat results without exposing raw command text by default.

**ID:** `standalone_architect_slash_command_runtime`  
**Category:** action  
**Status:** active  

## Data Contract

### Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| message | `string` | ✅ | Chat prompt text beginning with a slash command. |
| active_instance_id | `string|null` | ❌ | Daemon-resolved active instance identifier injected by the command endpoint when available. |

### Outputs

| Name | Type | Trigger | Description |
|------|------|---------|-------------|
| chat_result | `object` | on_submit | Assistant chat message rendered from formatted_payload/content. |
| command_diagnostics | `object` | on_command_complete | Hidden-by-default diagnostic metadata including invoked command and active instance. |

## Interactions

- **submit_slash_command** — User submits a slash command in Architect chat.
- **show_help** — User asks for user-facing command descriptions with /help.
- **validate_command** — Incomplete or unknown slash commands render friendly validation messages.

## Visual Semantics

- **Role:** chat_command_surface
- **Emphasis:** secondary
- **Density:** compact
- **Chrome:** embedded

### State Styling

- **success** — formatted assistant chat result
- **validation_failed** — friendly assistant validation message
- **diagnostic_detail** — hidden unless explicitly requested

## Layout Semantics

- **Pattern:** flow
- **Alignment:** leading
- **Sizing behavior:** fluid
- **Responsive behavior:** wrap

### Layout Hierarchy

- **chat_input** — primary
- **chat_result** — primary
- **diagnostics** — auxiliary

## Platform Implementations

| Platform | Component | Source File | Notes |
|----------|-----------|-------------|-------|
| html | `Standalone Architect chat slash command helpers` | src/architect/routes.ts | Browser helpers parse slash commands and call POST /api/architect/v1/commands; server handler returns a structured result envelope. |

**Used by features:** standalone_architect_chat

**Tags:** architect, slash-command, daemon-governed, chat, structured-result
