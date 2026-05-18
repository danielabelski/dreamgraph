# Case Study: `fix my codebase`

## The prompt

A vibe coder attached a fresh DreamGraph instance to a broken project and typed only:

> fix my codebase

There was no previous DreamGraph state, no populated graph, no known error definition, and no explicit instruction about what “fixed” should mean.

## Why this matters

This is the core test for next-generation AI developer tooling. Most AI assistants can edit code when handed an error message. DreamGraph must go further:

1. infer what “broken” means from the project itself,
2. discover the project’s health checks,
3. run those checks,
4. classify failures,
5. propose or apply targeted fixes,
6. verify the result, and
7. preserve the reasoning trail.

That is not autocomplete. That is project repair.

## What DreamGraph did

DreamGraph Architect inspected the project and ran available checks.

It discovered:

- `npm test` was not configured.
- `npm run build` succeeded.
- `npm run lint` failed with two ESLint errors:
  - `src/context/CartContext.jsx`: `react-refresh/only-export-components` because the file exported shared values alongside the provider pattern.
  - `src/pages/BookingPage.jsx`: `useMemo` was called conditionally after an early return, violating React Hooks ordering rules.

The assistant reported the current state honestly:

- the app built successfully,
- lint was failing,
- no files had been changed yet,
- the next step was to fix the two lint errors.

After user approval, DreamGraph continued the repair loop. It started by separating the raw cart context into a new file and then proceeded through the remaining lint fixes under autonomous continuation. The run completed by applying patches and verifying with `npm run lint`.

## Graph genesis from zero context

The repair run produced a second, stronger proof point: DreamGraph did not only fix the visible lint failures. Starting from an empty graph and only the project directory path, it generated an accurate semantic map of the application while it investigated the codebase.

The graph that emerged included meaningful project concepts and workflows such as:

- startup initialization,
- route and page navigation,
- data loading,
- settings persistence,
- error handling and error-management behavior,
- build/deploy workflow structure,
- candidate feature relationships,
- dream/tension edges,
- rejected weak hypotheses with evidence notes.

This matters because “fix my codebase” is underspecified. A tool cannot safely repair a project unless it first develops a working model of what the project is, what its health signals are, and which relationships matter. DreamGraph bootstrapped that model on demand.

The stronger story is:

> DreamGraph built the project brain it needed in order to understand what “fixed” should mean.

For public demos, the graph view should be shown immediately after the verified repair. The before/after contrast is the product:

| Before | After |
|---|---|
| Empty graph | Semantic project map |
| Unknown health checks | Discovered build/lint/test status |
| Ambiguous request | Classified repair ledger |
| Broken lint | Verified clean-by-checks state |
| Stateless prompt | Durable project memory |

## What this proves

DreamGraph passed the minimum viable “fix my codebase” test:

> Fresh broken project. No prior graph. No error definition. User says only: “fix my codebase.”

The system successfully turned an ambiguous human prompt into an inspect → diagnose → patch → verify workflow and created a durable project graph from zero prior state.

## What worked

- DreamGraph did not hallucinate an answer.
- It used real project commands as evidence.
- It distinguished missing tests, passing build, and failing lint.
- It identified concrete file-level failures.
- It produced a scoped remediation path.
- It continued after explicit approval.
- It verified completion with the relevant project check.
- It preserved provenance through tool execution and status summaries.

## What needs to become first-class

The run worked, but it should feel like a deliberate product workflow instead of ordinary chat.

The target experience:

```text
fix my codebase
→ detect project type
→ discover scripts and health checks
→ scan/enrich graph when sparse
→ run build/lint/test/typecheck where available
→ classify failures and tensions
→ create repair ledger
→ patch smallest safe set
→ rerun failing checks
→ continue until clean or blocked
→ produce final repair report
```

## Product implications

### 1. Treat “fix my codebase” as a known intent

Architect should recognize broad repair prompts and enter a dedicated repair protocol automatically.

### 2. Start with health discovery

For JavaScript/TypeScript projects, inspect package scripts and run available checks. For other ecosystems, map the same idea to their native commands.

### 3. Maintain a repair ledger

Every run should track:

| Field | Meaning |
|---|---|
| Issue | The concrete problem found |
| Evidence | Command output, graph tension, or source anchor |
| Fix | Patch or remediation step |
| Verification | Command used to prove the fix |
| Status | fixed, pending, blocked, or deferred |

### 4. Separate “clean by checks” from “architecturally healthy”

A project can pass lint/build and still carry deeper tensions. DreamGraph should report both:

- **Clean by available checks**: commands pass.
- **Architectural remediation available**: graph/dream analysis found deeper improvements.

### 5. Make this the onboarding demo

The best first-run DreamGraph experience is:

1. attach any repo,
2. click **Fix My Codebase** or type `fix my codebase`,
3. watch DreamGraph discover the project,
4. approve the first repair batch,
5. receive a verified repair report.

## Demo script

1. Open a small broken React/Vite project.
2. Attach a new DreamGraph instance with no prior graph.
3. Prompt: `fix my codebase`.
4. Show DreamGraph discovering scripts and running checks.
5. Show build passing but lint failing.
6. Show two concrete issues identified.
7. Approve the recommended action.
8. Show patches applied.
9. Show `npm run lint` passing.
10. End with the line:

> DreamGraph figured out what broken meant.

## Positioning line

> AI coding tools need you to bring the error. DreamGraph can discover the error, plan the repair, apply the patch, and prove the codebase is clean.

## Success metric

The flagship metric for this workflow is:

> Time from fresh repo attach to verified clean-by-checks state after the prompt `fix my codebase`.

Secondary metrics:

- number of tool turns to first diagnosis,
- number of patch passes to green checks,
- percentage of runs that produce a repair ledger,
- percentage of runs that stop only on concrete blockers,
- user approvals required per successful repair.

## Current conclusion

DreamGraph can already do the core loop. The next step is productization: make the protocol explicit, make the repair ledger visible, and turn the successful run into the default onboarding path.
