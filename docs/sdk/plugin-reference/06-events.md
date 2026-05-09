# Events (normative)

[← Index](00-index.md) · Sources: [packages/sdk/src/events.ts](../../../packages/sdk/src/events.ts), [packages/sdk/src/events.experimental.ts](../../../packages/sdk/src/events.experimental.ts)

## Envelope

```ts
interface EventEnvelope {
  seq:          number;
  kind:         string;
  affected_ids: string[];
  etag:         string | null;
  ts:           string;            // ISO-8601
  payload?:     Record<string, unknown>;
}
```

## Stable kinds

Imported from `@dreamgraph/sdk`:

- `snapshot.changed`
- `cache.invalidated`

Stable kinds MUST remain backwards-compatible within a major SDK version.
Subscriptions require `events:read`.

## Experimental kinds

Imported from `@dreamgraph/sdk/events/experimental`. Subscription requires
`events:read:experimental` AND `instance.json:experimental_plugins: true`.

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

## Selected payload schemas

### `schedule.executed`

```ts
interface SchedulePayload {
  schedule_id:    string;
  schedule_name:  string;
  action:         string;
  execution_id:   string;
  success:        boolean;
  duration_ms:    number;
  status:         string;
  error:          string | null;
}
```

### `schedule.timed_out`

```ts
interface ScheduleTimeoutPayload {
  schedule_id:    string;
  schedule_name:  string;
  action:         string;
  error:          string;
}
```

### `schedule.paused`

```ts
interface SchedulePausedPayload {
  schedule_id:    string;
  schedule_name:  string;
  action:         string;
  reason:         "error_streak";
  error_count:    number;
}
```

### `nightmare.cycle.completed`

```ts
interface NightmarePayload {
  cycle_number:    number;
  strategy:        string;
  threats_found:   number;
  attack_surfaces: number;
  summary:         { critical: number; high: number; medium: number; low: number };
  duration_ms:     number;
}
```

### `archetype.exported`

```ts
interface ArchetypeExportedPayload {
  archetypes_exported: number;
  file_path:           string;
  instance_id:         string;
  timestamp:           string;
}
```

### `archetype.imported`

```ts
interface ArchetypeImportedPayload {
  archetypes_imported: number;
  archetypes_skipped:  number;
  tensions_created:    number;
  source_instance:     string;
  timestamp:           string;
}
```

### `narrative.chapter.appended`

```ts
interface NarrativeChapterPayload {
  chapter_number: number;
  title:          string;
  cycle_range:    [number, number];
  generated_at:   string;
}
```

## Plugin-defined kinds

Plugins MAY emit any kind not in the host taxonomy. The SDK does not enforce
naming, but the convention `<plugin-id>.<event_name>` matches the pattern used
for tools, resources, and UI ids.

## Replay

The SSE stream (`/explorer/api/events`) keeps a 500-event ring buffer.
The persistent record is `<instance>/data/event_log.json` with rotation. The
plugin contract is **at-most-once**: do not rely on receiving every event.
