# SDK Events Reference

This document summarizes the current DreamGraph SDK event surface, envelope, and stability expectations.

## Envelope

All graph events are delivered as a common envelope:

```ts
{
  seq: number;
  kind: string;
  affected_ids: string[];
  etag: string | null;
  ts: string;
  payload?: Record<string, unknown>;
}
```

## Stable event kinds

- `snapshot.changed`
- `cache.invalidated`

## Experimental event kinds
- `dream.cycle.completed`
- `tension.created`
- `tension.resolved`
- `candidate.added`
- `candidate.promoted`
- `candidate.rejected`
- `audit.appended`
- `schedule.executed`
- `schedule.timed_out`
- `schedule.paused`
- `nightmare.cycle.completed`
- `archetype.imported`
- `archetype.exported`
- `narrative.chapter.appended`

## Schedule lifecycle events

### `schedule.executed`

Emitted after scheduler execution write-back for both success and failure outcomes.

Payload fields currently emitted:

- `schedule_id: string`
- `schedule_name: string`
- `action: string`
- `execution_id: string`
- `success: boolean`
- `duration_ms: number`
- `status: string`
- `error: string | null`

### `schedule.timed_out`

Emitted when scheduler execution fails with the timeout guard path (`executeAction timeout after ...`).

Payload fields currently emitted:

- `schedule_id: string`
- `schedule_name: string`
- `action: string`
- `error: string`

### `schedule.paused`

Emitted when a schedule is auto-paused after reaching the configured consecutive error streak threshold.

Payload fields currently emitted:

- `schedule_id: string`
- `schedule_name: string`
- `action: string`
- `reason: "error_streak"`
- `error_count: number`

## Compatibility

Experimental kinds may change. Stable kinds must remain additive/compatible.

## Additional experimental lifecycle events

### `nightmare.cycle.completed`

Emitted when a NIGHTMARE adversarial cycle completes.

Payload fields currently emitted:

- `cycle_number: number`
- `strategy: string`
- `threats_found: number`
- `attack_surfaces: number`
- `summary: { critical: number; high: number; medium: number; low: number }`
- `duration_ms: number`

### `archetype.exported`

Emitted when validated edges are exported into the federated archetype exchange file.

Payload fields currently emitted:

- `archetypes_exported: number`
- `file_path: string`
- `instance_id: string`
- `timestamp: string`

### `archetype.imported`

Emitted when archetypes are imported from another DreamGraph instance.

Payload fields currently emitted:

- `archetypes_imported: number`
- `archetypes_skipped: number`
- `tensions_created: number`
- `source_instance: string`
- `timestamp: string`

### `narrative.chapter.appended`

Emitted after a story chapter is appended to the persistent system narrative.

Payload fields currently emitted:

- `chapter_number: number`
- `title: string`
- `cycle_range: [number, number]`
- `generated_at: string`
