# Cognitive Registry

> Maintains a registry of cognitive components and their configurations. This registry is essential for managing the various cognitive tasks and workflows within the application.

**Repository:** dreamgraph  
**Domain:** data-processing  
**Status:** active  
**Source files:** src/cognitive/bootstrap-registry.ts  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| cognitive_engine | feature | depends_on | strong | The Cognitive Engine relies on the Cognitive Registry to manage cognitive components and their configurations. |
| cognitive_workflows | feature | depends_on | strong | Cognitive Workflows utilize the Cognitive Registry to define and manage workflows for cognitive tasks. |
| cognitive_scheduler | feature | depends_on | strong | The Cognitive Scheduler depends on the Cognitive Registry for managing task scheduling and configurations. |
| cognitive_tuning | feature | depends_on | strong | Cognitive Tuning relies on the Cognitive Registry for parameters and configurations related to cognitive processes. |
| instance_registry | feature | depends_on | moderate | The Instance Registry may utilize the Cognitive Registry to track configurations of cognitive components. |
| dreamgraph_src_cognitive_strategies | feature | related_to | moderate | auto-backlink |
| cognitive_federation | feature | related_to | moderate | auto-backlink |
| event_router | feature | supports | moderate | auto-backlink |
| dreamgraph_src_cognitive | feature | related_to | moderate | auto-backlink |
| dreamgraph_src_cognitive_flow | feature | supports | moderate | auto-backlink |

**Tags:** cognitive, registry

