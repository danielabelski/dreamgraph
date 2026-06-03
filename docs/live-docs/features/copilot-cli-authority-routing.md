# Copilot CLI Authority Routing

> Routes Copilot CLI turns through the audited DreamGraph MCP authority surface. The provider prompt manifest is derived from the authoritative allowlist used for argv permissions and explicitly overrides generic local-tool fallback language during Copilot CLI runs: source mutations must prefer DreamGraph MCP mutation tools, knowledge changes must use graph mutation tools, command verification must use dreamgraph:run_command, accepted ADRs must be reviewed before repository changes, and required graph updates or new ADRs must be recorded in the same task.

**Repository:** dreamgraph  
**Domain:** core  
**Status:** active  
**Source files:** extensions/vscode/src/architect-core/adapters/copilot-cli/provider-port.ts, extensions/vscode/src/architect-core/adapters/copilot-cli/prompt-serializer.ts, extensions/vscode/src/architect-core/adapters/copilot-cli/allowlist.ts, extensions/vscode/src/architect-core/adapters/copilot-cli/argv.ts, extensions/vscode/src/architect-core/adapters/copilot-cli/host/bridge-entry.ts, extensions/vscode/src/test/copilot-cli-prompt-serializer.test.ts, extensions/vscode/src/test/copilot-cli-provider-port.test.ts  

**Tags:** copilot-cli, tool-exposure, authority-routing, mcp-bridge, mutation-routing, adr-awareness, graph-sync

