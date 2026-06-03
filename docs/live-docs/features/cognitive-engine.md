# Cognitive Engine

> The core engine responsible for processing cognitive tasks within DreamGraph. It manages the execution of cognitive workflows and integrates with various cognitive components.

**Repository:** dreamgraph  
**Domain:** data-processing  
**Status:** active  
**Source files:** src/cognitive/engine.ts  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| cognitive_workflows | feature | defines | strong | Cognitive Workflows defines various cognitive workflows that the cognitive engine can execute. |
| cognitive_registry | feature | manages | moderate | Cognitive Registry maintains a registry of cognitive components and their configurations essential for managing cognitive tasks. |
| llm_provider | feature | depends_on | moderate | The cognitive engine depends on LLM Provider for access to necessary LLM resources. |
| cognitive_scheduler | feature | enhances | weak | Cognitive Scheduler enhances the efficiency of the cognitive engine by managing the scheduling of tasks. |

**Tags:** cognitive, processing

