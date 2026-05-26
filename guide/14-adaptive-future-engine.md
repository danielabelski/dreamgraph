# 14. Adaptive Future Engine

Adaptive Future Engine is DreamGraph's v11 layer for choosing better next steps from the futures that are already allowed by your project graph.

It does not replace ADRs, workflows, API contracts, or your instructions. It sits underneath the Architect and helps rank candidate futures using evidence already in the graph.

## When You Notice It

Most users see Adaptive Future Engine indirectly:

- The Architect can explain why one candidate action is a better fit than another.
- Graph-tool enrichment records compact audit metadata for selected and rejected candidates.
- Cognitive insight solidification keeps route and fallback provenance attached to the recommendation.
- Release, planning, and repair workflows can preserve why a path was chosen without dumping raw model prompts or full responses into project state.

## How To Ask For It

Use normal Architect language:

```text
Compare the safe futures for this change and explain why you prefer the selected path.
```

```text
Show the Adaptive Future audit trail for this remediation decision.
```

```text
Before changing this workflow, check ADRs, graph evidence, and candidate objections.
```

## How To Read The Result

A good Adaptive Future answer should tell you:

- which candidate future was selected;
- which candidates were rejected;
- which evidence anchors mattered;
- which objections were found;
- whether deterministic fallback was used;
- whether any validation failure kept the result advisory only.

## Important Boundary

Adaptive Future Engine is advisory. If it suggests something that conflicts with an accepted ADR, workflow contract, API surface, or explicit user instruction, the higher-authority constraint wins.

Next: return to the [daily workflow](10-daily-workflow.md) or the [glossary](13-glossary.md).
