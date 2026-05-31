# Plugin Tool Session Orchestrator

> Speculative orchestration node retained only for backward compatibility in graph memory. No direct code or docs evidence indicates a separate shipped subsystem under this name; tool/resource/session behavior should be interpreted through the v9.0.0 plugin runtime, SDK seams, and discovery workflow. Deprecated as standalone architecture.

**Repository:** dreamgraph  
**Domain:** plugin-system  
**Status:** deprecated  
**Source files:** docs/sdk/plugin-developer-guide/06-seams-tools-resources.md, docs/sdk/plugin-developer-guide/10-lifecycle-and-installation.md, src/plugins/manager.ts  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| ADR-139 | feature | related_to | strong | Release baseline resolves planning-era ambiguity. |
| feature_plugin_sdk | feature | superseded_by | strong | SDK seam contracts cover tool/resource participation. |
| feature_plugin_runtime | feature | superseded_by | strong | Runtime activation and context handling cover orchestration semantics. |

