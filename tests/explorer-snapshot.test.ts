/**
 * Explorer snapshot — Phase 0 envelope + builder shape tests.
 *
 * Drives `buildSnapshotForTest` with synthetic graph data so we don't
 * touch the real instance scope. Verifies the wire envelope contract
 * documented in plans/DREAMGRAPH_EXPLORER.md §4.1.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  buildSnapshotForTest,
  SNAPSHOT_VERSION,
} from "../src/graph/snapshot.js";
import type { GraphRawSnapshot } from "../src/graph/store.js";
import {
  getMetricsView,
  resetMetricsForTest,
  recordClientMetrics,
} from "../src/graph/metrics.js";

function emptyRaw(): GraphRawSnapshot {
  return {
    features: [],
    workflows: [],
    dataModel: [],
    capabilities: [],
    auxiliary: [],
    dreamGraph: {
      metadata: {
        description: "",
        schema_version: "",
        last_dream_cycle: null,
        total_cycles: 0,
        last_normalization: null,
        total_normalization_cycles: 0,
        created_at: "",
      },
      nodes: [],
      edges: [],
    },
    validated: {
      metadata: {
        description: "",
        schema_version: "",
        last_validation: null,
        total_validated: 0,
        created_at: "",
      },
      edges: [],
    },
    candidates: {
      metadata: {
        description: "",
        schema_version: "",
        last_normalization: null,
        total_cycles: 0,
        created_at: "",
      },
      results: [],
    },
    tensions: {
      metadata: {
        description: "",
        schema_version: "",
        total_signals: 0,
        total_resolved: 0,
        last_updated: null,
      },
      signals: [],
      resolved_tensions: [],
    },
    uiElements: [],
  } as GraphRawSnapshot;
}

describe("Explorer snapshot envelope", () => {
  beforeEach(() => resetMetricsForTest());

  it("returns the documented envelope on an empty graph", () => {
    const snap = buildSnapshotForTest(emptyRaw());
    expect(snap.version).toBe(SNAPSHOT_VERSION);
    expect(snap.version).toBe(1);
    expect(snap.etag.startsWith("sha256:")).toBe(true);
    expect(typeof snap.generated_at).toBe("string");
    expect(typeof snap.instance_uuid).toBe("string");
    expect(snap.stats.node_count).toBe(0);
    expect(snap.stats.edge_count).toBe(0);
    expect(snap.stats.bytes_uncompressed).toBeGreaterThan(0);
    expect(snap.nodes).toEqual([]);
    expect(snap.edges).toEqual([]);
  });

  it("ingests features, workflows, and `links` as fact edges", () => {
    const raw = emptyRaw();
    raw.features = [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: "F1", name: "Login", links: [{ target: "W1" }] } as any,
    ];
    raw.workflows = [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: "W1", name: "Auth flow" } as any,
    ];

    const snap = buildSnapshotForTest(raw);
    expect(snap.nodes.map((n) => n.id).sort()).toEqual(["F1", "W1"]);
    expect(snap.edges).toHaveLength(1);
    expect(snap.edges[0]).toMatchObject({ s: "F1", t: "W1", kind: "fact" });

    const f1 = snap.nodes.find((n) => n.id === "F1")!;
    expect(f1.type).toBe("feature");
    expect(f1.degree).toBe(1);
    expect(f1.health).toBeCloseTo(1);
    expect(f1.confidence).toBe(1);
  });

  it("surfaces auxiliary entities and their semantic links", () => {
    const raw = emptyRaw();
    raw.features = [{ id: "F1", name: "Login" } as any];
    raw.auxiliary = [{
      id: "T1",
      name: "Login contract test",
      kind: "test_suite",
      links: [{ target: "F1", relationship: "verifies", strength: "strong" }],
    } as any];

    const snap = buildSnapshotForTest(raw);
    expect(snap.nodes.find((node) => node.id === "T1")).toMatchObject({ type: "capability", degree: 1 });
    expect(snap.edges).toContainEqual({ s: "T1", t: "F1", kind: "fact", conf: 1 });
  });

  it("registers tensions as nodes and lowers health on linked entities", () => {
    const raw = emptyRaw();
    raw.features = [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: "F1", name: "Login" } as any,
    ];
    raw.tensions.signals = [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {
        id: "T1",
        description: "conflicting login behavior",
        entities: ["F1"],
        urgency: 0.7,
      } as any,
    ];

    const snap = buildSnapshotForTest(raw);
    const f1 = snap.nodes.find((n) => n.id === "F1")!;
    expect(f1.health).toBeLessThan(1);
    const t1 = snap.nodes.find((n) => n.id === "T1")!;
    expect(t1.type).toBe("tension");
    expect(snap.edges).toContainEqual(
      expect.objectContaining({ s: "T1", t: "F1", kind: "tension" }),
    );
  });

  it("classifies dream and validated edges distinctly", () => {
    const raw = emptyRaw();
    raw.features = [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: "F1", name: "A" } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: "F2", name: "B" } as any,
    ];
    raw.dreamGraph.edges = [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { from: "F1", to: "F2", confidence: 0.4 } as any,
    ];
    raw.validated.edges = [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { from: "F2", to: "F1", confidence: 0.9 } as any,
    ];

    const snap = buildSnapshotForTest(raw);
    const kinds = snap.edges.map((e) => e.kind).sort();
    expect(kinds).toEqual(["dream", "validated"]);
  });

  it("produces a stable etag for identical inputs", () => {
    const a = buildSnapshotForTest(emptyRaw());
    const b = buildSnapshotForTest(emptyRaw());
    expect(a.etag).toBe(b.etag);
  });

  it("includes ui_element nodes and wires used_by/children/flows as fact edges", () => {
    const raw = emptyRaw();
    raw.features = [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: "F1", name: "Dashboard" } as any,
    ];
    raw.workflows = [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: "W1", name: "Login" } as any,
    ];
    raw.uiElements = [
      {
        id: "ui_button_primary",
        name: "Primary Button",
        source_repo: "myproj",
        used_by: ["F1"],
        children: [],
        flows: [],
        links: [{ target: "W1", type: "workflow", relationship: "participates_in", description: "UI participates in login", strength: "weak" }],
      },
      // Unknown-endpoint edges must be silently skipped by pushEdge.
      {
        id: "ui_orphan",
        name: "Orphan",
        source_repo: "myproj",
        used_by: ["ghost"],
        children: [],
        flows: [],
      },
    ];

    const snap = buildSnapshotForTest(raw);
    const ids = snap.nodes.map((n) => n.id).sort();
    expect(ids).toContain("ui_button_primary");
    expect(ids).toContain("ui_orphan");
    const ui = snap.nodes.find((n) => n.id === "ui_button_primary")!;
    expect(ui.type).toBe("ui_element");
    const factEdges = snap.edges.filter((e) => e.s === "ui_button_primary");
    const targets = factEdges.map((e) => e.t).sort();
    expect(targets).toEqual(["F1", "W1"]);
    expect(factEdges.every((e) => e.kind === "fact")).toBe(true);
    // Orphan UI edges to non-existent endpoints are dropped, not ghost-synthesized.
    expect(snap.edges.find((e) => e.s === "ui_orphan")).toBeUndefined();
  });
});

describe("Explorer metrics", () => {
  beforeEach(() => resetMetricsForTest());

  it("records snapshot.* series after a build", () => {
    buildSnapshotForTest(emptyRaw());
    const view = getMetricsView();
    expect(view.metrics["snapshot.build_ms"].count).toBe(1);
    expect(view.metrics["snapshot.bytes"].last).toBeGreaterThan(0);
    expect(view.metrics["snapshot.node_count"].last).toBe(0);
  });

  it("accepts client metric batches under client.* prefix", () => {
    const result = recordClientMetrics({
      "render.fps_estimate": 58,
      "render.node_count": 42,
      ignored_string: "nope",
    });
    expect(result.accepted).toBe(2);
    const view = getMetricsView();
    expect(view.metrics["client.render.fps_estimate"].last).toBe(58);
    expect(view.metrics["client.render.node_count"].last).toBe(42);
  });
});
