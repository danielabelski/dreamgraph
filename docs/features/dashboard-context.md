# Dashboard Context

> Manages the context for the dashboard component of the DreamGraph application, ensuring that relevant data is displayed to users. This feature enhances the usability of the dashboard.

**Repository:** dreamgraph  
**Domain:** infrastructure  
**Status:** active  
**Source files:** src/server/dashboard.js  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| dashboard_route | feature | depends_on | strong | The Dashboard Context manages the context for the dashboard, which relies on the routing handled by the Dashboard Route. |
| dashboard_server | feature | depends_on | strong | The Dashboard Context is integral to the functionalities provided by the Dashboard Server. |
| static_assets | feature | supports | moderate | auto-backlink |

**Tags:** dashboard, context, management

