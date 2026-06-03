# Plugin Integration

> Historical broad plugin-domain label retained for compatibility. Current repo evidence does not justify a separate planned integration subsystem; shipped integration semantics are already represented by feature_plugin_runtime, feature_plugin_sdk, and plugin_discovery_process. This node should be treated as deprecated legacy vocabulary.

**Repository:** dreamgraph  
**Domain:** plugin-system  
**Status:** deprecated  
**Source files:** docs/sdk/plugin-developer-guide/10-lifecycle-and-installation.md, docs/sdk/plugin-reference/05-context-api.md, src/plugins/manager.ts  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| ADR-139 | feature | related_to | strong | ADR-139 anchors the shipped integration baseline. |
| feature_plugin_runtime | feature | superseded_by | strong | Runtime lifecycle and loading subsume generic integration wording. |
| plugin_discovery_process | feature | superseded_by | strong | Discovery/load workflow carries the active integration flow. |
| tool_management_integration | feature | depends_on | moderate | auto-backlink |
| api_integration_layer | feature | related_to | moderate | auto-backlink |
| tool_registry_integration | feature | depends_on | moderate | auto-backlink |
| plugin_management | feature | supports | moderate | auto-backlink |
| plugin_manifest | feature | supports | moderate | auto-backlink |

