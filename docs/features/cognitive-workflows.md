# Cognitive Workflows

> Defines various cognitive workflows that the cognitive engine can execute. These workflows are essential for processing tasks and generating insights from the knowledge graph.

**Repository:** dreamgraph  
**Domain:** data-processing  
**Status:** active  
**Source files:** src/cognitive/*.ts  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| cognitive_engine | feature | manages | strong | The cognitive engine manages the execution of cognitive workflows. |
| cognitive_registry | feature | depends_on | moderate | The cognitive registry is essential for managing various cognitive tasks and workflows. |
| cognitive_scheduler | feature | manages | strong | The cognitive scheduler manages the scheduling of cognitive tasks and workflows. |
| cognitive_workflow_pipeline | feature | composes | strong | The cognitive workflow pipeline incorporates cognitive processing and tool management. |
| cognitive_workflow_management | feature | manages | strong | Cognitive workflow management ensures that cognitive tasks are efficiently managed within workflows. |
| cognitive_workflow_hub | feature | belongs_to | moderate | The cognitive workflow hub is a central hub for managing cognitive workflows. |
| dreamgraph_src_cognitive_strategies | feature | related_to | moderate | auto-backlink |
| feature_cognitive_runtime | feature | related_to | moderate | auto-backlink |
| cognitive_intervention | feature | related_to | moderate | auto-backlink |
| cognitive_temporal | feature | supports | moderate | auto-backlink |
| cognitive_federation | feature | related_to | moderate | auto-backlink |
| cognitive_graph_rag | feature | related_to | moderate | auto-backlink |
| data_model | feature | supports | moderate | auto-backlink |
| cognitive_tuning | feature | related_to | moderate | auto-backlink |
| automation_scripts | feature | related_to | moderate | auto-backlink |
| dreamgraph_cognitive_dream_cycle | feature | related_to | moderate | auto-backlink |
| capability_semantic_provenance_preservation | feature | depends_on | moderate | auto-backlink |

**Tags:** cognitive, workflow

