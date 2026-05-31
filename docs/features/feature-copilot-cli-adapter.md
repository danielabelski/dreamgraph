# Copilot CLI Architect Adapter

> Runs GitHub Copilot CLI as an Architect provider through a DreamGraph MCP inheritance bridge. The authoritative allowlist now treats bridge-local run_command as part of the live DreamGraph MCP bridge surface even when the upstream daemon registry omits it, so Copilot CLI can advertise and allow dreamgraph(run_command) for workspace-scoped build/test verification while inline shell/write surfaces remain denied.

**Repository:** dreamgraph  
**Domain:** core  
**Status:** active  
**Source files:** extensions/vscode/src/architect-core/adapters/copilot-cli/types.ts, extensions/vscode/src/architect-core/adapters/copilot-cli/allowlist.ts, extensions/vscode/src/architect-core/adapters/copilot-cli/index.ts, extensions/vscode/src/architect-core/adapters/copilot-cli/host/bridge-entry.ts, extensions/vscode/src/architect-core/adapters/copilot-cli/host/registry-adapter.ts, extensions/vscode/src/test/copilot-cli-adapter.test.ts  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| feature-copilot-cli-command-exposure | feature | related_to | moderate | auto-backlink |

**Tags:** copilot-cli, mcp-bridge, tool-exposure, authority-routing, run-command

