# Cognitive Intervention

> Generates remediation plans from high-urgency tensions. The planner validates LLM-drafted candidates, scores valid candidates with project-native future signals, records future objections in ranking metadata, and falls back to deterministic plans when no validated candidate is available.

**Repository:** dreamgraph  
**Domain:** core  
**Status:** active  
**Source files:** src/cognitive/intervention.ts, tests/remediation-drafting-validation.test.ts  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| cognitive_scheduler | feature | related_to | moderate | auto-backlink |
| cognitive_producers | feature | related_to | moderate | auto-backlink |
| cognitive_tuning | feature | related_to | moderate | auto-backlink |
| cognitive_workflows | feature | related_to | moderate | auto-backlink |
| dreamgraph_src_cognitive | feature | related_to | moderate | auto-backlink |
| cognitive_engine | feature | depends_on | moderate | auto-backlink |
| feature_adaptive_future_engine | feature | depends_on | moderate | auto-backlink |

**Tags:** remediation, future-fit, validation

