# Discipline Tools

> Provides various tools and utilities for managing disciplines within the DreamGraph application. This feature includes functionalities for handling artifacts, prompts, and session management.

**Repository:** dreamgraph  
**Domain:** discipline  
**Status:** active  
**Source files:** src/discipline/tools.ts  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| dreamgraph_src_discipline | feature | depends_on | strong | Discipline Tools provides functionalities for managing disciplines, which are part of the Discipline feature. |
| session_management | feature | depends_on | strong | Discipline Tools includes functionalities for session management. |
| artifacts | feature | manages | moderate | Discipline Tools handles artifacts related to disciplines. |
| feature_discipline_system | feature | related_to | moderate | auto-backlink |
| state_machine | feature | related_to | moderate | auto-backlink |

**Tags:** discipline, tools, management

