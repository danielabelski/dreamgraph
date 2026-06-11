# Architect CLI Terminal Shell

> Provide the terminal-native Architect entry surface for daemon-owned status, plan, runtime, chat, trace, ADR, graph, scheduler, Adaptive Future, and log-mode TUI workflows without becoming repository authority.

**ID:** `architect_cli_terminal_shell`  
**Category:** composite  
**Status:** active  

## Data Contract

### Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| daemon_instance | `string` | ❌ | Instance name or uuid resolved through DreamGraph daemon metadata. |
| subcommand | `string` | ✅ | Architect command family such as status, plans, plan, config, chat, run, trace, adr, graph, schedule, future, or tui. |
| daemon_payload | `object` | ✅ | Daemon-owned Architect API or MCP result consumed for presentation. |

### Outputs

| Name | Type | Trigger | Description |
|------|------|---------|-------------|
| terminal_projection | `text` | command_complete | Compact terminal rendering of daemon-owned Architect state, traces, results, or JSON automation records. |
| json_envelope | `object` | json_flag | Optional automation-friendly daemon result when --json or --json-events is requested. |

## Interactions

- **render** — Render compact status, plan list, lifecycle, and next-slice state from daemon endpoints.
- **submit_and_render** — Send prompt-bearing chat by POST and render normalized content, tool trace, route, runtime, and provenance.
- **dispatch_daemon_command** — Dispatch cancel, pause, and resume through daemon command endpoints only.
- **emit_json** — Preserve JSON and JSON-events output for scripts and CI smoke checks.

## Visual Semantics

- **Role:** terminal Architect control surface
- **Emphasis:** primary
- **Density:** compact
- **Chrome:** minimal

## Layout Semantics

- **Pattern:** shell
- **Alignment:** leading
- **Sizing behavior:** fluid
- **Responsive behavior:** wrap, collapse, scroll

## Platform Implementations

| Platform | Component | Source File | Notes |
|----------|-----------|-------------|-------|
| terminal | `cmdArchitect` | src/cli/commands/architect.ts | Dependency-free log-mode TUI and scriptable command surface over daemon contracts. |
| terminal-ink | `future_ink_renderer` | plans/architect-cli.md | ADR-selected future rich pane renderer; dependency should be added only with renderer implementation and tests. |

**Used by features:** dg architect, architect-cli

**Tags:** architect-cli, terminal, tui, daemon-authority, ink-decision
