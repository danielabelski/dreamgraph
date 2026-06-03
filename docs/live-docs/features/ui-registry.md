# UI Registry

> Manages the registration and categorization of UI components within the DreamGraph application. This feature ensures that all UI elements are properly organized and accessible for rendering.

**Repository:** dreamgraph  
**Domain:** ui  
**Status:** active  
**Source files:** src/tools/ui-registry.ts  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| data_model_tool_registry_surface | feature | depends_on | strong | The UI Registry depends on the Tool Registry Surface for managing UI component registrations. |
| feature_graph_tooling_surface | feature | depends_on | strong | The UI Registry depends on the Graph Tooling Surface for handling UI registry functionalities. |
| plugin_registry | feature | depends_on | moderate | The UI Registry is related to the Plugin Registry for managing UI components and plugins. |
| extensions_management | feature | depends_on | weak | The UI Registry may interact with Extensions Management for integrating additional UI functionalities. |
| static_assets | feature | supports | moderate | auto-backlink |
| theme_management | feature | supports | moderate | auto-backlink |
| capability_ui_semantic_portability | feature | supports | moderate | auto-backlink |

**Tags:** ui, registry, management

