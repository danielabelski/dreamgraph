# Incremental Evidence Lifecycle

> Incremental Evidence Lifecycle is a parser-node evidenced from src/tools/scan-project.ts, src/tools/scan-state.ts. Its declared fields, source provenance, and explicit links define how it participates in the project while semantic model output is unavailable. This evidence-only account is intentionally provisional and will be replaced by the next successful LLM enrichment pass.

**Trigger:** Explicit scan_project mode=incremental or dg scan --incremental request after a compatible full baseline  
**Source files:** src/tools/scan-project.ts, src/tools/scan-state.ts, src/tools/incremental-reconciliation.ts, src/tools/graph-health.ts, src/cli/commands/scan.ts, docs/workflows/workflow-project-scan-enrichment.md  

## Flowchart

```mermaid
flowchart TD
    S1["Validate scan-state baseline compatibility"]
    S2["Classify repository content evidence"]
    S1 --> S2
    S3["Capture and parse only material files"]
    S2 --> S3
    S4["Reconcile supporters and semantic validity"]
    S3 --> S4
    S5["Commit atomically with scan-state publication last"]
    S4 --> S5
    S6["Return bounded metrics and optional explicit enrichment"]
    S5 --> S6
```

## Steps

### 1. Validate scan-state baseline compatibility

### 2. Classify repository content evidence

### 3. Capture and parse only material files

### 4. Reconcile supporters and semantic validity

### 5. Commit atomically with scan-state publication last

### 6. Return bounded metrics and optional explicit enrichment

