# Standalone Architect plan lifecycle projection

> Displays daemon-derived plan lifecycle, execution state, last completed slice, next slice, active slice, and active phase from implementation-log checkpoints.

**ID:** `standalone_architect_plan_lifecycle_projection`  
**Category:** data_display  
**Status:** active  

## Data Contract

### Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| implementation log checkpoints | `ArchitectPlanCheckpoint[]` | ✅ | Append-only implementation-log checkpoint records parsed from plan logs. |
| plan slices | `ArchitectPlanSlice[]` | ✅ | Structured plan slices projected from plan markdown headings. |

### Outputs

| Name | Type | Trigger | Description |
|------|------|---------|-------------|
| operational plan state | `ArchitectOperationalPlanState` | plan load or refresh | Lifecycle, execution state, active phase, last completed slice, next slice, and task memory binding. |

## Interactions

- **inspect_status** — User reads current lifecycle/execution and resume targets from plan chips and plan rail metadata.
- **refresh_after_run** — Browser reloads daemon plan projection after a chat run so status changes are visible without manual page refresh.

## Visual Semantics

- **Role:** inspector
- **Emphasis:** info
- **Density:** compact
- **Chrome:** embedded

## Layout Semantics

- **Pattern:** toolbar
- **Alignment:** leading
- **Sizing behavior:** fluid

**Used by features:** standalone-architect-cli-bridge

**Tags:** standalone-architect, plan-status, implementation-log, lifecycle, execution-state
