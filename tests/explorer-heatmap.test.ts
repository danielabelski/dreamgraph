/**
 * Heatmap aggregation + route contract.
 *
 * Slice E1 of plans/EXPLORER_3D_MODE.md. The aggregator is a pure
 * function so the route stays trivial; both layers are pinned here so a
 * future schema change to event_log.json doesn't silently break the
 * Explorer's heatmap mode.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { setDataDirOverride, dataPath } from "../src/utils/paths.js";
import {
  aggregateHeatmap,
  coerceWindowSeconds,
  DEFAULT_HEATMAP_WINDOW_SECONDS,
  MAX_HEATMAP_WINDOW_SECONDS,
  getHeatmap,
} from "../src/explorer/heatmap.js";
import { handleExplorerRoute } from "../src/explorer/routes.js";
import type { EventLogEntry } from "../src/cognitive/types.js";

function makeEntry(
  id: string,
  affected: string[],
  timestamp: string,
): EventLogEntry {
  return {
    event: {
      id,
      source: "manual",
      severity: "info",
      timestamp,
      payload: {},
      affected_entities: affected,
      description: "test",
    },
    classification: {
      response_type: "noop",
      entity_scope: { primary: affected, secondary: [], all: affected },
      strategy: "default",
    },
    result: { action_taken: "noop", duration_ms: 0, outcome_summary: "ok" },
    timestamp,
  };
}

describe("heatmap — coerceWindowSeconds", () => {
  it("returns the default for null/empty input", () => {
    expect(coerceWindowSeconds(null)).toBe(DEFAULT_HEATMAP_WINDOW_SECONDS);
    expect(coerceWindowSeconds("")).toBe(DEFAULT_HEATMAP_WINDOW_SECONDS);
  });

  it("returns the default for garbage and zero/negative", () => {
    expect(coerceWindowSeconds("xyz")).toBe(DEFAULT_HEATMAP_WINDOW_SECONDS);
    expect(coerceWindowSeconds("0")).toBe(DEFAULT_HEATMAP_WINDOW_SECONDS);
    expect(coerceWindowSeconds("-9")).toBe(DEFAULT_HEATMAP_WINDOW_SECONDS);
  });

  it("clamps oversized windows", () => {
    expect(coerceWindowSeconds(String(MAX_HEATMAP_WINDOW_SECONDS * 10))).toBe(
      MAX_HEATMAP_WINDOW_SECONDS,
    );
  });

  it("preserves valid windows", () => {
    expect(coerceWindowSeconds("300")).toBe(300);
  });
});

describe("heatmap — aggregateHeatmap", () => {
  const now = new Date("2026-05-01T12:00:00Z");
  const recent = "2026-05-01T11:50:00Z"; // 10 min ago
  const stale = "2026-05-01T09:00:00Z"; // 3 h ago

  it("returns empty result on empty input", () => {
    const out = aggregateHeatmap([], 3600, now);
    expect(out.total_events).toBe(0);
    expect(out.max_count).toBe(0);
    expect(out.nodes).toEqual([]);
    expect(out.window_seconds).toBe(3600);
  });

  it("counts only events inside the window", () => {
    const out = aggregateHeatmap(
      [
        makeEntry("e1", ["a"], recent),
        makeEntry("e2", ["a"], stale),
      ],
      3600,
      now,
    );
    expect(out.total_events).toBe(1);
    expect(out.nodes).toEqual([["a", 1]]);
  });

  it("dedupes affected entities within a single event", () => {
    const out = aggregateHeatmap(
      [makeEntry("e1", ["a", "a", "b"], recent)],
      3600,
      now,
    );
    // 'a' counted once even though it appears twice in the same event.
    expect(out.nodes).toEqual([
      ["a", 1],
      ["b", 1],
    ]);
  });

  it("sorts by count desc then id asc and reports max_count", () => {
    const out = aggregateHeatmap(
      [
        makeEntry("e1", ["alpha"], recent),
        makeEntry("e2", ["beta"], recent),
        makeEntry("e3", ["beta"], recent),
        makeEntry("e4", ["gamma"], recent),
      ],
      3600,
      now,
    );
    expect(out.max_count).toBe(2);
    expect(out.nodes[0]).toEqual(["beta", 2]);
    expect(out.nodes.slice(1)).toEqual([
      ["alpha", 1],
      ["gamma", 1],
    ]);
  });

  it("ignores entries with malformed timestamp or missing affected_entities", () => {
    const malformed = [
      makeEntry("e1", ["a"], "not-a-date"),
      { ...makeEntry("e2", [], recent), event: { ...makeEntry("e2", [], recent).event, affected_entities: undefined as unknown as string[] } },
      makeEntry("e3", ["b"], recent),
    ];
    const out = aggregateHeatmap(malformed as EventLogEntry[], 3600, now);
    expect(out.nodes).toEqual([["b", 1]]);
  });
});

describe("heatmap — disk + route", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "dg-heatmap-"));
    setDataDirOverride(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns empty when event_log.json is missing", async () => {
    const out = await getHeatmap(3600);
    expect(out.total_events).toBe(0);
    expect(out.nodes).toEqual([]);
  });

  it("returns empty when event_log.json is malformed", async () => {
    await writeFile(dataPath("event_log.json"), "not json", "utf-8");
    const out = await getHeatmap(3600);
    expect(out.total_events).toBe(0);
  });

  it("aggregates from a real on-disk log", async () => {
    const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const log = {
      metadata: {
        description: "test",
        schema_version: "1.0.0",
        total_events: 2,
        last_event: recent,
      },
      events: [
        makeEntry("e1", ["alpha", "beta"], recent),
        makeEntry("e2", ["alpha"], recent),
      ],
    };
    await writeFile(
      dataPath("event_log.json"),
      JSON.stringify(log),
      "utf-8",
    );
    const out = await getHeatmap(3600);
    expect(out.total_events).toBe(2);
    expect(out.nodes[0]).toEqual(["alpha", 2]);
    expect(out.nodes[1]).toEqual(["beta", 1]);
    expect(out.max_count).toBe(2);
  });

  it("GET /explorer/api/heatmap returns aggregated payload", async () => {
    const recent = new Date(Date.now() - 60 * 1000).toISOString();
    await writeFile(
      dataPath("event_log.json"),
      JSON.stringify({
        metadata: {
          description: "t",
          schema_version: "1.0.0",
          total_events: 1,
          last_event: recent,
        },
        events: [makeEntry("e1", ["x"], recent)],
      }),
      "utf-8",
    );

    let captured: { status?: number; body?: string } = {};
    const res = {
      writeHead(s: number) {
        captured.status = s;
        return this;
      },
      end(b?: string) {
        captured.body = b;
        return this;
      },
    } as unknown as ServerResponse;
    const req = {
      method: "GET",
      url: "/explorer/api/heatmap?window=3600",
      headers: {},
      on() {
        return this;
      },
    } as unknown as IncomingMessage;

    const handled = await handleExplorerRoute(
      req,
      res,
      "/explorer/api/heatmap",
    );
    expect(handled).toBe(true);
    expect(captured.status).toBe(200);
    const body = JSON.parse(captured.body ?? "{}");
    expect(body.window_seconds).toBe(3600);
    expect(body.nodes).toEqual([["x", 1]]);
  });

  it("GET /explorer/api/heatmap clamps oversized window", async () => {
    let captured: { body?: string } = {};
    const res = {
      writeHead() {
        return this;
      },
      end(b?: string) {
        captured.body = b;
        return this;
      },
    } as unknown as ServerResponse;
    const req = {
      method: "GET",
      url: `/explorer/api/heatmap?window=${MAX_HEATMAP_WINDOW_SECONDS * 99}`,
      headers: {},
      on() {
        return this;
      },
    } as unknown as IncomingMessage;
    await handleExplorerRoute(req, res, "/explorer/api/heatmap");
    const body = JSON.parse(captured.body ?? "{}");
    expect(body.window_seconds).toBe(MAX_HEATMAP_WINDOW_SECONDS);
  });
});

// Touch mkdir to silence lint about unused import in some configurations.
void mkdir;
