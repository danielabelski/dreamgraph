# Standalone Architect Browser Shell

> Project-bound browser Architect surface for selecting plans, choosing the execution route/provider/model, sending chat turns, reviewing tool traces, and inspecting plan context.

**ID:** `standalone_architect_browser_shell`  
**Category:** composite  
**Status:** active  

## Data Contract

### Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| plans | `array<ArchitectPlanSummary>` | ✅ | Plan summaries and selected plan detail loaded from daemon Architect endpoints. |
| architect_controls | `object` | ✅ | Adapter route, API provider, model selection, and autonomy mode chosen in the browser. |
| tool_trace | `array<ArchitectToolTraceEntry>` | ❌ | Daemon-native tool loop trace entries with tool name, status, duration, and result preview. |

### Outputs

| Name | Type | Trigger | Description |
|------|------|---------|-------------|
| chat_request | `POST /api/architect/v1/chat` | on_submit | Sends the prompt and selected controls through POST body transport. |
| plan_selection | `GET /api/architect/v1/plans/{planId}` | on_change | Loads selected plan detail, Adaptive Future Review, and scheduler projection. |

## Interactions

- **select_plan** — Selecting a plan refreshes the right-sidebar plan detail and Adaptive Future Review using a stale-load guard.
- **change_provider_route** — Changing the provider/adapter route updates the model menu for native API, Codex CLI, or Copilot CLI model defaults.
- **inspect_tool_trace** — Tool traces render as compact rows with collapsible result previews instead of inline raw JSON.
- **collapse_resize_sidebar** — Both sidebars expose compact top-corner collapse buttons and resize handles.

## Visual Semantics

- **Role:** shell
- **Emphasis:** primary
- **Density:** compact
- **Chrome:** panel

### State Styling

- **active_plan** — selected plan row is emphasized without fixed-height clipping
- **tool_trace** — compact trace card with name, status, duration, and collapsible preview

## Layout Semantics

- **Pattern:** shell
- **Alignment:** distributed
- **Sizing behavior:** fluid
- **Responsive behavior:** collapse, scroll, wrap

### Layout Hierarchy

- **plan rail** — secondary
- **chat transcript and composer** — primary
- **plan context inspector** — auxiliary

## Platform Implementations

| Platform | Component | Source File | Notes |
|----------|-----------|-------------|-------|
| html | `renderArchitectShell` | src/architect/routes.ts | Server-rendered standalone Architect HTML/CSS/JS shell. |

**Used by features:** standalone-architect, feature_standalone_architect

**Tags:** standalone-architect, browser-ui, provider-model-selection, tool-trace, plan-review
