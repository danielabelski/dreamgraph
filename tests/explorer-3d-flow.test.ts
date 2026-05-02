/**
 * Slice C tests — splines, tubes, particles.
 *
 * plans/EXPLORER_3D_MODE.md §10.1.
 *
 * Three.js classes themselves run fine in Node; we only avoid creating a
 * `WebGLRenderer` (no GL context here).
 */

import { describe, expect, it } from "vitest";
import { SplineSet } from "../explorer/src/three/splines";
import { TubeSystem } from "../explorer/src/three/TubeSystem";
import type { ExplorerEdge, ExplorerNode } from "../explorer/src/types";

function smallGraph(): { nodes: ExplorerNode[]; edges: ExplorerEdge[] } {
  const nodes: ExplorerNode[] = [
    { id: "a", type: "feature", label: "A", degree: 3, health: 1, confidence: 0.9 },
    { id: "b", type: "workflow", label: "B", degree: 2, health: 1, confidence: 0.7 },
    { id: "c", type: "data_model", label: "C", degree: 1, health: 1, confidence: 0.5 },
  ];
  const edges: ExplorerEdge[] = [
    { s: "a", t: "b", kind: "validated", conf: 1.0 },
    { s: "b", t: "c", kind: "tension", conf: 0.6 },
    { s: "a", t: "c", kind: "dream", conf: 0.4 },
  ];
  return { nodes, edges };
}

describe("SplineSet", () => {
  it("creates one curve per visible edge and skips orphans", () => {
    const { nodes, edges } = smallGraph();
    const orphans: ExplorerEdge[] = [
      ...edges,
      { s: "ghost", t: "a", kind: "fact", conf: 1 },
    ];
    const splines = new SplineSet(nodes, orphans);
    expect(splines.curves).toHaveLength(edges.length);
    expect(splines.metas).toHaveLength(edges.length);
  });

  it("applyLayout positions the endpoints of each curve at s/t", () => {
    const { nodes, edges } = smallGraph();
    const splines = new SplineSet(nodes, edges);
    splines.applyLayout([
      { id: "a", x: 0, y: 0, z: 0 },
      { id: "b", x: 5, y: 0, z: 0 },
      { id: "c", x: 0, y: 5, z: 0 },
    ]);
    const ab = splines.curves[0];
    const start = ab.getPointAt(0);
    const end = ab.getPointAt(1);
    // Tolerance because Catmull-Rom interpolation can drift the sampled
    // start/end if the control point is far off-axis. Our 1.4-unit cap
    // keeps the drift well under this tolerance for short edges.
    expect(Math.hypot(start.x - 0, start.y - 0, start.z - 0)).toBeLessThan(0.001);
    expect(Math.hypot(end.x - 5, end.y - 0, end.z - 0)).toBeLessThan(0.001);
  });

  it("produces deterministic mid offsets for the same edge id", () => {
    const { nodes, edges } = smallGraph();
    const positions = [
      { id: "a", x: 0, y: 0, z: 0 },
      { id: "b", x: 5, y: 0, z: 0 },
      { id: "c", x: 0, y: 5, z: 0 },
    ];
    const s1 = new SplineSet(nodes, edges);
    const s2 = new SplineSet(nodes, edges);
    s1.applyLayout(positions);
    s2.applyLayout(positions);
    for (let i = 0; i < s1.curves.length; i++) {
      const m1 = s1.curves[i].points[1];
      const m2 = s2.curves[i].points[1];
      expect(m1.x).toBeCloseTo(m2.x, 9);
      expect(m1.y).toBeCloseTo(m2.y, 9);
      expect(m1.z).toBeCloseTo(m2.z, 9);
    }
  });
});

describe("TubeSystem", () => {
  it("rebuild merges per-edge tubes into a single geometry", () => {
    const { nodes, edges } = smallGraph();
    const splines = new SplineSet(nodes, edges);
    splines.applyLayout([
      { id: "a", x: 0, y: 0, z: 0 },
      { id: "b", x: 5, y: 0, z: 0 },
      { id: "c", x: 0, y: 5, z: 0 },
    ]);
    const tubes = new TubeSystem(splines);
    try {
      tubes.rebuild();
      const pos = tubes.mesh.geometry.getAttribute("position");
      const col = tubes.mesh.geometry.getAttribute("color");
      expect(pos.count).toBeGreaterThan(0);
      // Same vertex count for color and position — the merge preserved both.
      expect(col.count).toBe(pos.count);
    } finally {
      tubes.dispose();
    }
  });

  it("rebuild on an empty graph produces an empty geometry without throwing", () => {
    const splines = new SplineSet([], []);
    const tubes = new TubeSystem(splines);
    try {
      tubes.rebuild();
      const pos = tubes.mesh.geometry.getAttribute("position");
      expect(pos === undefined || pos.count === 0).toBe(true);
    } finally {
      tubes.dispose();
    }
  });

  it("getEdgeRanges returns one tightly-packed range per visible edge", () => {
    const { nodes, edges } = smallGraph();
    const splines = new SplineSet(nodes, edges);
    splines.applyLayout([
      { id: "a", x: 0, y: 0, z: 0 },
      { id: "b", x: 5, y: 0, z: 0 },
      { id: "c", x: 0, y: 5, z: 0 },
    ]);
    const tubes = new TubeSystem(splines);
    try {
      tubes.rebuild();
      const ranges = tubes.getEdgeRanges();
      expect(ranges.length).toBe(edges.length);
      // Ranges must tile the merged color attribute: range[i].start ===
      // sum of previous counts. Otherwise heatmap recoloring writes into
      // the wrong edge.
      let cursor = 0;
      for (const r of ranges) {
        expect(r.start).toBe(cursor);
        expect(r.count).toBeGreaterThan(0);
        cursor += r.count;
      }
      const col = tubes.mesh.geometry.getAttribute("color");
      expect(col.count).toBe(cursor);
    } finally {
      tubes.dispose();
    }
  });

  it("applyHeatmap recolors hot edges and restores them when cleared", () => {
    const { nodes, edges } = smallGraph();
    const splines = new SplineSet(nodes, edges);
    splines.applyLayout([
      { id: "a", x: 0, y: 0, z: 0 },
      { id: "b", x: 5, y: 0, z: 0 },
      { id: "c", x: 0, y: 5, z: 0 },
    ]);
    const tubes = new TubeSystem(splines);
    try {
      tubes.rebuild();
      const colorAttr = tubes.mesh.geometry.getAttribute("color");
      const arr = colorAttr.array as Float32Array;
      // Snapshot the very first vertex of edge[0] so we can compare.
      const r0 = arr[0];
      const g0 = arr[1];
      const b0 = arr[2];

      // 'a' is endpoint of edges 0 ("a→b") and 2 ("a→c"); a heat value of
      // max_count on 'a' should brighten both edges and shift them warm.
      const heat = new Map<string, number>([["a", 5]]);
      tubes.applyHeatmap(heat, 5);
      // Brighter than the cool base on at least one channel (warm tint).
      expect(arr[0] + arr[1]).toBeGreaterThan(r0 + g0);
      expect((colorAttr as { version: number }).version).toBeGreaterThan(0);

      // Clearing restores the base palette exactly.
      tubes.applyHeatmap(null, 0);
      expect(arr[0]).toBeCloseTo(r0, 6);
      expect(arr[1]).toBeCloseTo(g0, 6);
      expect(arr[2]).toBeCloseTo(b0, 6);
    } finally {
      tubes.dispose();
    }
  });

  it("applyHeatmap leaves cold edges at their base color", () => {
    const { nodes, edges } = smallGraph();
    const splines = new SplineSet(nodes, edges);
    splines.applyLayout([
      { id: "a", x: 0, y: 0, z: 0 },
      { id: "b", x: 5, y: 0, z: 0 },
      { id: "c", x: 0, y: 5, z: 0 },
    ]);
    const tubes = new TubeSystem(splines);
    try {
      tubes.rebuild();
      const ranges = tubes.getEdgeRanges();
      const colorAttr = tubes.mesh.geometry.getAttribute("color");
      const arr = colorAttr.array as Float32Array;
      // Edge 1 is "b→c". Heat only on "a" — edge 1 should be untouched.
      const e1 = ranges[1];
      const before = [arr[e1.start * 3], arr[e1.start * 3 + 1], arr[e1.start * 3 + 2]];
      tubes.applyHeatmap(new Map([["a", 4]]), 4);
      expect(arr[e1.start * 3]).toBeCloseTo(before[0], 6);
      expect(arr[e1.start * 3 + 1]).toBeCloseTo(before[1], 6);
      expect(arr[e1.start * 3 + 2]).toBeCloseTo(before[2], 6);
    } finally {
      tubes.dispose();
    }
  });
});

describe("pushParticlesForEdge", () => {
  it.skip("ParticleSystem removed in Slice F1 — flow now lives on the tube shader", () => {
    // Intentionally skipped: kept as a tombstone so future readers see
    // why these tests vanished. See explorer/src/three/TubeSystem.ts.
  });
});

describe("ParticleSystem", () => {
  it.skip("ParticleSystem removed in Slice F1", () => {});
});

// (legacy local Particle type removed alongside ParticleSystem)
type Particle = never;
function _unused(_p: Particle): void {}
