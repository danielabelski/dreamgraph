# Standalone Architect Living Plan

> Project daemon-owned living plan state inside the standalone Architect sidebar with compact foldable review sections for open questions and nervous points.

**ID:** `standalone_architect_living_plan`  
**Category:** composite  
**Status:** active  

## Data Contract

### Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| living_state | `LivingPlanState` | ✅ | Read-only projection of plan confidence, review state, open questions, nervous points, branches, asks, pulse, and review prompt. |

### Outputs

| Name | Type | Trigger | Description |
|------|------|---------|-------------|
| section_visibility | `boolean` | on_toggle | Whether the user has expanded a nested living-plan review section. |

## Interactions

- **toggle_living_plan** — Expand or collapse the complete living-plan projection inside the right sidebar.
- **toggle_open_questions** — Expand or collapse unresolved plan questions inside the living-plan projection.
- **toggle_nervous_points** — Expand or collapse projected review-sensitive risks and guardrails inside the living-plan projection.

## Visual Semantics

- **Role:** sidebar review panel
- **Emphasis:** secondary
- **Density:** compact
- **Chrome:** embedded

### State Styling

- **collapsed** — summary only
- **review section expanded** — compact in-frame list

## Layout Semantics

- **Pattern:** stack
- **Alignment:** leading
- **Sizing behavior:** fill_parent
- **Responsive behavior:** collapse

### Layout Hierarchy

- **living_plan_summary** — primary
- **open_questions_foldout** — secondary
- **nervous_points_foldout** — secondary

## Platform Implementations

| Platform | Component | Source File | Notes |
|----------|-----------|-------------|-------|
| html | `nested details living-plan sidebar panel` | src/architect/routes.ts | Uses nested details controls and scoped compact list styling so review bullets stay inside the sidebar frame. |

**Used by features:** standalone_architect_plan_lifecycle_projection

**Tags:** architect, living-plan, plan-registry, open-questions, nervous-points, foldout
