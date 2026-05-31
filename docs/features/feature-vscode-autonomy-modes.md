# VS Code Autonomy Modes

> VS Code Architect chat exposes user-selectable autonomy modes and bounded pass/time budgets. Header dropdown selections now persist to dreamgraph.architect.autonomyMode so subsequent send, rehydrate, and settings-sync paths keep the user-selected mode instead of reverting from stale configuration.

**Repository:** dreamgraph  
**Domain:** core  
**Status:** active  
**Source files:** extensions/vscode/src/chat-panel.ts, extensions/vscode/src/autonomy.ts, extensions/vscode/src/reporting.ts, extensions/vscode/src/test/slice5-ui.test.ts, docs/features/feature-vscode-autonomy-modes.md  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| vscode_integration | feature | part_of | strong | Autonomy modes are part of the VS Code Architect chat experience. |
| workflow_vscode_autonomy_continuation_loop | workflow | drives | strong | Mode selection controls continuation policy and visible budget counters. |

**Tags:** vscode, architect, autonomy, chat-panel, settings

