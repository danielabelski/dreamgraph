# Standalone Architect Chat Scope Pill

> Lets operators choose whether a browser Architect prompt is bound to the selected plan or treated as a global project/repo/graph prompt before sending.

**ID:** `standalone_architect_chat_scope_pill`  
**Category:** action  
**Status:** active  

## Data Contract

### Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| activePlanId | `string|null` | ❌ | Currently selected Architect plan id, if any. |
| activeChatScope | `plan|project` | ✅ | Current chat scope selected by the operator or slash override. |

### Outputs

| Name | Type | Trigger | Description |
|------|------|---------|-------------|
| chat_scope | `plan|project` | on_submit | Scope included in /api/architect/v1/chat request payload. |
| selected_plan_cleared | `string|null` | on_click_selected_plan | Null selected plan persisted when the selected plan is clicked again. |

## Interactions

- **toggle_scope** — Clicking the pill toggles between Project scope and Plan scope when a plan is selected.
- **slash_override** — /ask, /global, and /repo force Project scope; /plan forces Plan scope and strips the command prefix.
- **unselect_plan** — Clicking an already selected plan clears the plan selection and returns chat to Project scope.

## Visual Semantics

- **Role:** scope selector
- **Emphasis:** info
- **Density:** compact
- **Chrome:** minimal

## Layout Semantics

- **Pattern:** toolbar
- **Alignment:** leading
- **Sizing behavior:** content_sized
- **Responsive behavior:** wrap

## Platform Implementations

| Platform | Component | Source File | Notes |
|----------|-----------|-------------|-------|
| html | `button#chat-scope-pill` | src/architect/routes.ts | Rendered in the standalone Architect chat composer. |

**Used by features:** standalone-architect

**Tags:** standalone-architect, chat-scope, browser-ui, plan-selection
