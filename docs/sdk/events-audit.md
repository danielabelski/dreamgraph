# SDK Events Audit

M2 rule: an event kind is stable only after its producer exists, payload shape is known, and an end-to-end emit path is verified. Experimental events may have real producers, but consumers must opt in explicitly through `@dreamgraph/sdk/events/experimental` and the `events:read:experimental` capability.

## Import boundary

- Stable SDK event surface: `@dreamgraph/sdk`, `@dreamgraph/sdk/events`, and `@dreamgraph/sdk/events/kinds`.
- Experimental SDK event surface: `@dreamgraph/sdk/events/experimental` only.
- `EventKind` intentionally aliases only `StableEventKind`.
- Experimental handlers must use `defineExperimentalEventHandler()` from the experimental subpath.

## Event matrix

| Event kind | Emitted today | Producer file:line | Current payload shape | Proposed stable shape | Stability |
| --- | --- | --- | --- | --- | --- |
| `snapshot.changed` | yes | `src/graph/snapshot.ts:328` | envelope `{ seq, kind, affected_ids: [], etag, ts, payload }`; payload `{ previous_etag, node_count, edge_count }` | same; keep `previous_etag`, `node_count`, `edge_count` stable and optional-additive only | stable |
| `cache.invalidated` | yes | `src/graph/watcher.ts:41` | envelope `{ seq, kind, affected_ids: [], etag: null, ts, payload }`; payload `{ files }` where `files` is a list of changed data-dir paths | same; treat `files` as best-effort and optional-additive only | stable |
| `dream.cycle.completed` | yes | `src/cognitive/engine.ts:2009` | envelope with `affected_ids: []`; payload `{ session_id, strategy }`, where `strategy` may be `null` | `{ session_id: string, strategy: string | null, duration_ms?: number, outcome?: string }` after E2E coverage | experimental |
| `tension.created` | yes | `src/cognitive/engine.ts:1366` | envelope with `affected_ids: [tension_id, ...entities]`; payload `{ tension_id, type, domain, urgency }` | same plus optional `entities?: string[]`; stabilize after producer/SSE tests | experimental |
| `tension.resolved` | yes | `src/cognitive/engine.ts:1427` | envelope with `affected_ids: [tension_id, ...entities]`; payload `{ tension_id, resolved_by, resolution_type }` | same plus optional `evidence?: string`, `recheck_ttl?: number`; stabilize after producer/SSE tests | experimental |
| `candidate.added` | yes | `src/cognitive/engine.ts:1009` | envelope with `affected_ids: [dream_id]`; payload `{ dream_id, dream_type, confidence }` | same; stabilize after producer/SSE tests | experimental |
| `candidate.promoted` | yes | `src/cognitive/engine.ts:1073`, `src/cognitive/engine.ts:2328` | envelope with affected endpoint ids; payload `{ from, to, confidence }` for system promotion or `{ from, to, confidence, actor: "user" }` for user promotion | `{ from: string, to: string, confidence: number, actor?: "system" | "user" }`; align both producers before promotion | experimental |
| `candidate.rejected` | yes | `src/cognitive/engine.ts:2362` | envelope with `affected_ids: [dream_id]`; payload `{ dream_id, dream_type }` | same plus optional `actor?: "user" | "system"`, `reason?: string`; stabilize after producer/SSE tests | experimental |
| `audit.appended` | yes | `src/explorer/audit.ts:70` | envelope with `affected_ids` from audit row; payload `{ mutation_id, intent, actor, ok, dry_run, reason, before_hash, after_hash, etag }` | same; stabilize only if plugin consumers need mutation audit events | experimental |
| `schedule.executed` | yes | `src/cognitive/scheduler.ts` write-back path | envelope with `affected_ids: [schedule_id]`; payload `{ schedule_id, schedule_name, action, execution_id, success, duration_ms, status, error }` | same; keep additive only until scheduler producer/SSE coverage is mature | experimental |
| `schedule.timed_out` | yes | `src/cognitive/scheduler.ts` timeout failure branch | envelope with `affected_ids: [schedule_id]`; payload `{ schedule_id, schedule_name, action, error }` | same; stabilize only after timeout-path regression coverage | experimental |
| `schedule.paused` | yes | `src/cognitive/scheduler.ts` error-streak auto-pause branch | envelope with `affected_ids: [schedule_id]`; payload `{ schedule_id, schedule_name, action, reason: "error_streak", error_count }` | same; stabilize only after scheduler outcome/SSE tests | experimental |

## Planned / not currently SDK event kinds

The roadmap mentions additional lifecycle names such as `dream.cycle.started`, `dream.cycle.failed`, `nightmare.cycle.completed`, `archetype.imported`, `archetype.exported`, `narrative.chapter.appended`, and `webhook.dead_letter`.

These are **not** currently part of `GraphEventKind`, `StableEventKind`, or `ExperimentalEventKind`. They should remain absent until a producer, payload, and test plan exist. Add them as experimental first unless the full stable checklist below is complete.

## Promotion checklist

Before moving any experimental kind to stable:

1. Identify every producer in source.
2. Document the current payload fields and envelope behavior.
3. Verify the event reaches the internal bus and SSE path as intended.
4. Add or update a schema/contract test.
5. Preserve compatibility or version the payload.
6. Update `docs/sdk/events-reference.md` and SDK exports in the same change.

No event is promoted by declaration alone.
