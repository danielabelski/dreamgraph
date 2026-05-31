# Plugin Management

> Legacy umbrella node for plugin inventory and operator interactions. In the shipped v9.0.0 baseline, plugin management concerns are realized through the plugin CLI/operator flows and runtime inventory rather than a separate speculative subsystem. Treat this node as a deprecated alias for the canonical runtime/SDK management surface.

**Repository:** dreamgraph  
**Domain:** plugin-system  
**Status:** deprecated  
**Source files:** src/cli/commands/plugin.ts, src/plugins/manager.ts, RELEASE_NOTES_v9.0.0.md  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| ADR-139 | feature | related_to | strong | Release baseline clarifies shipped operator/runtime scope. |
| feature_plugin_runtime | feature | superseded_by | strong | Runtime inventory and trust-aware enablement cover management semantics. |
| feature_plugin_sdk | feature | related_to | moderate | Developer-facing management assumptions belong to the shipped SDK/runtime model. |

