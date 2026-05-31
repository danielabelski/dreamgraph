# Architect Chat Shell V1

> Provide the canonical dockable DreamGraph chat and architect experience inside the VS Code sidebar, combining conversation history, provider/model controls, autonomy and budget status, attachments, recommended next steps, and streamed assistant responses.

**ID:** `architect-chat-shell-v1`  
**Category:** composite  
**Status:** active  

## Data Contract

### Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| messages | `ChatMessage[]` | ✅ | Conversation timeline rendered from extension-host state, including user and assistant turns, verdicts, tool traces, and attachments. |
| architect_config | `{ provider:string; model:string; capabilities:object }` | ✅ | Current provider/model selection and capability flags used to drive header controls and attachment support. |
| autonomy_status | `AutonomyStatusMessage` | ❌ | Current autonomy mode, pass counters, and continuation state shown in the shell header/footer. |
| budget_status | `BudgetStatusMessage` | ❌ | Per-turn token budget/debt telemetry surfaced to the user for visibility into context pressure. |
| attachments | `AttachmentPreview[]` | ❌ | Pending prompt attachments selected by the user before submission. |

### Outputs

| Name | Type | Trigger | Description |
|------|------|---------|-------------|
| send_prompt | `string | content_blocks` | on_submit | Submits a user prompt and optional attachments for context assembly and architect execution. |
| change_model | `{ provider:string; model:string }` | on_header_selection | Updates the selected provider/model from header controls. |
| execute_recommended_step | `{ id:string }` | on_recommended_action_click | Requests continuation using a recommended next step emitted by the previous pass. |
| inspect_entity | `string` | on_entity_link_click | Opens or resolves a graph-linked entity referenced from rendered markdown/cards. |

## Interactions

- **compose_and_send_prompt** — Compose a prompt, optionally attach files, and submit it to the architect runtime.
- **inspect_streaming_pass_output** — Observe streamed narrative, tool progress, verdicts, and summary cards during a pass.
- **switch_provider_or_model** — Change provider or model from header controls before sending the next prompt.
- **review_recommended_next_steps** — Inspect and choose clickable recommended continuation actions from the latest pass.
- **inspect_budget_and_autonomy_status** — Review pass counters, autonomy state, and budget pressure indicators while the conversation progresses.

## Visual Semantics

- **Role:** shell
- **Emphasis:** primary
- **Density:** comfortable
- **Chrome:** panel

## Layout Semantics

- **Pattern:** shell
- **Alignment:** leading
- **Sizing behavior:** fill_parent
- **Responsive behavior:** scroll, collapse

### Layout Hierarchy

- **header_controls** — primary
- **message_timeline** — primary
- **status_footer** — secondary

## Platform Implementations

| Platform | Component | Source File | Notes |
|----------|-----------|-------------|-------|
| vscode | `WebviewViewProvider` | extensions/vscode/src/chat-panel.ts | Docked sidebar chat surface registered as dreamgraph.chatView and hydrated by extension-host state. |

**Used by features:** feature_vscode_extension_runtime

**Tags:** vscode, architect, chat, autonomy, webview, v10.0.0
