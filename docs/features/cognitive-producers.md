# Cognitive Producers

> A set of functions that produce events related to cognitive processing, such as recording tensions and validating results. These producers interact with the cognitive engine to manage the state of the knowledge graph.

**Repository:** dreamgraph  
**Domain:** data-processing  
**Status:** active  
**Source files:** src/cognitive/adversarial.ts, src/cognitive/causal.ts, src/cognitive/dreamer.ts, src/cognitive/event-router.ts, src/cognitive/federation.ts, src/cognitive/graph-rag.ts, src/cognitive/intervention.ts, src/cognitive/llm.ts, src/cognitive/lucid.ts, src/cognitive/metacognition.ts, src/cognitive/narrator.ts, src/cognitive/normalizer.ts, src/cognitive/register.ts, src/cognitive/scheduler.ts, src/cognitive/temporal.ts  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| cognitive_scheduler | feature | depends_on | strong | Cognitive Producers rely on the Cognitive Scheduler to manage the timing of cognitive tasks. |
| event_router | feature | manages | strong | Cognitive Producers interact with the Event Router to ensure events are processed correctly. |
| cognitive_normalizer | feature | depends_on | strong | Cognitive Producers utilize the Cognitive Normalizer to maintain data consistency. |
| cognitive_adversarial | feature | composes | moderate | Cognitive Producers include the Adversarial Cognitive Module for adversarial reasoning. |
| cognitive_intervention | feature | enhances | moderate | Cognitive Producers are enhanced by the Cognitive Intervention feature for real-time adjustments. |
| cognitive_temporal | feature | composes | moderate | Cognitive Producers include the Temporal Cognitive Module for analyzing time-based events. |
| cognitive_graph_rag | feature | composes | moderate | Cognitive Producers utilize the Graph RAG Cognitive Module for enhanced data retrieval. |
| feature_cognitive_runtime | feature | supports | moderate | auto-backlink |
| cognitive_causal | feature | related_to | moderate | auto-backlink |
| cognitive_narrator | feature | related_to | moderate | auto-backlink |
| cognitive_federation | feature | supports | moderate | auto-backlink |
| tension_management | feature | supports | moderate | auto-backlink |
| dreamgraph_cognitive_dream_cycle | feature | related_to | moderate | auto-backlink |
| dreamgraph_src_cognitive | feature | related_to | moderate | auto-backlink |
| causal_model | feature | supports | moderate | auto-backlink |
| dreamer | feature | related_to | moderate | auto-backlink |
| narrator | feature | supports | moderate | auto-backlink |

**Tags:** cognitive, producers, events

