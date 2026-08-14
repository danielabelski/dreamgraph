# 5. Bootstrapping the graph

> **TL;DR** — `dg scan my-project` discovers structure and then semantically enriches every canonical node with multi-hop context. Use `dg enrich my-project --skip-scan --force` when the source map is current but its knowledge is hollow. Use full bootstrap only for a fresh or fundamentally broken instance.

A fresh instance has an empty graph. This page explains how to fill it.

---

## The bootstrap commands

### `dg scan` — the initial pass

```powershell
dg scan my-project
```

Scan walks the attached repository, extracts:

- **Source files** — paths, languages, sizes
- **API surface** — exported functions, classes, types
- **Data model hints** — schema files, type declarations, ORM models
- **UI elements** — components, routes (front-end repos)
- **Config and templates** — env vars, build config
- **Configured PostgreSQL schema** — tables and ownership links when `DATABASE_URL` is set in the instance's `engine.env`

…and writes them into the graph as features, workflow stubs, data-model entries, and UI-registry entries.

Project-root `.gitignore` rules are honored during discovery. Build outputs, dependencies, generated files, and project-specific ignored paths are excluded before semantic analysis.

Useful flags:

```powershell
dg scan my-project --depth shallow      # quick top-level pass
dg scan my-project --depth deep         # follows imports further
dg scan my-project --targets features,data_model,workflows
```

You can re-run scan whenever you want. Subsequent runs upsert existing entities and discover new ones. Every structural scan then forces graph-wide semantic enrichment with at least three hops of context so the result is not left as parser-only inventory.

### `dg enrich` — fill in the gaps

```powershell
dg enrich my-project
dg enrich my-project --depth deep
dg enrich my-project --targets workflows,capabilities
dg enrich my-project --skip-scan --force
dg enrich my-project --model-source architect
```

Enrichment uses either the standalone LLM configuration or, during an Architect session, the connected Architect model/adapter to:

- Give every canonical node a substantive description of intent, behavior, rationale, and relationships
- Infer workflow steps, contracts, capabilities, datastore ownership, and UI interaction/visual/layout knowledge
- Discover semantic relations beyond direct file adjacency with multi-hop neighborhood evidence
- Persist confidence, coverage, source evidence, and relationship rationale for later reuse

Already-enriched neighbors act as a confidence-aware semantic cache. DreamGraph reuses their persisted evidence when coverage is sufficient and reads source only for uncovered, conflicting, or low-confidence areas. This reduces repeated source reads and LLM cost across overlapping neighborhoods. Disable this only for diagnosis with `--no-semantic-cache`; tune the gates with `--semantic-cache-min-confidence` and `--semantic-cache-min-coverage`.

If neither a standalone nor connected Architect LLM route is available, DreamGraph records deterministic fallback metadata but does not claim semantic completion. `graph_health_report` will continue to identify those nodes as needing enrichment.

### Graph health before expensive maintenance

Ask Architect to run `graph_health_report` before a broad repair. It reports semantic density, parser-only and hollow nodes, machine-name leakage, contract/workflow/datastore/UI coverage, connectivity, tensions, dream promotion, repository drift, and scan/enrichment age.

Use the smallest operation that fits the evidence:

1. **Enrich** when source topology is current but semantic coverage is poor.
2. **Scan** when files, commits, datastore configuration, or scan age show structural drift.
3. **Bootstrap** only when the instance is empty or the smaller operations cannot restore it.

Architect can execute approved maintenance directly through DreamGraph MCP; you do not need to switch to the CLI.

### `dg curate` — quality pass

```powershell
dg curate my-project
dg curate my-project --dry-run    # preview what would change
```

Curate trims duplicates, merges near-equivalent entities, and resolves easy contradictions. Run it after big enrich passes.

### `dg bootstrap` — the operator override (v8.2.5+)

```powershell
dg bootstrap my-project
dg bootstrap my-project --mode re_enrich
dg bootstrap my-project --mode full --force
```

DreamGraph normally drives its own bootstrap chain the first time the LLM becomes ready (see `cognitive_status.llm_readiness`). `dg bootstrap` is the **manual escape hatch** for the cases where the auto-driver doesn't fit:

- The instance pre-dates the auto-readiness watcher and was never bootstrapped.
- You upgraded the LLM model and want existing entities re-enriched against it.
- You want a clean slate (`--mode full --force`) without recreating the instance.

**Modes:**

| Mode | Behavior |
|---|---|
| `auto` (default) | `full` on a fresh instance, `re_enrich` on a populated one. |
| `full` | Always rescan source + run LLM enrichment + ADR discovery. May take several minutes. |
| `re_enrich` | Refresh model-derived metadata only (no source rescan). Use after a model swap. |

`--force` bypasses the bootstrap-registry's fingerprint dedupe — useful when the same provider/model fingerprint was already recorded but you still want to re-run.

For day-to-day work you almost never need this. Prefer enrich before scan, and scan before bootstrap. Long operations publish progress notifications and preserve completed batches so an interrupted client call does not erase useful work.

---

## Where the graph lives

After bootstrap, look at `~/.dreamgraph/<instance-uuid>/`:

```
data/
  features.json          # The features in your codebase
  workflows.json         # End-to-end flows
  data_model.json        # Entities, fields, relationships
  ui_registry.json       # UI components/routes
  capabilities.json      # System-level capabilities
  validated_edges.json   # Trusted relationships
  candidate_edges.json   # Speculative relationships from dreams
  dream_graph.json       # Full speculation graph
  tension_log.json       # Open + resolved tensions
  adr_log.json           # Architecture decisions
  threat_log.json        # Nightmare-cycle findings
  index.json             # Cross-referencing index
  schedules.json         # Scheduled dream tasks
  graph_maintenance.json # Scan/enrichment age, repository drift, datastore fingerprint, targeted schedules
  ...
logs/
  daemon-<date>.log
config/
  engine.env
  instance.json
```

These are plain JSON. You can read them. You **shouldn't** edit them by hand while the daemon is running — use the Explorer or the MCP tools instead. The daemon writes atomically via `<file>.tmp` + rename, so partial edits will lose to the next save.

---

## What to expect on the first scan

| Repo size | First scan | First enrich | First dream cycle |
|-----------|-----------|--------------|-------------------|
| Tiny (< 1k files) | seconds | < 1 minute | seconds |
| Medium (10k files) | 1-2 min | 2-5 min | 30s-2 min |
| Large (100k+ files) | 5-15 min | 10-30 min | 1-5 min |

Numbers are wide because LLM speed dominates. Local Ollama is slowest; OpenAI fastest.

---

## A reasonable bootstrap recipe

Run these in order, the first time:

```powershell
dg scan my-project
dg enrich my-project
dg curate my-project
```

Then trigger a dream cycle from your AI agent:

> *"Run `dream_cycle` with `strategy=all` and `max_dreams=20`."*

Then look at the Explorer (next chapter coming up) and see what the system found.

---

## Re-bootstrapping after big code changes

When you finish a refactor or add a major feature, give the graph a refresh:

```powershell
dg scan my-project --depth deep
dg enrich my-project
```

Major scans and implementations also create bounded, targeted dream schedules around the affected entities. Those follow-up runs use a two-hop focus to stabilize relationships and missing abstractions without repeatedly dreaming over the entire graph.

---

## Scheduling

If you'd rather not type commands, schedule recurring dream cycles:

```powershell
dg schedule my-project --add --cron "0 */6 * * *" --strategy all --max-dreams 30
dg schedule my-project --history
dg schedule my-project --pause <id>
dg schedule my-project --resume <id>
dg schedule my-project --delete <id>
```

Scheduled cycles run in the background while the daemon is up.

---

## Sanity check after bootstrap

```powershell
dg status my-project
```

Look for non-zero counts in:

- **Features**, **workflows**, **data model entities**
- **Validated edges** (zero is fine on day one — they grow with dream cycles)
- **Tensions (active)** — having a few is healthy. Zero usually means scan was too shallow.

Then ask Architect for a graph-health report. Node count alone is not the success criterion: semantic density, contracts, UI/datastore coverage, meaningful links, and freshness determine whether the graph can support reliable architectural reasoning.

---

## Next

Time to actually look at it: **[6. The VS Code extension](06-vs-code-extension.md)**.
## Establishing an incremental baseline

Run an explicit full scan before using incremental maintenance. The full scan publishes the compatible `scan_state.json` evidence baseline. Incremental requests fail closed when that baseline is missing, corrupt, or incompatible; they do not trigger a hidden full scan.

Preview repository drift without mutation:

```bash
dg scan <instance> --incremental --dry-run
```

If the preview reports that a full scan is required, run the normal full scan deliberately, verify it, and retry the preview.