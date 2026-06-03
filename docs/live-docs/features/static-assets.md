# Static Assets

> Manages the static assets required by the DreamGraph application, including stylesheets, images, and other resources necessary for the UI.

**Repository:** dreamgraph  
**Domain:** ui  
**Status:** active  
**Source files:** src/explorer/static.ts  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| theme_management | feature | depends_on | strong | Static Assets are essential for the theming and styling of the application. |
| ui_registry | feature | depends_on | strong | Static Assets are registered and categorized within the UI components. |
| dashboard_context | feature | depends_on | moderate | Static Assets enhance the usability of the dashboard by providing necessary resources. |
| feature_server_and_dashboard | feature | related_to | moderate | auto-backlink |
| dreamgraph_src_explorer | feature | supports | moderate | auto-backlink |

**Tags:** assets, static, resources

