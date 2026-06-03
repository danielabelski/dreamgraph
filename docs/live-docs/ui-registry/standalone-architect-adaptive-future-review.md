# Standalone Architect Adaptive Future Review

> Show the selected plan's advisory Adaptive Future Review as a plan-bound recommendation surface with provenance, candidate labels, scores, objections, and governed decision actions.

**ID:** `standalone_architect_adaptive_future_review`  
**Category:** composite  
**Status:** active  

## Data Contract

### Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| plan_id | `string` | ✅ | The currently selected standalone Architect plan id used to request the plan-bound future review projection. |
| future_review | `object` | ✅ | Daemon-generated advisory review payload containing planId, model provenance, selected candidate id, candidate labels/scores/evidence/objections, review status, and governed decision templates. |

### Outputs

| Name | Type | Trigger | Description |
|------|------|---------|-------------|
| future_review_decision | `object` | on_click | A governed review-gate decision request for accept, reject, defer, or supersede actions on the selected plan's advisory recommendation. |
| selected_candidate_rendered | `string` | on_plan_selection | The selected plan-bound candidate id shown in the review summary and candidate list. |

## Interactions

- **review_candidate** — Read the selected plan's advisory candidate futures as compact rows using plan-specific labels and ids.
- **record_decision** — Submit accept, reject, defer, or supersede through the daemon review-gates endpoint.
- **switch_plan** — Changing plans reloads the future review projection and discards stale results from earlier plan loads.

## Visual Semantics

- **Role:** inspector
- **Emphasis:** secondary
- **Density:** compact
- **Chrome:** embedded

### State Styling

- **loading** — Clear stale candidate rows and show plan-specific loading status.
- **ready** — Show provenance chips and compact candidate rows without inline raw JSON.

## Layout Semantics

- **Pattern:** stack
- **Alignment:** leading
- **Sizing behavior:** fluid
- **Responsive behavior:** wrap, scroll

### Layout Hierarchy

- **provenance_summary** — secondary
- **candidate_list** — primary
- **decision_actions** — auxiliary

**Used by features:** standalone-architect

**Tags:** standalone-architect, adaptive-future-engine, plan-selection, review, advisory
