# Standalone Architect Terminal Tab

> Provides an embedded project-root terminal inside the standalone Architect center workspace while keeping browser navigation, tab controls, and non-terminal focus outside terminal ownership.

**ID:** `standalone_architect_terminal_tab`  
**Category:** composite  
**Status:** active  

## Data Contract

### Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| terminal_session | `ArchitectTerminalSession` | ✅ | Daemon-owned terminal session snapshot and WebSocket transport metadata. |
| terminal_input | `string` | ❌ | User keystrokes emitted by xterm while the terminal surface has focus. |

### Outputs

| Name | Type | Trigger | Description |
|------|------|---------|-------------|
| terminal_resize | `{ cols: number; rows: number }` | xterm_fit | Resize message sent after visible terminal layout changes. |
| terminal_input | `{ type: 'input'; data: string }` | xterm_onData | Interactive terminal input sent over the terminal WebSocket. |

## Interactions

- **focus_terminal** — Clicking inside the terminal surface focuses xterm.
- **leave_terminal** — Focusing other controls blurs the terminal so tabs and buttons remain usable.
- **switch_tab** — Switching away hides and blurs inactive terminal tabs.
- **rename_terminal** — Rename button updates the daemon terminal title.

## Visual Semantics

- **Role:** embedded terminal
- **Emphasis:** primary
- **Density:** compact
- **Chrome:** embedded

### State Styling

- **inactive** — hidden and pointer-inert
- **focused** — terminal owns keyboard input only after direct surface click

## Layout Semantics

- **Pattern:** shell
- **Alignment:** leading
- **Sizing behavior:** fill_parent
- **Responsive behavior:** collapse

### Layout Hierarchy

- **toolbar** — secondary
- **terminal_surface** — primary

## Platform Implementations

| Platform | Component | Source File | Notes |
|----------|-----------|-------------|-------|
| html | `xterm.js terminal panel` | src/architect/routes.ts | Terminal focus is opt-in on terminal surface pointerdown; inactive terminal tabs are blurred and hidden panels disable pointer events. |

**Used by features:** shell-integration

**Tags:** architect, terminal, xterm, shell-integration, focus-management
