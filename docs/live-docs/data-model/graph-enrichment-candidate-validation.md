# Graph Enrichment Candidate Validation

> Validation contract for LLM-shaped graph enrichment candidates: parser-node anchors and wire-link edges must pass id, vocabulary, evidence excerpt, confidence, direction, and bounded-count checks before persistence; invalid output falls back to deterministic structural enrichment or safe no-op behavior.

**Table:** `N/A`  
**Storage:** N/A  

## Fields

| Field | Type | Description |
|-------|------|-------------|
| candidate_id | unknown |  |
| relationship | unknown |  |
| direction | unknown |  |
| evidence_excerpt | unknown |  |
| confidence | unknown |  |
| deterministic_score | unknown |  |

## Relationships

| Target | Type | Description |
|--------|------|-------------|
| feature_adaptive_future_engine | references | - |
| workflow_adaptive_future_engine_slice_rollout | references | - |

