# Event Dock

> A component of the Explorer UI that displays events related to the knowledge graph, allowing users to track changes and interactions in real-time.

**Repository:** dreamgraph  
**Domain:** ui  
**Status:** active  
**Source files:** explorer/src/EventDock.tsx  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| explorer_ui | feature | belongs_to | strong | Event Dock is a component of the Explorer UI. |
| event_monitoring_layer | feature | depends_on | moderate | Event Dock relies on the Event Monitoring Layer for capturing and analyzing events. |
| event_logging | feature | depends_on | weak | Event Dock may utilize Event Logging to track significant actions and changes. |
| event_dashboard | feature | composes | weak | Event Dock may be part of the Event Dashboard for visualizing event analytics. |
| graph_watcher | feature | related_to | moderate | auto-backlink |
| dreamgraph_explorer_src | feature | related_to | moderate | auto-backlink |

**Tags:** events, ui, real-time

