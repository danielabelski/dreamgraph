# Cognitive Scheduler

> Manages the scheduling of cognitive tasks and workflows, ensuring that processes are executed in a timely manner. This feature enhances the efficiency of the cognitive engine.

**Repository:** dreamgraph  
**Domain:** data-processing  
**Status:** active  
**Source files:** src/cognitive/scheduler.ts  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| cognitive_engine | feature | depends_on | strong | The Cognitive Scheduler manages the scheduling of tasks executed by the Cognitive Engine. |
| cognitive_workflows | feature | manages | strong | The Cognitive Scheduler manages the execution of Cognitive Workflows. |
| cognitive_producers | feature | interacts_with | moderate | The Cognitive Scheduler interacts with Cognitive Producers to manage cognitive task states. |
| cognitive_intervention | feature | related_to | moderate | auto-backlink |
| cognitive_tuning | feature | related_to | moderate | auto-backlink |
| cognitive_registry | feature | supports | moderate | auto-backlink |
| cognitive_workflow_management | feature | supports | moderate | auto-backlink |

**Tags:** cognitive, scheduling, management

