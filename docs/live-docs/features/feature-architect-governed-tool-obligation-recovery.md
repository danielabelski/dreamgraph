# Architect governed tool obligation recovery

> Project-scope Architect retry passes can recover missing required DreamGraph MCP obligations by grounding in graph/ADR context, using the governed mutation tools that were skipped, recording evidence back into graph resources, and emitting a continuation envelope rather than relying on provider-native filesystem or shell routes.

**Repository:** dreamgraph  
**Domain:** core  
**Status:** active  
**Source files:** src/architect/native-tool-loop.ts, tests/architect-continuation.test.ts, src/tools/enrich-seed-data.ts, src/tools/solidify-insight.ts, src/tools/api-surface.ts, src/tools/adr-historian.ts  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| workflow_architect_retry_required_governed_tools | workflow | implemented_by | moderate | Retry workflow closes missing governed tool obligations. |
| capability_architect_governed_tool_obligation_recovery | capability | requires | moderate | Capability performs evidence-backed governed recovery. |

**Tags:** architect, governed-tools, mcp, continuation, audit

