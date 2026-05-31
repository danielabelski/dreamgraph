# Explorer UI

> A user interface component that allows users to visualize and interact with the knowledge graph. It provides various panels and tools for searching, filtering, and inspecting graph data.

**Repository:** dreamgraph  
**Domain:** ui  
**Status:** active  
**Source files:** explorer/src/App.tsx, explorer/src/GraphCanvas.tsx, explorer/src/Graph3DCanvas.tsx, explorer/src/FiltersPanel.tsx, explorer/src/CandidatesPanel.tsx  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| filters_panel | feature | composes | strong | The Filters Panel provides filtering capabilities for the Explorer UI. |
| event_dock | feature | belongs_to | strong | The Event Dock is a component of the Explorer UI that displays events related to the knowledge graph. |
| explorer_api | feature | depends_on | strong | The Explorer UI relies on the Explorer API to fetch graph data. |
| search_functionality | feature | composes | strong | The Search Functionality enhances the Explorer UI by allowing users to search for nodes. |
| visual_architect | feature | related_to | moderate | auto-backlink |
| dreamgraph-explorer | feature | related_to | moderate | auto-backlink |
| theme_management | feature | related_to | moderate | auto-backlink |
| heatmap_feature | feature | supports | moderate | auto-backlink |
| navigation | feature | supports | moderate | auto-backlink |
| explorer-curated-mutation | feature | supports | moderate | auto-backlink |
| navigation_flow | feature | related_to | moderate | auto-backlink |
| explorer-node-record | feature | related_to | moderate | auto-backlink |
| dreamgraph_explorer_src | feature | related_to | moderate | auto-backlink |

**Tags:** ui, visualization, graph

