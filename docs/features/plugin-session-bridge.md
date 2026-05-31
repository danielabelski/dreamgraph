# Plugin Session Bridge

> Speculative plugin-session bridge node lacks direct repo evidence as a distinct shipped subsystem. If referenced historically, interpret it as an informal label for runtime context/lifecycle coordination already covered by PluginContext and plugin discovery/loading. Deprecated in favor of canonical runtime and workflow nodes.

**Repository:** dreamgraph  
**Domain:** plugin-system  
**Status:** deprecated  
**Source files:** docs/sdk/plugin-context.md, docs/sdk/plugin-reference/05-context-api.md, src/plugins/manager.ts  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| ADR-139 | feature | related_to | strong | Release baseline removes need for speculative bridge framing. |
| feature_plugin_runtime | feature | superseded_by | strong | PluginContext/lifecycle coordination belongs to the runtime surface. |
| docs_sdk_plugin_context | feature | supported_by | strong | Canonical PluginContext documentation provides the authoritative interpretation. |

