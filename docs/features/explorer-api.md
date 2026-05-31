# Explorer API

> Provides API endpoints specifically for the Explorer UI to fetch graph snapshots, nodes, neighborhoods, and search results. It facilitates the interaction between the UI and the underlying graph data.

**Repository:** dreamgraph  
**Domain:** infrastructure  
**Status:** active  
**Source files:** explorer/src/api.ts  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| explorer-graph-snapshot | feature | depends_on | strong | Explorer API provides endpoints that utilize the Explorer Graph Snapshot model. |
| graph_snapshot | feature | depends_on | strong | Explorer API interacts with the Graph Snapshot feature to fetch current graph states. |
| search_functionality | feature | depends_on | strong | Explorer API enables the Search Functionality to allow users to search within the knowledge graph. |
| explorer_ui | feature | belongs_to | strong | Explorer API is designed to facilitate interaction with the Explorer UI. |
| dreamgraph-explorer | feature | related_to | moderate | auto-backlink |
| graph_watcher | feature | supports | moderate | auto-backlink |
| filters_panel | feature | related_to | moderate | auto-backlink |
| user_interactions | feature | supports | moderate | auto-backlink |
| explorer-curated-mutation | feature | supports | moderate | auto-backlink |
| explorer-node-record | feature | related_to | moderate | auto-backlink |
| heatmap_result | feature | supports | moderate | auto-backlink |
| capability_ui_semantic_portability | feature | related_to | moderate | auto-backlink |
| dreamgraph_explorer_src | feature | supports | moderate | auto-backlink |

**Tags:** api, explorer, graph

