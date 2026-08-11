# Explorer Event Dock

> Show the live Explorer graph event stream as a compact operator-facing event list with labels, colors, cache-event filtering, and affected entity context.

**ID:** `event_dock`  
**Category:** panel  
**Status:** active  

## Data Contract

### Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| events | `GraphEvent[]` | ✅ | Recent graph events from the Explorer SSE stream, including cognitive, audit, cache, snapshot, and schedule event kinds. |
| connected | `boolean` | ✅ | Whether the EventSource connection is currently open. |

### Outputs

| Name | Type | Trigger | Description |
|------|------|---------|-------------|
| event_rows | `JSX.Element[]` | events update | Rendered event rows with stable labels, colors, timestamps, and affected ids or audit metadata. |
| cache_visibility_preference | `localStorage flag` | cache toggle change | Persisted operator preference for showing high-volume cache.invalidated events. |

## Interactions

- **toggle_open** — Collapse or expand the event list while keeping connection status visible.
- **toggle_cache_events** — Show or hide cache.invalidated events without dropping them from the source stream.

## Visual Semantics

- **Role:** live event timeline
- **Emphasis:** info
- **Density:** compact
- **Chrome:** panel

## Layout Semantics

- **Pattern:** stack
- **Alignment:** leading
- **Sizing behavior:** fluid
- **Responsive behavior:** collapse

## Platform Implementations

| Platform | Component | Source File | Notes |
|----------|-----------|-------------|-------|
| web | `EventDock` | explorer/src/EventDock.tsx | As of the schedule-event fix, KIND_COLORS and KIND_LABELS cover schedule.skipped, schedule.claimed, schedule.executed, schedule.timed_out, and schedule.paused. |

**Used by features:** explorer_ui, graph-event-stream

**Tags:** explorer, sse, events, schedule, graph-event-kind
