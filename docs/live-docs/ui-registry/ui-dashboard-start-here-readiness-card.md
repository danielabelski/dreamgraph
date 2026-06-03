# Dashboard Start Here Readiness Card

> Give a new Dashboard user a plain-language first-run readiness summary, identify the first required repair action, and provide a prominent Open Architect entry point.

**ID:** `ui_dashboard_start_here_readiness_card`  
**Category:** composite  
**Status:** active  

## Data Contract

### Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| onboarding_readiness | `OnboardingReadinessProjection` | ✅ | Daemon-owned readiness facts for service, project, project map, Architect runtime, repositories, required checks, optional checks, and suggested next action. |

### Outputs

| Name | Type | Trigger | Description |
|------|------|---------|-------------|
| readiness_summary | `server_rendered_html` | Dashboard root render | Plain-language summary and expanded readiness checklists. |
| recommended_next_action | `governed_action_link` | Dashboard root render | The first repair path or Open Architect handoff derived from daemon readiness. |

## Interactions

- **open_architect** — Open the standalone Architect surface.
- **view_setup_details** — Jump to the required and optional readiness checklists.
- **follow_repair_link** — Follow a daemon-projected route repair link or hand tool-backed work to Architect.

## Visual Semantics

- **Role:** prominent onboarding readiness card
- **Emphasis:** primary
- **Density:** comfortable
- **Chrome:** panel

## Layout Semantics

- **Pattern:** stack
- **Alignment:** leading
- **Sizing behavior:** fluid
- **Responsive behavior:** wrap, collapse

## Platform Implementations

| Platform | Component | Source File | Notes |
|----------|-----------|-------------|-------|
| dashboard_html | `renderIndex` | src/server/dashboard.ts | - |

**Used by features:** feature_dashboard_server

**Tags:** dashboard, onboarding, readiness, start-here, architect
