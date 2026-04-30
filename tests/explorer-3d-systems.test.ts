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
      // Slice D split nodes across one InstancedMesh per type, so the
      // total count lives in `metas.length` instead of `mesh.count`.
      expect(sys.metas).toHaveLength(nodes.length);
      for (const m of sys.metas) {
        const node = nodes.find((n) => n.id === m.id)!;
        expect(m.radius).toBeCloseTo(nodeRadius(node), 6);
        expect(m.type).toBe(node.type);
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
