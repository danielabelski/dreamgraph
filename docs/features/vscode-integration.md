# VS Code Integration

> Integrates DreamGraph with Visual Studio Code, allowing users to access DreamGraph functionalities directly from the editor. This includes features like graph visualization and cognitive processing.

**Repository:** dreamgraph  
**Domain:** plugin-system  
**Status:** active  
**Source files:** extensions/vscode/*  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| visual_architect | feature | composes | strong | The VS Code Integration allows users to visualize graphs and cognitive processes using the Visual Architect Tool. |
| dreamgraph-explorer | feature | integrates_with | strong | The VS Code Integration includes the DreamGraph Explorer for interactive graph exploration. |
| plugin_management | feature | depends_on | moderate | The VS Code Integration relies on the Plugin Management Process for managing extensions. |
| extensions_management | feature | depends_on | moderate | The VS Code Integration requires Extensions Management for loading and configuring extensions. |
| feature_vscode_autonomy_modes | feature | contains | moderate | auto-backlink |

**Tags:** VS Code, integration

