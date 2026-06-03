# Cognitive Plugin Bridge

> Speculative bridge concept between cognitive subsystems and plugins. Current repo evidence does not establish a distinct shipped architectural component by this name. Interpret historical references through the canonical plugin runtime/SDK baseline only when directly evidenced by code or docs; otherwise treat as deprecated speculative graph vocabulary.

**Repository:** dreamgraph  
**Domain:** plugin-system  
**Status:** deprecated  
**Source files:** src/cognitive/intervention.ts, src/plugins/manager.ts, docs/sdk/plugin-context.md  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| ADR-139 | feature | related_to | strong | Release baseline rejects roadmap-era overreach beyond evidenced plugin capabilities. |
| feature_plugin_runtime | feature | related_to | moderate | Any real plugin bridge behavior must be grounded in the shipped runtime surface. |
| feature_cognitive_runtime | feature | related_to | moderate | Potential cognitive interactions remain bounded by existing runtime surfaces, not a separate bridge subsystem. |

