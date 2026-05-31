# CLI Tool

> A command-line interface tool that allows users to interact with the DreamGraph application. It provides various commands for managing instances, running workflows, and accessing the API.

**Repository:** dreamgraph  
**Domain:** cli  
**Status:** active  
**Source files:** src/cli/dg.ts  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| feature_cli_command_surface | feature | depends_on | strong | The CLI Tool relies on the CLI Command Surface for executing command-line workflows. |
| cli_options | feature | depends_on | strong | The CLI Tool uses CLI Options to parse and validate user input. |
| instance_management | feature | depends_on | strong | The CLI Tool interacts with Instance Management for managing instances. |
| user_interactions | feature | depends_on | strong | The CLI Tool is involved in managing user interactions with the application. |
| workflow_cli_graph_operations | feature | supports | moderate | auto-backlink |

**Tags:** cli, tool

