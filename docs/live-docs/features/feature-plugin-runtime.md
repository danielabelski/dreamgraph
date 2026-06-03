# Plugin Runtime

> DreamGraph v9.0.0 authoritative plugin runtime baseline for loaded, trusted in-process plugins. The runtime is active and shipped, not pending future host loading. It provides PluginContext, lifecycle integration, plugin inventory, trust-aware enablement, hot reload/introspection seams, and host-mediated access boundaries consistent with ADR-139.

**Repository:** dreamgraph  
**Domain:** core  
**Status:** active  
**Source files:** src/plugins/manager.ts, src/cli/commands/plugin.ts, docs/sdk/plugin-context.md, docs/sdk/plugin-developer-guide/05-plugin-context.md, docs/sdk/plugin-reference/05-context-api.md  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| ADR-139 | feature | related_to | strong | Release baseline establishing M0-M6 as complete in v9.0.0. |
| docs_sdk_plugin_context | feature | supported_by | strong | Canonical documentation entry for PluginContext baseline. |
| feature_plugin_sdk | feature | related_to | moderate | SDK declarations and developer-facing contracts align with the shipped runtime. |
| plugin_discovery_process | feature | supports | moderate | auto-backlink |
| plugin_integration | feature | related_to | moderate | auto-backlink |
| plugin_gateway | feature | related_to | moderate | auto-backlink |
| plugin_session_bridge | feature | related_to | moderate | auto-backlink |
| plugin_session_audit_trail | feature | related_to | moderate | auto-backlink |
| cognitive_plugin_bridge | feature | related_to | moderate | auto-backlink |
| plugin_management | feature | related_to | moderate | auto-backlink |
| plugin_tool_session_orchestrator | feature | related_to | moderate | auto-backlink |
| dreamgraph_src_plugins | feature | supports | moderate | auto-backlink |

