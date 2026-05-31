# API Routes

> Defines the REST API endpoints for the DreamGraph application, enabling communication between the server and client. It includes endpoints for instance management, graph context enrichment, and validation.

**Repository:** dreamgraph  
**Domain:** infrastructure  
**Status:** active  
**Source files:** src/api/routes.ts  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| api_surface | feature | depends_on | strong | API Routes defines the endpoints that the API Surface describes. |
| feature_api_routes_surface | feature | realizes | strong | API Routes Surface implements the routing surface defined in API Routes. |
| dreamgraph_src_api_routes | feature | manages | strong | API Routes manages the routing for the API exposure flow. |
| dreamgraph_server | feature | depends_on | moderate | API Routes are part of the main server's routing capabilities. |

**Tags:** api, http

