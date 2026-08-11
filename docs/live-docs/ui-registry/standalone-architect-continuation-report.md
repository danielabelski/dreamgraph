# Standalone Architect Continuation Report

> Render completed Architect pass reports with readable summaries, touched evidence, continuation choices, and compact tool execution rows without dumping raw JSON inline.

**ID:** `standalone_architect_continuation_report`  
**Category:** chat-ui  
**Status:** active  

## Data Contract

### Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| pass_report | `ArchitectContinuationEnvelope.pass_report` | ✅ | Structured pass report containing summary, work_completed, files_touched, graph_entities_touched, tool_trace_summary, evidence, blockers, and recommended actions. |

### Outputs

| Name | Type | Trigger | Description |
|------|------|---------|-------------|
| rendered_continuation_report | `DOM section` | architect chat result with continuation metadata | A visible pass report panel with semantic sections and compact rendered tool rows. |

## Interactions

- **inspect_tool_details** — User expands an individual rendered tool row details disclosure to inspect the preserved structured payload.
- **continue_pass** — User selects a continuation option pill when a safe next action is available.

## Visual Semantics

- **Role:** pass report
- **Emphasis:** secondary
- **Density:** compact
- **Chrome:** panel

## Layout Semantics

- **Pattern:** stack
- **Alignment:** leading
- **Sizing behavior:** fluid
- **Responsive behavior:** wrap, scroll

## Platform Implementations

| Platform | Component | Source File | Notes |
|----------|-----------|-------------|-------|
| standalone-web | `renderArchitectContinuationReport` | src/architect/routes.ts | - |
| browser | `renderArchitectContinuationReport / appendContinuationList / parseContinuationToolLine` | src/architect/routes.ts | Continuation report Work Completed and Tool Trace arrays use compact rendered rows for tool-like entries; details remain collapsed by default. |

**Used by features:** architect-continuation

**Tags:** standalone-architect, continuation, tool-trace, pass-report, renderer
