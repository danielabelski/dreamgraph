# Remediation Evidence Bundle

> Evidence contract used by Adaptive Future Engine remediation drafting and future-fit ranking. Bundles include scoped evidence anchors, ADR guard rails, entity summaries, allowed action classes, deterministic short-circuit metadata, verification obligations, and optional learning_hooks that are harvested into FutureSignal entries only when every hook anchor is present in the bundle.

**Table:** `N/A`  
**Storage:** typescript:src/cognitive/types.ts  

## Fields

| Field | Type | Description |
|-------|------|-------------|
| evidence_anchors | EvidenceAnchor[] | Allowed anchor set for candidate validation and scoped learning-hook admission. |
| learning_hooks | LearningHook[] | undefined | Optional accepted, edited, rejected, overridden, reverted, explicit preference, recurring pattern, and drift evidence used for future-fit scoring after hard validation. |
| verification_obligations | VerificationStep[] | Required verification obligations carried from evidence bundle to candidate validation and deterministic fallback outcomes. |

## Relationships

| Target | Type | Description |
|--------|------|-------------|
| remediation_log_adaptive_future_sidecar | feeds | - |
| feature_adaptive_future_engine | supports | - |

