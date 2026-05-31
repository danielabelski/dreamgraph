# Copilot CLI Command Tool Exposure

> Copilot CLI adapter exposes command execution through two explicit provenance routes: cli:powershell for Copilot-native shell execution and dreamgraph:run_command for DreamGraph-mediated, workspace-constrained MCP command execution. The effective tool catalogue merges upstream DreamGraph tools with bridge-local run_command and advertises unavailable routes with policy reasons instead of implying commands do not exist.

**Repository:** dreamgraph  
**Domain:** core  
**Status:** active  
**Source files:** extensions/vscode/src/architect-core/adapters/copilot-cli/types.ts, extensions/vscode/src/architect-core/adapters/copilot-cli/argv.ts, extensions/vscode/src/architect-core/adapters/copilot-cli/prompt-serializer.ts, extensions/vscode/src/architect-core/adapters/copilot-cli/provider-port.ts, extensions/vscode/src/architect-core/adapters/copilot-cli/orchestrator.ts, extensions/vscode/src/architect-core/adapters/copilot-cli/host/bridge-entry.ts  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| feature-copilot-cli-adapter | feature | related_to | moderate |  |

**Tags:** copilot-cli, mcp, tool-exposure, command-execution, security

