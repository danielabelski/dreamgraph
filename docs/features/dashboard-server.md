# Dashboard Server

> Handles the dashboard functionalities of the DreamGraph application, providing a user interface for monitoring and managing instances. It integrates with the main server to deliver real-time updates.

**Repository:** dreamgraph  
**Domain:** ui  
**Status:** active  
**Source files:** src/server/dashboard.ts  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| feature_server_and_dashboard | feature | depends_on | strong | The Dashboard Server depends on the Server and Dashboard feature for its functionalities. |
| dashboard_route | feature | realizes | moderate | The Dashboard Route realizes the routing functionalities needed by the Dashboard Server. |
| dashboard_context | feature | composes | moderate | The Dashboard Context composes the data context required for the Dashboard Server. |
| dreamgraph_src_server | feature | supports | moderate | auto-backlink |

**Tags:** dashboard, ui, monitoring

