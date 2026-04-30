/**
 * Slice E4 tests \u2014 radial / hierarchical 3D layout.
 *
 * plans/EXPLORER_3D_MODE.md \u00a712.E. Pure module \u2014 no three / no DOM.
 */

import { describe, expect, it } from "vitest";
import {
  radialLayout,
  runLayout,
  type LayoutEdgeInput,
  type LayoutNodeInput,
} from "../explorer/src/three/layoutEngine";

const SHELL = 14;

function star(spokes: number): {
  nodes: LayoutNodeInput[];
  edges: LayoutEdgeInput[];
} {
  const nodes: LayoutNodeInput[] = [{ id: "root" }];
  const edges: LayoutEdgeInput[] = [];
  for (let i = 0; i < spokes; i++) {
    nodes.push({ id: `n${i}` });
    edges.push({ s: "root", t: `n${i}` });
  }
  return { nodes, edges };
}

describe("radialLayout", () => {
  it("returns empty for empty input", () => {
    expect(radialLayout([], [])).toEqual([]);
  });

  it("places the highest-degree node at the origin", () => {
    const { nodes, edges } = star(8);
    const out = radialLayout(nodes, edges, { radialShellSpacing: SHELL });
    const root = out.find((p) => p.id === "root")!;
    expect(root.x).toBe(0);
    expect(root.y).toBe(0);
    expect(root.z).toBe(0);
  });

  it("places shell-1 nodes on a sphere of radius shellSpacing", () => {
    const { nodes, edges } = star(12);
    const out = radialLayout(nodes, edges, { radialShellSpacing: SHELL });
    const spokes = out.filter((p) => p.id !== "root");
    for (const p of spokes) {
      const r = Math.hypot(p.x, p.y, p.z);
      // Allow a tiny numeric tolerance.
      expect(Math.abs(r - SHELL)).toBeLessThan(1e-6);
    }
  });

  it("respects an explicit radialRoot override", () => {
    const { nodes, edges } = star(4);
    const out = radialLayout(nodes, edges, {
      radialShellSpacing: SHELL,
      radialRoot: "n0",
    });
    const r = out.find((p) => p.id === "n0")!;
    expect(Math.hypot(r.x, r.y, r.z)).toBe(0);
  });

  it("falls back gracefully when radialRoot is unknown", () => {
    const { nodes, edges } = star(4);
    const out = radialLayout(nodes, edges, {
      radialShellSpacing: SHELL,
      radialRoot: "ghost",
    });
    // Highest-degree node ("root", deg=4) wins.
    const r = out.find((p) => p.id === "root")!;
    expect(Math.hypot(r.x, r.y, r.z)).toBe(0);
  });

  it("places BFS depth-2 nodes on a sphere of radius 2*shellSpacing", () => {
    // root - a - b chain plus a sibling at depth 1.
    const nodes: LayoutNodeInput[] = [
      { id: "root" },
      { id: "a" },
      { id: "b" },
      { id: "sib" },
    ];
    const edges: LayoutEdgeInput[] = [
      { s: "root", t: "a" },
      { s: "a", t: "b" },
      { s: "root", t: "sib" },
    ];
    const out = radialLayout(nodes, edges, {
      radialShellSpacing: SHELL,
      radialRoot: "root",
    });
    const b = out.find((p) => p.id === "b")!;
    expect(Math.abs(Math.hypot(b.x, b.y, b.z) - 2 * SHELL)).toBeLessThan(1e-6);
    const a = out.find((p) => p.id === "a")!;
    expect(Math.abs(Math.hypot(a.x, a.y, a.z) - SHELL)).toBeLessThan(1e-6);
  });

  it("offsets disconnected components along +x to avoid overlap", () => {
    const nodes: LayoutNodeInput[] = [
      { id: "a" },
      { id: "b" },
      { id: "x" },
      { id: "y" },
    ];
    const edges: LayoutEdgeInput[] = [
      { s: "a", t: "b" },
      { s: "x", t: "y" },
    ];
    const out = radialLayout(nodes, edges, { radialShellSpacing: SHELL });
    // Each component has its own root at the origin of its slot \u2014
    // the second component is offset, so at least one node must have x>0.
    expect(out.some((p) => p.x > SHELL)).toBe(true);
  });

  it("preserves input order in the returned array", () => {
    const { nodes, edges } = star(3);
    const out = radialLayout(nodes, edges, { radialShellSpacing: SHELL });
    expect(out.map((p) => p.id)).toEqual(nodes.map((n) => n.id));
  });

  it("is deterministic across runs (id-sorted slot assignment)", () => {
    const { nodes, edges } = star(6);
    const a = radialLayout(nodes, edges, { radialShellSpacing: SHELL });
    const b = radialLayout(nodes, edges, { radialShellSpacing: SHELL });
    expect(a).toEqual(b);
  });

  it("runLayout(mode=radial) routes through radialLayout", () => {
    const { nodes, edges } = star(4);
    const out = runLayout(nodes, edges, {
      mode: "radial",
      radialShellSpacing: SHELL,
    });
    const root = out.find((p) => p.id === "root")!;
    expect(Math.hypot(root.x, root.y, root.z)).toBe(0);
  });

  it("runLayout(mode=force) does NOT match the radial output", () => {
    const { nodes, edges } = star(4);
    const r = runLayout(nodes, edges, { mode: "radial" });
    const f = runLayout(nodes, edges, { mode: "force" });
    // At minimum, the root sits at exactly the origin under radial,
    // but force layout will drift it off-origin.
    const fr = f.find((p) => p.id === "root")!;
    expect(Math.hypot(fr.x, fr.y, fr.z)).toBeGreaterThan(0);
    const rr = r.find((p) => p.id === "root")!;
    expect(Math.hypot(rr.x, rr.y, rr.z)).toBe(0);
  });
});
