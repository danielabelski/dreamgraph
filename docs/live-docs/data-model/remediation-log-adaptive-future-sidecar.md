# Remediation Log Adaptive Future Sidecar

> Bounded prompt-free remediation persistence sidecar for Adaptive Future Engine metadata. Stores compact evidence anchors, selected candidate and selected source, rejected candidates, fallback usage/reason, validation failures, future-fit score, objection count, future signal ids, outcomes, and metrics without storing raw prompts or secret-bearing diagnostics.

**Table:** `N/A`  
**Storage:** file-backed JSON/JSONL sidecar files  

## Fields

| Field | Type | Description |
|-------|------|-------------|
| MAX_REMEDIATION_FUTURE_SIGNALS | unknown |  |
| MAX_REMEDIATION_FUTURE_OUTCOMES | unknown |  |
| MAX_REMEDIATION_CANDIDATE_RUNS | unknown |  |
| selected_source | unknown |  |
| fallback_used | unknown |  |
| fallback_reason | unknown |  |
| future_fit_score | unknown |  |
| future_signal_ids | unknown |  |

## Relationships

| Target | Type | Description |
|--------|------|-------------|
| feature_adaptive_future_engine | references | - |
| workflow_adaptive_future_engine_slice_rollout | references | - |

