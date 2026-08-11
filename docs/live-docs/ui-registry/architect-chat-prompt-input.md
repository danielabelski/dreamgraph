# Architect Chat Prompt Input

> Accepts project-scope or plan-scope Architect prompts and supports local prompt history navigation from the prompt textarea.

**ID:** `architect-chat-prompt-input`  
**Category:** data_input  
**Status:** active  

## Data Contract

### Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| message | `string` | ❌ | The prompt text entered in the Architect chat textarea. |
| pending_attachments | `array` | ❌ | Files staged with the prompt before submission. |

### Outputs

| Name | Type | Trigger | Description |
|------|------|---------|-------------|
| architect_chat_request | `object` | submit | POST payload sent to the Architect chat API for project or plan scoped execution. |
| local_prompt_history | `array` | successful_prompt_submit | Browser-local list of recently submitted prompt strings for keyboard recall. |

## Interactions

- **submit_prompt** — Submit prompt unless composing or Shift is held.
- **insert_newline** — Keep multiline prompt editing inside the textarea.
- **recall_previous_prompt** — When cursor is on the first prompt line, recall the previous saved prompt.
- **recall_next_prompt_or_draft** — When navigating history and cursor is on the last prompt line, move toward newer prompts or restore the draft.

## Visual Semantics

- **Role:** prompt composer
- **Emphasis:** primary
- **Density:** compact
- **Chrome:** embedded

## Layout Semantics

- **Pattern:** flow
- **Alignment:** leading
- **Sizing behavior:** fluid

## Platform Implementations

| Platform | Component | Source File | Notes |
|----------|-----------|-------------|-------|
| standalone-browser | `textarea#chat-input` | - | - |

**Tags:** architect, chat, prompt-history, standalone-browser
