# Instance Management

> Handles the lifecycle and management of instances within the DreamGraph application. It provides functionalities for creating, loading, and updating instances.

**Repository:** dreamgraph  
**Domain:** infrastructure  
**Status:** active  
**Source files:** src/instance/index.ts  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| instance | feature | depends_on | strong | Instance Management handles the lifecycle of instances. |
| instance_registry | feature | depends_on | strong | Instance Management relies on the Instance Registry to track active instances. |
| instance_lifecycle_manager | feature | realizes | moderate | Instance Management realizes the functionalities provided by the Instance Lifecycle Manager. |
| api_routes | feature | implements | moderate | Instance Management is implemented through API routes for managing instances. |

**Tags:** instance, management

