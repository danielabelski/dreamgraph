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
| `nightmare.cycle.completed` | yes | `src/cognitive/adversarial.ts` `nightmare(...)` completion path | envelope with `affected_ids` from attack-surface entities; payload `{ cycle_number, strategy, threats_found, attack_surfaces, summary, duration_ms }` | same; stabilize after producer/SSE coverage and payload review | experimental |
| `archetype.imported` | yes | `src/cognitive/federation.ts` `importArchetypes(...)` | envelope with `affected_ids` from incoming archetype ids; payload `{ archetypes_imported, archetypes_skipped, tensions_created, source_instance, timestamp }` | same; stabilize after producer/SSE coverage and import contract review | experimental |
| `archetype.exported` | yes | `src/cognitive/federation.ts` `exportArchetypes()` | envelope with `affected_ids` from exported archetype ids; payload `{ archetypes_exported, file_path, instance_id, timestamp }` | same; stabilize after producer/SSE coverage and export contract review | experimental |
| `narrative.chapter.appended` | yes | `src/cognitive/narrator.ts` `appendToStory(...)` | envelope with `affected_ids: []`; payload `{ chapter_number, title, cycle_range, generated_at }` | same; stabilize after producer/SSE coverage and narrative payload review | experimental |
| `plugin.loaded` | no — host producer lands in M3 | (M3) `@dreamgraph/host` plugin loader | (none yet) | `{ plugin_id, plugin_version, occurred_at, runtime, trusted, capabilities }` per `@dreamgraph/sdk/telemetry` | stable (host-owned) |
| `plugin.unloaded` | no — host producer lands in M3 | (M3) `@dreamgraph/host` shutdown / disable / quarantine | (none yet) | `{ plugin_id, plugin_version, occurred_at, reason }` per `@dreamgraph/sdk/telemetry` | stable (host-owned) |
| `plugin.errored` | no — host producer lands in M3 | (M3) host capability/effect gate + watchdog | (none yet) | `{ plugin_id, plugin_version, occurred_at, reason, message, event_loop_lag_ms? }` per `@dreamgraph/sdk/telemetry` | stable (host-owned) |
| `plugin.handler.started` | no — host producer lands in M3 | (M3) host invocation wrapper | (none yet) | `{ plugin_id, plugin_version, occurred_at, correlation_id, seam, target }` per `@dreamgraph/sdk/telemetry` | stable (host-owned) |
| `plugin.handler.completed` | no — host producer lands in M3 | (M3) host invocation wrapper | (none yet) | `{ plugin_id, plugin_version, occurred_at, correlation_id, seam, target, duration_ms, ok }` per `@dreamgraph/sdk/telemetry` | stable (host-owned) |
| `plugin.output.accepted` | no — host producer lands in M3 | (M3) host effect-envelope check | (none yet) | `{ plugin_id, plugin_version, occurred_at, correlation_id, effect, seam, target? }` per `@dreamgraph/sdk/telemetry` | stable (host-owned) |
| `plugin.output.rejected` | no — host producer lands in M3 | (M3) host capability/effect gate registry | (none yet) | `{ plugin_id, plugin_version, occurred_at, correlation_id?, reason, seam, target?, detail? }` where `reason` is a `PluginRejectReason` per `@dreamgraph/sdk/reject-reasons` | stable (host-owned) |

## Deferred / post-M2 event kinds

The roadmap still mentions additional lifecycle names such as `dream.cycle.started`, `dream.cycle.failed`, and `webhook.dead_letter`.

These remain **not** currently part of `GraphEventKind`, `StableEventKind`, or `ExperimentalEventKind`.

- `dream.cycle.started` and `dream.cycle.failed` are deferred beyond M2 because the current daemon does not yet expose a single canonical dream-cycle lifecycle funnel that would make those events unambiguous and stable.
- `webhook.dead_letter` is deferred to M5/Webhooks because the dead-letter producer does not exist until outbound delivery, retries, and dead-letter persistence ship.

For M2 purposes, these are explicit **post-M2** kinds rather than in-scope planned rows.

## Promotion checklist
Before moving any experimental kind to stable:

1. Identify every producer in source.
2. Document the current payload fields and envelope behavior.
3. Verify the event reaches the internal bus and SSE path as intended.
4. Add or update a schema/contract test.
5. Preserve compatibility or version the payload.
6. Update `docs/sdk/events-reference.md` and SDK exports in the same change.

No event is promoted by declaration alone.

## Stable row → test coverage crosswalk

| Stable event kind | Test file | Assertion coverage |
| --- | --- | --- |
| `snapshot.changed` | `tests/explorer-events.test.ts` | GraphEventBus monotonic/replay tests emit `snapshot.changed`; SSE tests assert live and replay delivery of `snapshot.changed`. |
| `cache.invalidated` | `tests/explorer-events.test.ts` | GraphEventBus monotonic/replay tests emit `cache.invalidated`; SSE snapshot test confirms delivery when no `Last-Event-ID` is present. |
| `plugin.loaded` | (M3) — host producer not yet implemented | Stable contract published in `@dreamgraph/sdk/telemetry`; producer-side test lands with `@dreamgraph/host` loader in M3. |
| `plugin.unloaded` | (M3) — host producer not yet implemented | Stable contract published in `@dreamgraph/sdk/telemetry`; producer-side test lands with M3 host loader. |
| `plugin.errored` | (M3) — host producer not yet implemented | Stable contract published in `@dreamgraph/sdk/telemetry`; producer-side test lands with M3 host loader (capability gate + watchdog). |
| `plugin.handler.started` | (M3) — host producer not yet implemented | Stable contract published in `@dreamgraph/sdk/telemetry`; producer-side test lands with M3 host invocation wrapper. |
| `plugin.handler.completed` | (M3) — host producer not yet implemented | Stable contract published in `@dreamgraph/sdk/telemetry`; producer-side test lands with M3 host invocation wrapper. |
| `plugin.output.accepted` | (M3) — host producer not yet implemented | Stable contract published in `@dreamgraph/sdk/telemetry`; producer-side test lands with M3 host effect-envelope check. |
| `plugin.output.rejected` | (M3) — host producer not yet implemented | Stable contract published in `@dreamgraph/sdk/telemetry`; reasons enumerated in `@dreamgraph/sdk/reject-reasons`; producer-side test lands with M3 host capability/effect gate registry. |

## Post-M2 backlog items

The following roadmap kinds remain explicit post-M2 backlog and do not block M2 closure:

- `dream.cycle.started`
- `dream.cycle.failed`
- `webhook.dead_letter`