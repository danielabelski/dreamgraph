# Standalone Architect Terminal

> Provide a daemon-owned xterm.js project terminal in the Standalone Architect center workspace, with WebSocket-backed input/output, FitAddon resize propagation, compact status/rename controls, explicit console focus, outside-pointer blur, and local terminal output scoped as convenience output rather than repository authority.

**ID:** `standalone_architect_terminal`  
**Category:** data_input  
**Status:** active  

## Data Contract

### Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| terminal_session | `object` | ✅ | Daemon terminal session snapshot containing id, title, cwd, shell, dimensions, state, connection state, and authority metadata. |
| terminal_websocket_messages | `stream<object>` | ✅ | Bidirectional WebSocket messages on /api/architect/v1/terminal/:id carrying snapshot, data, resize, error, and exit events. |
| xterm_assets | `object` | ✅ | Daemon-served @xterm/xterm and @xterm/addon-fit browser assets used to render and fit the terminal surface. |

### Outputs

| Name | Type | Trigger | Description |
|------|------|---------|-------------|
| terminal_input | `string` | on_xterm_data | Raw xterm input data forwarded to the daemon terminal WebSocket. |
| terminal_resize | `object` | on_fit_or_layout_resize | Current terminal columns and rows emitted after FitAddon fitting. |
| terminal_rename | `string` | on_click | Updated terminal title sent to the daemon rename route. |
| terminal_close | `string` | on_tab_close | Terminal session id requested for daemon cleanup when the dynamic tab closes. |

## Interactions

- **focus_terminal** — Clicking the terminal console focuses the xterm instance.
- **leave_terminal_focus** — Pointer interaction outside the terminal console blurs xterm so the rest of the Architect UI can receive focus and clicks.
- **type_interactively** — Keystrokes, control sequences, arrows, and Ctrl+C flow through xterm onData to the terminal WebSocket while xterm is focused.
- **stream_output** — WebSocket data messages write PTY output directly into xterm.
- **resize_terminal** — Tab activation, window resize, and container resize refit xterm and send bounded PTY dimensions.
- **rename_terminal** — Rename updates the daemon session title and tab label.

## Visual Semantics

- **Role:** embedded terminal
- **Emphasis:** primary
- **Density:** compact
- **Chrome:** embedded

### State Styling

- **focused** — xterm cursor and keyboard focus remain inside the terminal viewport
- **blurred** — terminal keeps its output visible while keyboard focus returns to the surrounding Architect UI
- **closed** — status reports terminal closed with exit code when available
- **asset_error** — fallback message appears over the terminal surface

## Layout Semantics

- **Pattern:** shell
- **Alignment:** leading
- **Sizing behavior:** fill_parent
- **Responsive behavior:** scroll

### Layout Hierarchy

- **terminal_status_toolbar** — auxiliary
- **xterm_viewport** — primary

## Platform Implementations

| Platform | Component | Source File | Notes |
|----------|-----------|-------------|-------|
| html | `renderTerminalArchitectTabPanel` | src/architect/routes.ts | Creates an xterm mount, loads FitAddon, connects /api/architect/v1/terminal/:id, forwards onData input, writes data messages, refits on activation/layout changes, focuses on console click, and blurs xterm on outside pointer interaction. |
| node | `createArchitectTerminalSession` | src/architect/routes.ts | Starts a node-pty shell in the project root and streams PTY data through WebSocket terminal sessions. |

**Used by features:** standalone_architect_chat

**Tags:** standalone-architect, terminal, dynamic-tabs, keyboard, shell, xterm, websocket, node-pty, focus-management
