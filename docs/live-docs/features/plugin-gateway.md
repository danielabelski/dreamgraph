# Plugin Gateway

> Historical speculative plugin-domain node retained only as a legacy abstraction label. No current repo evidence establishes a distinct shipped gateway subsystem separate from the v9.0.0 plugin runtime/SDK baseline. Treat references as covered by feature_plugin_runtime and feature_plugin_sdk rather than roadmap or standalone runtime architecture.

**Repository:** dreamgraph  
**Domain:** plugin-system  
**Status:** deprecated  
**Source files:** docs/sdk/plugin-context.md, src/plugins/manager.ts, src/cli/commands/plugin.ts  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| ADR-139 | feature | related_to | strong | ADR-139 establishes the shipped plugin baseline and removes roadmap ambiguity. |
| feature_plugin_runtime | feature | superseded_by | strong | Standalone gateway interpretation is superseded by the canonical plugin runtime feature. |
| feature_plugin_sdk | feature | related_to | moderate | Any prior gateway wording should be interpreted through the shipped SDK/runtime surface. |

