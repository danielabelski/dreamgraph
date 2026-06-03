# Dashboard Route

> Handles the routing for the dashboard component of the DreamGraph application. It integrates with the main server to provide a comprehensive view of the system's status and metrics.

**Repository:** dreamgraph  
**Domain:** infrastructure  
**Status:** active  
**Source files:** src/server/dashboard.js  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| dashboard_context | feature | depends_on | strong | The Dashboard Route depends on the Dashboard Context to display relevant data to users. |
| dashboard_server | feature | integrates_with | strong | The Dashboard Route integrates with the Dashboard Server to provide dashboard functionalities. |
| feature_server_and_dashboard | feature | composes | moderate | The Dashboard Route is part of the Server and Dashboard feature that includes routing functionalities. |

**Tags:** dashboard, routing

