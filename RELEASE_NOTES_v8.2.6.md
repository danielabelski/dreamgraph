# DreamGraph v8.2.6 — Smarter Tensions, Cleaner Memory

A focused maintenance release that fixes the long-standing **confidence
inflation bug** and upgrades the **automatic tension solver** with the
intervention engine and an LLM proposer.

## What changed

### Memory hygiene (fixes the confidence inflation bug)

Deterministic dream strategies (symmetry completion, gap detection, causal
replay, orphan bridging, cross-domain) re-derived the same edge every cycle.
Each re-derivation was treated as new evidence, so reinforcement counts
climbed past 40 and confidence saturated at 1.0 — even for **rejected**
candidates. That is no longer possible:

- **Rejected edges and nodes** are no longer reinforced. They decay at 2×
  the normal rate and skip tension protection, so they leave the dream
  graph in a few cycles.
- **Latent edges and nodes** use a diminishing-returns reinforcement curve:
  ```
  bump = candidate.confidence * 0.3 / (1 + reinforcement_count * 0.1)
  ```
  Same-strategy re-derivation can no longer push confidence to 1.0.

### Migration script

`scripts/repair-confidence-inflation.mjs` re-clamps `status === "rejected"`
edges and nodes in an existing instance:

- `confidence = min(0.4, current * 0.5)`
- `reinforcement_count = floor(current / 4)`
- `ttl = min(ttl, 4)`

Usage (stop the daemon first):

```powershell
node scripts/repair-confidence-inflation.mjs "$env:USERPROFILE\.dreamgraph\<instance-uuid>\data"
```

A `.bak-{timestamp}` backup is written next to `dream_graph.json`.

### Smarter automatic tension resolver

`runTensionResolverCycle` previously chose a strategy from a hardcoded
keyword table. It now defers to the **intervention engine** so each
candidate is grounded in the data-model:

- Phantom entities (missing from `data_model.json`) → `wont_fix`.
- Both entities exist but no relationship → `merge` strategy with a
  pre-built `enrich_seed_data` payload attached as `proposed_action`.
- Source-level mismatches → `mediator` (missing/weak link) or `split`
  (code insight) with real `source_files` resolved from the data model.

**LLM proposer.** When LLM readiness is `ready`, the normalizer model is
asked for `{strategy, rationale, validation_window}` in strict JSON mode
before the heuristic fires. Failures fall through silently.

**Tightened validation.** A pre-existing bridge edge no longer counts as
confirmation that a resolution worked. The bridging edge in
`validated_edges.json` must have `validated_at >= proposed_at - 1s` to be
treated as evidence.

**Opt-in auto-apply.** Set `DREAMGRAPH_AUTO_APPLY_RESOLUTION_PLANS=1` (or
`true`) to immediately execute candidates whose `proposed_action.tool ===
"enrich_seed_data"`. The resolver summary now includes `auto_applied=N`.

### New public surface

- `executeEnrichSeedData(input)` is exported from
  `src/tools/enrich-seed-data.ts` so any subsystem (including the
  cognitive engine's auto-apply path) can invoke the same validate →
  merge → write → reindex pipeline that the MCP tool uses.
- `buildTensionPlanContext()` and `proposeResolutionCandidateFromPlan()`
  are exported from `src/cognitive/intervention.ts` as the bridge
  between the planner and the tension resolver.

### Schema

`TensionResolutionCandidate` gains an optional `proposed_action` field
holding either a `RemediationEnrichmentAction` or a
`RemediationResolutionCall`. Existing candidates without the field
continue to work.

### Self-healing graph integrity

The fact graph used to accumulate orphans (degree-0 entities), dangling
link targets, and asymmetric edges every time a new entity was created.
The cleanup was always a manual chore. Four entry points now run
self-healing passes automatically:

- **`dream_cycle`** — when promotions happen, runs `autoWireOrphans`
  (LLM-driven `wire_links`, capped at 25 entities) followed by a
  bidirectional backlink pass. Skipped silently if no LLM is configured.
- **`enrich_seed_data`** — after every successful insert/update, applies
  the bidirectional backlink pass so every new `A → B` link gets its
  reciprocal `B → A`. Recursion-guarded via a new internal
  `_skipIntegrityHooks` option.
- **`scan_project`** — runs the backlink pass once at the tail of
  `runScanProject` when real seeds were written.
- **`init_graph`** — runs the backlink pass once at the tail before
  returning the result.

The new module `src/tools/graph-integrity.ts` exposes
`applyBidirectionalBacklinks()` (pure-data symmetrization, idempotent)
and `autoWireOrphans()` (wraps wire-links). All hooks are best-effort
and never block their host operation. `executeWireLinksProgrammatic` is
exported from `src/tools/wire-links.ts` for in-process callers.

### New MCP tool: `wire_links`

LLM-driven orphan resolver for the four fact-graph entity types
(`feature`, `workflow`, `data_model`, `capability`). Combines source-file
overlap, name/description Jaccard, and tag overlap to build a top-K
candidate pool, then asks the dreamer model to pick the semantically
meaningful connections. Anti-hallucination validation rejects any link
whose target is not in the candidate set. Writes go through
`executeEnrichSeedData` (merge mode) so all the standard validation,
indexing, and cache-invalidation paths apply. Tool count: **33**.

### Operations & diagnostics scripts

- `scripts/audit-orphans.mjs <dataDir>` — counts orphans, source-only,
  sink-only, and empty-link entities per type; lists dangling link
  targets. Read-only.
- `scripts/audit-nodes.mjs <dataDir>` — node-level inspection helper.
- `scripts/wire-links-cli.mjs <scope|all> <limit>` — bypass the chat UI
  transport timeout by invoking `wire_links` over a 30-minute MCP
  client.
- `scripts/add-backlinks.mjs <dataDir>` — one-shot bidirectional
  backlink reconciliation for live data; reads the on-disk graph,
  symmetrizes in memory, then submits per-type batches via MCP.
- `scripts/stub-dangling.mjs` — creates placeholder entities for
  dangling dream-edge references so the graph stays consistent until
  real entities are extracted.
- `scripts/mcp-call.mjs <tool> '<json-args>'` — generic MCP tool
  invoker with a 30-minute timeout for long operations.

### Snapshot health & confidence display

`src/graph/snapshot.ts` no longer reports orphan and tension penalties
the same way for every node. Tension nodes get a flat `0.2 * tension_hits`
penalty; non-tension nodes with degree 0 get a `0.4` orphan penalty.
Minimum reported health is `0.1`. The Inspector panel hides the
Confidence row for non-dream nodes and the Health row for tension nodes.

## Verification

- `npm run build` — clean.
- `npx vitest run` — 188 passed, 2 skipped, 0 failed.
