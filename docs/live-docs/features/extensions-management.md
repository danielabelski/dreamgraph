# Extensions Management

> Manages the loading and configuration of extensions within the DreamGraph application. This feature allows for the integration of additional functionalities and tools.

**Repository:** dreamgraph  
**Domain:** plugin-system  
**Status:** active  
**Source files:** extensions/*  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| plugin_registry | feature | depends_on | strong | Extensions Management relies on the Plugin Registry for managing available plugins. |
| plugin_tools | feature | composes | moderate | Extensions Management utilizes Plugin Tools to interact with plugins. |
| plugin_management | feature | depends_on | strong | Extensions Management is dependent on the Plugin Management Process for enabling and disabling plugins. |
| plugin_discovery | feature | depends_on | strong | Extensions Management relies on the Plugin Discovery Process to identify and load plugins. |
| ui_registry | feature | supports | moderate | auto-backlink |
| vscode_integration | feature | supports | moderate | auto-backlink |

**Tags:** extensions, management

