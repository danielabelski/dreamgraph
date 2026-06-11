# Standalone Architect Continuation Report

> Render the daemon-produced pass report for a bounded Architect continuation pass before any next pass can be selected.

**ID:** `standalone_architect_continuation_report`  
**Category:** data_display  
**Status:** active  

## Data Contract

### Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| pass_report | `ArchitectPassReport` | ✅ | Structured report parsed from the assistant continuation envelope. |
| continuation | `ArchitectContinuationDecision metadata` | ❌ | Host decision metadata for the next continuation state. |
| runtime | `ArchitectRuntimeRouteContext` | ❌ | Runtime provenance shown in the report. |

### Outputs

| Name | Type | Trigger | Description |
|------|------|---------|-------------|
| rendered_report | `DOM section` | chat response render | Structured pass report section appended to the assistant message. |

## Interactions

- **display** — Displays pass report sections in stable order in the chat message body.

## Visual Semantics

- **Role:** structured pass report
- **Emphasis:** info
- **Density:** compact
- **Chrome:** embedded

## Layout Semantics

- **Pattern:** stack
- **Alignment:** leading
- **Sizing behavior:** fluid

## Platform Implementations

| Platform | Component | Source File | Notes |
|----------|-----------|-------------|-------|
| standalone-web | `renderArchitectContinuationReport` | src/architect/routes.ts | - |

**Used by features:** architect-continuation

**Tags:** architect, continuation, slice-4
