import { describe, expect, expectTypeOf, it } from "vitest";
import {
  EventKind,
  StableEventKind,
  StableEventKinds,
  defineEventHandler,
} from "../../packages/sdk/src/events.js";
import {
  EventKind as KindsEventKind,
  StableEventKind as KindsStableEventKind,
  StableEventKinds as KindsStableEventKinds,
} from "../../packages/sdk/src/events/kinds.js";
import {
  ExperimentalEventKind,
  ExperimentalEventKinds,
  defineExperimentalEventHandler,
} from "../../packages/sdk/src/events/experimental.js";

describe("SDK event import boundaries", () => {
  it("keeps the default event kind surface stable-only", () => {
    expect(StableEventKinds).toEqual([
      "snapshot.changed",
      "cache.invalidated",
    ]);
    expect(StableEventKinds).not.toContain("dream.cycle.completed");
    expect(StableEventKinds).not.toContain("audit.appended");

    const handler = defineEventHandler("snapshot.changed", async () => undefined);

    expect(handler).toMatchObject({
      kind: "snapshot.changed",
      experimental: false,
    });
    expectTypeOf<EventKind>().toEqualTypeOf<StableEventKind>();
  });

  it("exposes stable kinds from the explicit kinds subpath", () => {
    expect(KindsStableEventKinds).toEqual(StableEventKinds);
    expectTypeOf<KindsEventKind>().toEqualTypeOf<KindsStableEventKind>();
    expectTypeOf<KindsStableEventKind>().toEqualTypeOf<StableEventKind>();
  });

  it("requires the experimental subpath for experimental kinds and handlers", () => {
    expect(ExperimentalEventKinds).toEqual([
      "dream.cycle.completed",
      "tension.created",
      "tension.resolved",
      "candidate.added",
      "candidate.promoted",
      "candidate.rejected",
      "audit.appended",
    ]);
    expect(ExperimentalEventKinds).not.toContain("snapshot.changed");

    const handler = defineExperimentalEventHandler(
      "dream.cycle.completed",
      async () => undefined,
    );

    expect(handler).toMatchObject({
      kind: "dream.cycle.completed",
      experimental: true,
    });
    expectTypeOf<ExperimentalEventKind>().not.toEqualTypeOf<StableEventKind>();
  });
});
