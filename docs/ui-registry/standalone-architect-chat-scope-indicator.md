# Standalone Architect Chat Scope Indicator

> Shows the current Architect chat context as compact prompt-surface metadata and lets the user toggle between project-wide and selected-plan scope without competing with Send.

**ID:** `standalone_architect_chat_scope_indicator`  
**Category:** composite  
**Status:** active  

## Data Contract

### Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| activeChatScope | `"project" | "plan"` | ✅ | Current effective chat scope after selected-plan availability is applied. |
| activePlanId | `string | null` | ❌ | Selected plan id used to determine whether plan scope can be activated. |
| plan title | `string` | ❌ | Selected plan display title used for the compact plan label. |

### Outputs

| Name | Type | Trigger | Description |
|------|------|---------|-------------|
| chat scope toggle | `"project" | "plan"` | on_click | Switches scope between project-wide and selected-plan context when a plan is selected. |

## Interactions

- **toggle_scope** — Clicking the prompt-surface pill toggles project scope and selected-plan scope.
- **inspect_tooltip** — Hovering the pill explains whether messages use project-wide context or are bound to the selected plan.

## Visual Semantics

- **Role:** context tag
- **Emphasis:** muted
- **Density:** compact
- **Chrome:** embedded

### State Styling

- **project** — Muted blue-tinted contextual label.
- **plan** — Muted embedded contextual label with truncated selected-plan title.

## Layout Semantics

- **Pattern:** flow
- **Alignment:** leading
- **Sizing behavior:** content_sized
- **Responsive behavior:** collapse

### Layout Hierarchy

- **prompt input** — primary
- **scope indicator** — secondary
- **submit actions** — auxiliary

## Platform Implementations

| Platform | Component | Source File | Notes |
|----------|-----------|-------------|-------|
| html | `button.scope-pill inside .prompt-surface` | src/architect/routes.ts | Inline standalone Architect shell markup, CSS, and script render the compact 🌍 Project / 📍 Plan label. |

**Used by features:** standalone-architect-browser

**Tags:** architect, chat, scope, prompt, browser
