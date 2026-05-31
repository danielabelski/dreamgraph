# Architect Plan Registry Projection

> Read-only projection of markdown plan files into structured Architect plan records with ADR bindings, semantic graph anchors, slices, checkpoints, evidence links, resume-state summaries, and projected operational_state/task_memory_binding envelopes for /api/architect/v1.

**Table:** `N/A`  
**Storage:** markdown projection + implementation log projection  

## Fields

| Field | Type | Description |
|-------|------|-------------|
| id | unknown |  |
| title | unknown |  |
| sourcePath | unknown |  |
| adr_bindings | unknown |  |
| graph_bindings | unknown |  |
| slices | unknown |  |
| checkpoints | unknown |  |
| resume_state | unknown |  |
| operational_state | unknown |  |
| task_memory_binding | unknown |  |

## Relationships

| Target | Type | Description |
|--------|------|-------------|
| standalone-architect | references | - |
| standalone-architect-api-v1 | references | - |

