/**
 * Tests for the Slice B 3D layout engine + node/edge systems.
 *
 * plans/EXPLORER_3D_MODE.md §10.1 — assert determinism, isolation
 * (orphan edges silently dropped), and that the renderer-side systems
 * track the layout output without leaking allocations.
 *
 * Three.js itself runs fine in pure Node — we only avoid renderer
 * construction (no WebGL context).
 */

import { describe, expect, it } from "vitest";
import { runLayout } from "../explorer/src/three/layoutEngine";
import { NodeSystem, nodeRadius } from "../explorer/src/three/NodeSystem";
import { EdgeSystem } from "../explorer/src/three/EdgeSystem";
import type { ExplorerEdge, ExplorerNode } from "../explorer/src/types";

function smallGraph(): { nodes: ExplorerNode[]; edges: ExplorerEdge[] } {
  const nodes: ExplorerNode[] = [
    { id: "a", type: "feature", label: "A", degree: 3, health: 1, confidence: 0.9 },
    { id: "b", type: "workflow", label: "B", degree: 2, health: 0.8, confidence: 0.7 },
    { id: "c", type: "data_model", label: "C", degree: 1, health: 1, confidence: 0.5 },
    { id: "d", type: "dream_node", label: "D", degree: 1, health: 1, confidence: 0.4 },
  ];
  const edges: ExplorerEdge[] = [
    { s: "a", t: "b", kind: "validated", conf: 0.9 },
    { s: "b", t: "c", kind: "fact", conf: 0.8 },
    { s: "a", t: "d", kind: "dream", conf: 0.4 },
  ];
  return { nodes, edges };
}

describe("layoutEngine.runLayout", () => {
  it("returns one position per input node", () => {
    const { nodes, edges } = smallGraph();
    const out = runLayout(
      nodes.map((n) => ({ id: n.id })),
      edges.map((e) => ({ s: e.s, t: e.t, conf: e.conf })),
      { ticks: 50 },
    );
    expect(out).toHaveLength(nodes.length);
    expect(new Set(out.map((p) => p.id))).toEqual(new Set(nodes.map((n) => n.id)));
    for (const p of out) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(Number.isFinite(p.z)).toBe(true);
    }
  });

  it("is deterministic for identical input", () => {
    const { nodes, edges } = smallGraph();
    const a = runLayout(
      nodes.map((n) => ({ id: n.id })),
      edges.map((e) => ({ s: e.s, t: e.t, conf: e.conf })),
      { ticks: 80 },
    );
    const b = runLayout(
      nodes.map((n) => ({ id: n.id })),
      edges.map((e) => ({ s: e.s, t: e.t, conf: e.conf })),
      { ticks: 80 },
    );
    for (let i = 0; i < a.length; i++) {
      expect(a[i].id).toBe(b[i].id);
      expect(a[i].x).toBeCloseTo(b[i].x, 6);
      expect(a[i].y).toBeCloseTo(b[i].y, 6);
      expect(a[i].z).toBeCloseTo(b[i].z, 6);
    }
  });

  it("ignores edges that reference unknown nodes", () => {
    const out = runLayout(
      [{ id: "a" }, { id: "b" }],
      [
        { s: "a", t: "b", conf: 0.5 },
        { s: "a", t: "ghost", conf: 0.5 },
        { s: "missing", t: "b", conf: 0.5 },
      ],
      { ticks: 10 },
    );
    expect(out).toHaveLength(2);
  });

  it("respects pre-existing positions when provided", () => {
    const out = runLayout(
      [{ id: "a", x: 0, y: 0, z: 0 }],
      [],
      { ticks: 0 },
    );
    expect(out[0].x).toBe(0);
    expect(out[0].y).toBe(0);
    expect(out[0].z).toBe(0);
  });
});

describe("NodeSystem", () => {
  it("creates one instance per node with degree-scaled radii", () => {
    const { nodes } = smallGraph();
    const sys = new NodeSystem(nodes);
    try {
      expect(sys.mesh.count).toBe(nodes.length);
      expect(sys.metas).toHaveLength(nodes.length);
      for (const m of sys.metas) {
        const node = nodes.find((n) => n.id === m.id)!;
        expect(m.radius).toBeCloseTo(nodeRadius(node), 6);
      }
    } finally {
      sys.dispose();
    }
  });

  it("applyLayout updates per-instance metas", () => {
    const { nodes } = smallGraph();
    const sys = new NodeSystem(nodes);
    try {
      sys.applyLayout([
        { id: "a", x: 1, y: 2, z: 3 },
        { id: "b", x: -4, y: 5, z: -6 },
      ]);
      const ma = sys.metas.find((m) => m.id === "a")!;
      const mb = sys.metas.find((m) => m.id === "b")!;
      const mc = sys.metas.find((m) => m.id === "c")!;
      expect([ma.x, ma.y, ma.z]).toEqual([1, 2, 3]);
      expect([mb.x, mb.y, mb.z]).toEqual([-4, 5, -6]);
      // Untouched nodes remain at the origin.
      expect([mc.x, mc.y, mc.z]).toEqual([0, 0, 0]);
    } finally {
      sys.dispose();
    }
  });
});

describe("EdgeSystem", () => {
  it("emits two vertices per edge and skips orphans", () => {
    const { nodes, edges } = smallGraph();
    const orphans: ExplorerEdge[] = [
      ...edges,
      { s: "ghost", t: "a", kind: "validated", conf: 1 },
      { s: "a", t: "missing", kind: "dream", conf: 0.3 },
    ];
    const sys = new EdgeSystem(nodes, orphans);
    try {
      // Only the three real edges should land in metas.
      expect(sys.metas).toHaveLength(edges.length);
      const positionAttr = sys.object.geometry.getAttribute("position");
      expect(positionAttr.count).toBe(edges.length * 2);
    } finally {
      sys.dispose();
    }
  });

  it("applyLayout writes both endpoints into the position buffer", () => {
    const { nodes, edges } = smallGraph();
    const sys = new EdgeSystem(nodes, edges);
    try {
      sys.applyLayout([
        { id: "a", x: 1, y: 0, z: 0 },
        { id: "b", x: 0, y: 2, z: 0 },
        { id: "c", x: 0, y: 0, z: 3 },
        { id: "d", x: -1, y: -1, z: -1 },
      ]);
      const pos = sys.object.geometry.getAttribute("position") as {
        array: Float32Array;
        version: number;
      };
      // Edge 0 is a→b, so vertex 0 = (1,0,0), vertex 1 = (0,2,0).
      expect(Array.from(pos.array.slice(0, 6))).toEqual([1, 0, 0, 0, 2, 0]);
      // Edge 2 is a→d → vertices 4,5 → (1,0,0), (-1,-1,-1).
      expect(Array.from(pos.array.slice(12, 18))).toEqual([1, 0, 0, -1, -1, -1]);
      // BufferAttribute.needsUpdate is a setter that bumps `version`.
      expect(pos.version).toBeGreaterThan(0);
    } finally {
      sys.dispose();
    }
  });
});
