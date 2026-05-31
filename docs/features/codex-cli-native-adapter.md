# Codex CLI Native Adapter

> Native Codex CLI Architect provider adapter that runs Codex through an isolated DreamGraph MCP bridge. The adapter now writes both CODEX_HOME config.toml and authoritative -c mcp_servers.dreamgraph.* overrides, records bridge-probe metadata in the run manifest, and projects Codex JSON MCP events into final DreamGraph tool trace when bridge audit data is empty.

**Repository:** dreamgraph  
**Domain:** core  
**Status:** active  
**Source files:** extensions/vscode/src/architect-core/adapters/codex-cli/mcp-config.ts, extensions/vscode/src/architect-core/adapters/codex-cli/orchestrator.ts, extensions/vscode/src/architect-core/adapters/codex-cli/transcript.ts, extensions/vscode/src/test/codex-cli-adapter.test.ts, extensions/vscode/src/test/codex-cli-orchestrator.test.ts  

**Tags:** codex-cli, mcp, tool-trace, vscode-extension

