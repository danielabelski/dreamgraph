# Solidify Insight Candidate Classification

> Strict advisory output shape used by solidify_cognitive_insight to classify speculative cognitive insight before any durable mutation. The model may propose a target type, evidence anchors, confidence, risks, required validation, ADR guard-rail review, contradictions, and duplicate hints; engine validation decides whether the candidate is surfaced, rejected/no-op, or followed by deterministic fallback.

**Table:** `N/A`  
**Storage:** N/A  

## Fields

| Field | Type | Description |
|-------|------|-------------|
| target_type | feature | workflow | data_model_relation | adr_candidate | noop | rejected | Validated advisory durable target classification. |
| source_ids | string[] | Existing graph ids grounding the candidate. |
| target_ids | string[] | Existing graph ids affected by relation candidates. |
| evidence_anchors | string[] | Repo-owned source anchors or existing graph ids cited as evidence. |
| confidence | number | Candidate confidence between 0 and 1. |
| risks | string[] | Risks surfaced before mutation. |
| required_validation | string[] | Validation work required before durable fact promotion. |
| adr_guard_rail_review | string[] | Accepted ADR guard-rail review evidence. |
| contradictions | string[] | Contradictions that force rejection when present. |
| planning_metadata | object | Route layer, provider/model provenance, token counters, validation errors, and fallback reason. |

## Relationships

| Target | Type | Description |
|--------|------|-------------|
| feature_adaptive_future_engine | produced_by | - |
| workflow_adaptive_future_engine_slice_rollout | used_by | - |

