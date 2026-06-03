# Architect Plugin Tabs

> Trusted manifest-declared plugins contribute declarative host-rendered standalone Architect tab types with explicit plan connectivity, daemon-owned namespaced plan state, governed schema-validated actions, sidebar summaries, badges, and unload/reload cleanup. Browser clients receive validated descriptors and JSON snapshots only through versioned daemon routes.

**Repository:** dreamgraph  
**Domain:** core  
**Status:** active  
**Source files:** packages/sdk/src/seams/architect.ts, packages/sdk/src/manifest.ts, packages/host/src/context.ts, src/plugins/architect-contributions.ts, src/plugins/architect-plan-state.ts, src/architect/routes.ts, examples/action-checklist/index.js, docs/sdk/plugin-reference/10-architect-tabs.md  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| feature_plugin_sdk | feature | related_to | moderate |  |
| standalone-architect | feature | related_to | moderate |  |
| architect-plan-registry-projection | feature | related_to | moderate |  |
| architect_plugin_tab_snapshot_action | feature | related_to | moderate | auto-backlink |
| capability_architect_plugin_sdk | feature | related_to | moderate | auto-backlink |

