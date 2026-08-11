# Explorer Pulse Overlay

> Render transient visual pulses over graph nodes affected by selected live graph events.

**ID:** `pulse_overlay`  
**Category:** visualization  
**Status:** active  

## Data Contract

### Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| sigmaRef | `React.MutableRefObject<Sigma | null>` | ✅ | Sigma graph renderer used to translate graph node positions into viewport coordinates. |
| pulses | `PulseToken[]` | ✅ | Transient pulse tokens derived from live graph events. |

### Outputs

| Name | Type | Trigger | Description |
|------|------|---------|-------------|
| canvas_overlay | `HTMLCanvasElement` | animation frame | Animated rings drawn over affected graph nodes for the pulse duration. |

## Interactions

- **observe_pulse** — Operator sees graph-node activity from live events without direct interaction.

## Visual Semantics

- **Role:** node activity pulse overlay
- **Emphasis:** secondary
- **Density:** compact
- **Chrome:** embedded

## Layout Semantics

- **Pattern:** inspector
- **Alignment:** centered
- **Sizing behavior:** fill_parent

## Platform Implementations

| Platform | Component | Source File | Notes |
|----------|-----------|-------------|-------|
| web | `PulseOverlay` | explorer/src/PulseOverlay.tsx | As of the schedule-event fix, COLORS covers the full PulseToken kind union, including schedule lifecycle events. |

**Used by features:** explorer_ui, graph-event-stream

**Tags:** explorer, sse, events, pulse, schedule, graph-event-kind
