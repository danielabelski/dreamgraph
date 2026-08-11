# Standalone Architect Daemon Routes

> Daemon-owned HTTP routing surface for the standalone Architect browser shell and versioned /api/architect/v1 contract. The route handler serves the app shell, assets, status/config/chat/plan/event endpoints, terminal upgrade handling, and rejects unknown Architect API paths through daemon-controlled responses rather than browser-owned filesystem or graph authority.

**Repository:** dreamgraph  
**Domain:** architect  
**Status:** active  
**Source files:** src/architect/routes.ts  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| ADR-208 | architecture_decision | implements_boundary | moderate | Versioned daemon-governed /api/architect contract. |
| ADR-215 | architecture_decision | constrained_by | moderate | POST-only prompt-bearing chat transport. |
| ADR-216 | architecture_decision | constrained_by | moderate | Daemon-owned runtime identity in route payloads. |

**Tags:** standalone-architect, daemon-routes, api-contract, browser-control-plane, governed-intents

