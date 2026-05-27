# 14. Adaptive Future Engine

Adaptive Future Engine, usually shortened to AFE, is DreamGraph's v11 layer for choosing the best next step from several futures that are already allowed by your project graph.

In plain terms: when DreamGraph can take more than one valid path, AFE helps it choose the path that best fits your repository's evidence, ADRs, workflows, data model, API surface, and previous outcomes.

AFE does not replace your instructions. It does not override accepted ADRs. It does not invent a new daemon mode. It is an advisory ranking layer that sits inside existing DreamGraph tools and leaves a compact audit trail for why one candidate future was preferred over another.

## What It Is

AFE is easiest to understand as a decision helper for graph-aware work.

Without AFE, a tool can often tell that several actions are technically possible: enrich this node, reject that candidate, resolve this tension, patch this workflow, or fall back to deterministic behavior. AFE adds a comparison step before the tool commits to a recommendation.

It asks questions like:

- Does this candidate match the evidence in the graph?
- Does it respect accepted ADR guard rails?
- Does it fit the workflow step the user is in?
- Does it preserve API and data-model contracts?
- What objections exist against this future?
- Is the result strong enough, or should the tool expose deterministic fallback instead?

The result is a selected future, rejected alternatives, score factors, objections, evidence anchors, and route/fallback provenance. The important part is that AFE stores the audit shape, not raw model prompts or long hidden reasoning dumps.

## Where It Runs

You do not start a separate AFE service. It is deployed as part of DreamGraph itself.

In a normal installation, AFE runs inside the DreamGraph daemon and is reached through the same surfaces you already use:

- the VS Code Architect chat;
- MCP tools exposed by the daemon;
- graph enrichment tools such as `enrich_parser_nodes`;
- cognitive tools such as `solidify_cognitive_insight`;
- remediation and planning flows that compare candidate actions before recommending one.

The VS Code extension does not host a separate AFE runtime. The extension talks to the daemon, and the daemon applies AFE where the relevant tool has been wired to use it.

## How It Is Deployed In Practice

For users, deploying AFE usually means upgrading DreamGraph to v11.0.1 or later and running the daemon for an instance as usual.

A typical practical setup looks like this:

1. Install or upgrade DreamGraph.
2. Open or create a DreamGraph instance for your repository.
3. Start the daemon.
4. Connect the VS Code extension or an MCP-aware agent to that daemon.
5. Scan or refresh the graph so the daemon has features, workflows, data-model entities, ADRs, and evidence anchors to rank against.
6. Use normal Architect requests. AFE participates when a wired tool needs to compare compliant candidate futures.

There is no separate `afe start` command and no separate AFE database. AFE uses the existing graph, ADR store, workflow registry, data model, tool outputs, and compact audit metadata written by DreamGraph.

## What You Need To Configure

AFE works best when the graph has enough evidence to compare futures.

At minimum, your instance should have:

- a bootstrapped or scanned graph;
- current ADRs for important architectural rules;
- workflows that describe recurring project operations;
- data-model and API-surface entries for important contracts;
- an LLM provider configured if you want model-assisted ranking.

If the LLM provider is unavailable, AFE-aware tools must keep deterministic fallback visible. That means the tool should still explain the route it took and why the result may be less adaptive.

## When You Notice It

Most users notice AFE indirectly:

- the Architect can explain why one valid action is a better fit than another;
- graph-tool enrichment records compact audit metadata for selected and rejected candidates;
- cognitive insight solidification keeps route and fallback provenance attached to a recommendation;
- remediation plans preserve objections and evidence anchors instead of returning a bare instruction;
- release, planning, and repair workflows can show why a path was selected without exposing raw prompt traffic.

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

You can also ask more directly:

```text
Use AFE to rank the compliant options, but do not override ADRs or API contracts.
```

## How To Read The Result

A good AFE-backed answer should tell you:

- which candidate future was selected;
- which candidates were rejected;
- which evidence anchors mattered;
- which objections were found;
- whether deterministic fallback was used;
- whether any validation failure kept the result advisory only.

Treat those fields as the audit trail. They are there so a human can understand the recommendation and decide whether to accept it.

## Important Boundary

AFE is advisory. If it suggests something that conflicts with an accepted ADR, workflow contract, API surface, data-model contract, or explicit user instruction, the higher-authority constraint wins.

AFE should make DreamGraph's choices easier to inspect. It should not become an invisible policy engine.

Next: return to the [daily workflow](10-daily-workflow.md) or the [glossary](13-glossary.md).
