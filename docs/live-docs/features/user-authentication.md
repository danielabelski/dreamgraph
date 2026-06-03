# User Authentication

> Handles user authentication and authorization within the DreamGraph application. It ensures that users have the appropriate permissions to access and modify data.

**Repository:** dreamgraph  
**Domain:** infrastructure  
**Status:** active  
**Source files:** src/explorer/auth.ts  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| user_auth | feature | depends_on | strong | User Authentication handles user authentication processes. |
| user_auth_layer | feature | depends_on | strong | User Authentication relies on the User Authentication Layer for managing authentication across services. |
| api_authentication | feature | depends_on | strong | User Authentication utilizes the API Authentication Layer for managing API access. |
| data_store | feature | supports | moderate | auto-backlink |
| session_management | feature | supports | moderate | auto-backlink |
| authentication_pipeline | feature | supports | moderate | auto-backlink |
| dreamgraph_src_explorer | feature | supports | moderate | auto-backlink |

**Tags:** authentication, authorization, security

