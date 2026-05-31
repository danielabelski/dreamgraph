# Plugin SDK

> DreamGraph v9.0.0 shipped SDK surface for plugin authors, including manifest contracts, PluginContext-facing typings, lifecycle activation model, tools/resources/events seams, telemetry guidance, and trust-aware runtime assumptions. It should be treated as active platform surface rather than roadmap intent.

**Repository:** dreamgraph  
**Domain:** core  
**Status:** active  
**Source files:** packages/sdk/package.json, docs/sdk/plugin-developer-guide/00-index.md, docs/sdk/plugin-developer-guide/05-plugin-context.md, docs/sdk/plugin-developer-guide/06-seams-tools-resources.md, docs/sdk/plugin-reference/05-context-api.md  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| ADR-139 | feature | related_to | strong | Release baseline for SDK milestones M0-M6. |
| docs_sdk_plugin_context | feature | supported_by | strong | Canonical PluginContext documentation aligns the SDK surface with the release baseline. |
| feature_plugin_runtime | feature | related_to | moderate | Runtime and SDK surfaces are aligned in the shipped plugin platform. |
| plugin_discovery_process | feature | related_to | moderate | auto-backlink |
| plugin_gateway | feature | related_to | moderate | auto-backlink |
| plugin_session_audit_trail | feature | related_to | moderate | auto-backlink |
| plugin_management | feature | related_to | moderate | auto-backlink |
| plugin_tool_session_orchestrator | feature | related_to | moderate | auto-backlink |

