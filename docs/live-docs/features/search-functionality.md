# Search Functionality

> Enables users to search for nodes within the knowledge graph based on various criteria. This feature enhances the user experience by allowing quick access to relevant data.

**Repository:** dreamgraph  
**Domain:** ui  
**Status:** active  
**Source files:** explorer/src/api.ts  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| explorer_api | feature | depends_on | strong | The Search Functionality relies on the Explorer API to fetch search results. |
| filters_panel | feature | composes | moderate | The Search Functionality can utilize the Filters Panel to refine search criteria. |
| explorer_ui | feature | belongs_to | strong | The Search Functionality is a feature of the Explorer UI. |

**Tags:** search, functionality

