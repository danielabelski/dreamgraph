# Heatmap Feature

> Provides a visualization of recent traffic counts for entities within the knowledge graph. This feature helps users identify trends and patterns in the data.

**Repository:** dreamgraph  
**Domain:** ui  
**Status:** active  
**Source files:** explorer/src/Heatmap.tsx  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| explorer_ui | feature | depends_on | strong | The Heatmap Feature provides visualization capabilities that the Explorer UI utilizes. |
| visual_architect | feature | depends_on | moderate | The Heatmap Feature contributes to visual representations within the Visual Architect Tool. |
| graph_snapshot | feature | depends_on | weak | The Heatmap Feature may rely on Graph Snapshots to visualize traffic counts over time. |
| heatmap_result | feature | supports | moderate | auto-backlink |

**Tags:** visualization, heatmap

