# DreamGraph MCP Server

> The main server for DreamGraph, which supports two transport modes: stdio and HTTP. It serves as the entry point for the application and manages various routes for API, dashboard, and explorer functionalities.

**Repository:** dreamgraph  
**Domain:** infrastructure  
**Status:** active  
**Source files:** src/index.ts  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| startup_process | feature | initializes | strong | The Startup Process initializes the DreamGraph MCP Server. |
| startup_initialization | feature | initializes | strong | The Startup Initialization Process sets up the DreamGraph server. |
| cli_options | feature | configures | moderate | CLI Options holds configuration for the command-line interface of the DreamGraph server. |
| api_routes | feature | defines | moderate | API Routes defines the REST API endpoints for the DreamGraph application. |
| feature_server_and_dashboard | feature | composes | weak | The Server and Dashboard feature includes HTTP server and dashboard modules under src/server. |
| dreamgraph_src | feature | supports | moderate | auto-backlink |

**Tags:** server, mcp, api

