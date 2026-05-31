# Standalone Architect CLI Bridge

> Standalone Architect Codex CLI and Copilot CLI adapters execute through a daemon-owned MCP bridge. The bridge resolves configured/default CLI binaries before spawning, counts bridge-local run_command during MCP preflight, writes Codex MCP config with TOML-safe dynamic keys, and limits Codex/Copilot MCP server config env to bridge-specific variables so Windows environment names such as CommonProgramFiles(x86) cannot break config.toml loading.

**Repository:** dreamgraph  
**Domain:** core  
**Status:** active  
**Source files:** src/architect/cli-bridge.ts, tests/standalone-architect-routes.test.ts  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| ADR-217 | adr | governed_by | strong | Standalone Architect CLI adapters must execute through a daemon MCP bridge and fail closed when bridge startup or tool authority is unavailable. |
| standalone-architect | feature | related_to | moderate | CLI bridge backs selected standalone Architect adapter execution. |

**Tags:** standalone-architect, codex-cli, copilot-cli, mcp, windows, toml, cli-bridge

