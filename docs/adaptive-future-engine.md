# Adaptive Future Engine

The Adaptive Future Engine is the preference layer for DreamGraph. It ranks compliant candidate futures using graph evidence, accepted ADRs, workflow context, API/data-model contracts, and learned project preference signals.

It is advisory by design. ADRs, workflow contracts, API surface, and explicit user instructions remain the hard constraints. The engine helps choose among valid futures; it does not create a new enforcement path or a new cognitive lifecycle state.

## What It Adds

- **Candidate-future ranking** — compares plausible next actions instead of treating every valid change as equivalent.
- **Future-fit scoring** — records compact score factors such as evidence coverage, workflow alignment, governance compatibility, blast radius, and reversibility.
- **Future objections** — preserves why a candidate was rejected, including missing evidence, ADR conflicts, weak anchors, or uncertain fallback behavior.
- **Adaptive audit trails** — stores selected and rejected candidate IDs, route/fallback provenance, score factors, evidence anchors, objections, and validation failures without persisting raw prompts or full model responses.
- **Bounded task-class coverage** — classifies planning-doc, adapter, graph-tool, and cognitive-workflow changes for consistent audit metadata.

## Runtime Boundaries

Adaptive Future Engine output is subordinate to:

1. Accepted ADR guard rails.
2. Registered workflows and lifecycle rules.
3. API surface and data-model contracts.
4. Knowledge-graph evidence and provenance.
5. User intent for the current task.

If the engine has insufficient evidence, deterministic fallback behavior must remain available and visible in the audit trail.

## Where It Is Used

The v11 release wires the shared scaffold into graph-tool and cognitive-workflow consumers:

- `src/cognitive/adaptive-future-scaffold.ts` defines task classes, score factors, audit anchors, and deterministic audit helpers.
- `src/tools/enrich-parser-nodes.ts` emits Adaptive Future audit metadata for graph-tool enrichment.
- `src/tools/solidify-insight.ts` carries Adaptive Future audit metadata through cognitive insight solidification.

See also the user-facing guide page: [`guide/14-adaptive-future-engine.md`](../guide/14-adaptive-future-engine.md).
<!-- CONTINUATION TEST SLICE 11 -->
