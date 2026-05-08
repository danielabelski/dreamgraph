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
