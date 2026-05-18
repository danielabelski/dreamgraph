# Demo Script: Zero-Context `fix my codebase`

## Demo promise

Start with a broken project, an empty DreamGraph graph, and one vague prompt:

> fix my codebase

End with:

- discovered project health checks,
- diagnosed failures,
- applied fixes,
- verified clean-by-checks state,
- a newly generated semantic project graph.

The message is simple:

> DreamGraph figures out what “broken” means.

## Why this demo matters

Most AI coding tools need the user to provide the error, the relevant files, and the intended fix. This demo proves a higher-level workflow: DreamGraph can attach to an unknown repo, inspect it, construct context, repair it, and preserve the reasoning trail.

This is not autocomplete. It is project repair plus project understanding.

## Setup

Use a small intentionally broken app, ideally React/Vite or another project with fast checks.

Required starting state:

- fresh DreamGraph instance,
- empty or uninitialized graph,
- only the project directory path attached,
- at least one real project health failure,
- no user-provided stack trace or file hint.

Recommended seeded failure examples:

- lint error caused by React Fast Refresh export rules,
- conditional React Hook call,
- TypeScript type error,
- failing unit test,
- missing environment/config validation.

For the canonical first demo, use the proven run:

- `npm test` not configured,
- `npm run build` passes,
- `npm run lint` fails,
- two concrete React/ESLint issues are repaired,
- `npm run lint` passes after patching.

## Demo flow

### 1. Show zero context

Show the fresh instance before the prompt:

- empty graph,
- no prior chat state,
- no known project summary,
- no defined error.

Narration:

> We are not giving DreamGraph the bug. We are only giving it the repo.

### 2. Send the prompt

Prompt:

```text
fix my codebase
```

Do not add any other instructions.

Narration:

> This is the actual vibe-coder prompt. No stack trace, no file path, no issue ticket.

### 3. Let DreamGraph discover health checks

Expected behavior:

- inspect project structure,
- detect package/ecosystem,
- discover available scripts,
- run relevant checks,
- report what is missing, passing, and failing.

For the proven run, DreamGraph discovered:

- `npm test` missing,
- `npm run build` passing,
- `npm run lint` failing.

Narration:

> DreamGraph first defines what “fixed” can mean for this repo by discovering the available checks.

### 4. Show diagnosis

Expected behavior:

- classify failures,
- identify concrete files and rules,
- avoid pretending the codebase is fixed before patching.

For the proven run, DreamGraph identified:

- `CartContext.jsx` violating `react-refresh/only-export-components`,
- `BookingPage.jsx` violating React Hook ordering by calling `useMemo` conditionally.

Narration:

> The system does not hallucinate a generic answer. It grounds diagnosis in command output and file-level evidence.

### 5. Approve repair or enable bounded autonomy

User action:

```text
Fix the two ESLint errors
```

Expected behavior:

- create or modify the smallest necessary files,
- preserve behavior,
- continue through bounded repair passes if needed,
- avoid unrelated rewrites.

Narration:

> Approval turns the diagnosis into a repair loop: patch, verify, continue only while evidence supports it.

### 6. Show verification

Expected behavior:

- rerun the failing check,
- report final status,
- distinguish clean-by-checks from deeper possible improvements.

For the proven run:

- `npm run lint` passed after the fix.

Narration:

> The workflow ends with proof, not confidence language.

### 7. Reveal graph genesis

After the repair, open the graph.

Show that DreamGraph generated meaningful entities and relationships from an empty starting point, such as:

- startup initialization,
- navigation flow,
- data loading,
- settings persistence,
- error handling,
- build/deploy flow,
- feature hubs,
- candidate relationships,
- dream/tension edges,
- rejected hypotheses with evidence.

Narration:

> This is the real differentiator. DreamGraph did not just fix two files. It created the project brain it needed to reason about the repo.

## Key screenshots or clips to capture

1. Empty graph before the prompt.
2. The exact prompt: `fix my codebase`.
3. Health-check discovery output.
4. Diagnosis showing concrete failing files/rules.
5. Patch or diff view.
6. Verification command passing.
7. Graph after repair, with generated concepts and relationships visible.
8. Final repair summary.

## Talk track

Short version:

> We attached DreamGraph to a broken repo with an empty graph and typed only “fix my codebase.” DreamGraph discovered what checks existed, found the failing lint rules, repaired the code, verified the result, and generated a semantic project graph along the way. That is the difference between an AI coding assistant and a project-aware repair engine.

Long version:

> Most AI tools are reactive. They wait for an error message or a precisely scoped request. DreamGraph is designed for ambiguous, real developer intent. When the user says “fix my codebase,” DreamGraph treats that as a project-level operation: inspect, scan, enrich, diagnose, patch, verify, and remember. The graph that appears after the run is not decorative. It is the durable understanding layer that lets future AI work start from project memory instead of a blank prompt.

## Positioning lines

Use one of these in promotional material:

- “From zero context to verified repair.”
- “Give DreamGraph a repo and one prompt: `fix my codebase`.”
- “DreamGraph figures out what broken means.”
- “AI coding tools edit files. DreamGraph repairs projects.”
- “The project brain builds itself while it works.”

## Success criteria

The demo succeeds when DreamGraph:

- starts from an empty graph,
- receives only `fix my codebase`,
- discovers available checks,
- identifies at least one concrete failure,
- applies a targeted patch after approval or in bounded autonomous mode,
- reruns the relevant check,
- reaches a passing state or reports a concrete blocker,
- produces a useful graph that did not exist before.

## Failure modes to handle transparently

If a repo has no runnable checks:

- report that no build/lint/test/typecheck entrypoint was found,
- inspect likely config and source hotspots,
- propose adding a minimal health-check script,
- do not claim clean status.

If checks require secrets or services:

- identify the missing prerequisite,
- classify as blocked,
- continue with static checks where safe.

If the repair is large:

- create a remediation plan,
- patch in ordered batches,
- verify after each batch,
- stop before unsafe rewrites.

## Product follow-ups

This demo should drive concrete product surfaces:

1. **Fix My Codebase button** in first-run onboarding.
2. **Repair ledger** card showing issue, evidence, fix, verification, and status.
3. **Graph genesis badge** when a useful graph is created from an empty state.
4. **Clean by available checks** final state label.
5. **Architectural follow-up** section for deeper graph/dream tensions after checks pass.

## Final line

> The ultimate onboarding test is no longer “Can the AI answer a question?” It is “Can it attach to an unknown project, understand it, fix it, prove it, and remember what it learned?”
