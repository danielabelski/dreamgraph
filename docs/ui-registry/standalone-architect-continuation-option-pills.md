# Standalone Architect Continuation Option Pills

> Present safe and disabled continuation actions as visible buttons bound to stable action ids and continuation tokens.

**ID:** `standalone_architect_continuation_option_pills`  
**Category:** action  
**Status:** active  

## Data Contract

### Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| continuation_token | `string` | ✅ | Opaque host-issued token for the next bounded continuation request. |
| continuation_options | `ArchitectRecommendedAction[]` | ✅ | Visible safe and disabled continuation actions from the pass report. |
| selected_action_id | `string|null` | ❌ | Action id selected by the user or host decision. |

### Outputs

| Name | Type | Trigger | Description |
|------|------|---------|-------------|
| chat_request | `POST /api/architect/v1/chat payload` | enabled pill click | Follow-up chat request carrying continuation_token and selected_action_id. |

## Interactions

- **click** — Enabled pill sends the stored continuation token and clicked action id to the chat endpoint.
- **disabled_state** — Unsafe or unavailable actions remain visible with disabled state and tooltip rationale.

## Visual Semantics

- **Role:** continuation action buttons
- **Emphasis:** primary
- **Density:** compact
- **Chrome:** minimal

## Layout Semantics

- **Pattern:** flow
- **Alignment:** leading
- **Sizing behavior:** fluid
- **Responsive behavior:** wrap

## Platform Implementations

| Platform | Component | Source File | Notes |
|----------|-----------|-------------|-------|
| standalone-web | `renderArchitectContinuationPills` | src/architect/routes.ts | - |

**Used by features:** architect-continuation

**Tags:** architect, continuation, slice-4, manual-selection
